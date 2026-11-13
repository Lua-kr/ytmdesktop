import PlayerStateStore from "../../services/playerstatestore";
import ConfigStore from "../../services/configstore";
import DiscordClient from "./minimal-discord-client";
import log from "electron-log";
import { DiscordActivityType, DiscordActivityStatusDisplayType } from "./minimal-discord-client/types";
import Integration from "../integration";
import MemoryStore from "../../services/memorystore";
import { MemoryStoreSchema } from "~shared/store/schema";
import { PlayerState, Thumbnail, VideoDetails, VideoState } from "~shared/playerstatestore/types";

const DISCORD_CLIENT_ID = "1143202598460076053";

function getHighestResThumbnail(thumbnails: Thumbnail[]): string {
  return thumbnails.reduce(
    (accumulator, current) => (current.height * current.width <= accumulator.height * accumulator.width ? accumulator : current),
    thumbnails[0]
  ).url;
}

function getSmallImageKey(state: VideoState) {
  // Developer Note:
  // You can add "-invert" to the end of the image key to invert (Black with White Border)
  switch (state) {
    case VideoState.Playing: {
      return "play-border";
    }
    default: {
      return "pause-border";
    }
  }
}

function getSmallImageText(state: VideoState) {
  switch (state) {
    case VideoState.Playing: {
      return "Playing";
    }
    default: {
      return "Paused";
    }
  }
}

function stringLimit(str: string, limit: number, minimum: number) {
  if (str.length > limit) {
    return str.substring(0, limit - 3).trim() + "...";
  }
  if (str.length < minimum) {
    return str.padEnd(minimum, "​"); // There's a zero width space here
  }
  return str;
}

export default class DiscordPresence extends Integration {
  public name = "DiscordPresence";
  public storeEnableProperty: Integration["storeEnableProperty"] = "integrations.discordPresenceEnabled";
  public override disableFlags = ["disable_discord_presence"];

  private discordClient: DiscordClient | null = null;
  private ready = false;
  private activityDebounceTimeout: NodeJS.Timeout | string | number | undefined = undefined;
  private pauseTimeout: NodeJS.Timeout | string | number | undefined = undefined;
  private pauseStartedAt: number | null = null;
  private pauseExpired = false;
  private pausedPlaybackPosition: number | null = null;
  private pauseProgressRefreshTimeout: NodeJS.Timeout | undefined = undefined;
  private pauseClearRetryTimer: NodeJS.Timeout | undefined = undefined;
  private pauseClearAcknowledged = false;
  private resumeVerificationTimeout: NodeJS.Timeout | undefined = undefined;
  private resumeVerificationTrackId: string | null = null;
  private connectionRetryTimeout: NodeJS.Timeout | string | number | undefined = undefined;
  private stateCallback: ((event: PlayerState) => void) | null = null;

  private videoState: VideoState = VideoState.Unknown;
  private videoDetails: VideoDetails | null = null;
  private progress: number = 0;

  private connectionRetries: number = 0;

  private getPauseTimeoutMs(): number {
    const seconds = this.getService(ConfigStore).get("integrations.discordPresencePauseTimeoutSeconds");
    // Guard against invalid values in an existing or manually edited config.
    return (Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 3600 ? seconds : 30) * 1000;
  }

  private shouldFreezePlaybackOnPause(): boolean {
    return this.getService(ConfigStore).get("integrations.discordPresenceFreezePlaybackOnPause") !== false;
  }

  private isPauseCountdownActive(): boolean {
    // A transient Playing event does not prove that playback actually resumed.
    // Preserve the original deadline until progress genuinely advances.
    return this.pauseStartedAt !== null;
  }

  private stopPauseProgressRefresh(): void {
    clearTimeout(this.pauseProgressRefreshTimeout);
    this.pauseProgressRefreshTimeout = undefined;
  }

  private schedulePauseProgressRefresh(): void {
    this.stopPauseProgressRefresh();
    // Never schedule another frozen-position update after the deadline,
    // even if the independent timeout callback was delayed.
    if (this.isPauseCountdownActive()) this.schedulePauseClear();
    if (
      !this.ready ||
      this.pauseExpired ||
      !this.isPauseCountdownActive() ||
      this.pausedPlaybackPosition === null ||
      !this.shouldFreezePlaybackOnPause() ||
      !this.videoDetails ||
      !Number.isFinite(this.videoDetails.durationSeconds) ||
      this.videoDetails.durationSeconds <= 0
    ) return;

    // Discord RPC has no pause flag. Re-anchor the same playback position at a modest interval.
    this.pauseProgressRefreshTimeout = setTimeout(() => {
      this.pauseProgressRefreshTimeout = undefined;
      if (
        this.ready &&
        !this.pauseExpired &&
        this.isPauseCountdownActive() &&
        this.shouldFreezePlaybackOnPause()
      ) {
        this.updateActivity();
      }
    }, 5_000);
  }

  private stopPauseClearRetry(): void {
    clearInterval(this.pauseClearRetryTimer);
    this.pauseClearRetryTimer = undefined;
  }

  private cancelResumeVerification(): void {
    clearTimeout(this.resumeVerificationTimeout);
    this.resumeVerificationTimeout = undefined;
    this.resumeVerificationTrackId = null;
  }

  private confirmPlaybackResumed(reason: "progress" | "stable-state"): void {
    const wasPaused = this.pauseStartedAt !== null;
    this.cancelResumeVerification();
    clearTimeout(this.pauseTimeout);
    this.pauseTimeout = undefined;
    this.stopPauseProgressRefresh();
    this.pauseStartedAt = null;
    this.pauseExpired = false;
    this.pauseClearAcknowledged = false;
    this.stopPauseClearRetry();
    this.pausedPlaybackPosition = null;
    if (wasPaused) log.info(`Discord presence: playback resumed (${reason}); restoring activity`);
  }

  private scheduleResumeVerification(trackId: string | null): void {
    if (this.resumeVerificationTimeout !== undefined && this.resumeVerificationTrackId === trackId) return;
    this.cancelResumeVerification();
    if (!this.isEnabled || this.pauseStartedAt === null || !trackId) return;

    // The first Playing notification can be transient. Verify the live
    // PlayerStateStore after a brief delay instead of waiting indefinitely
    // for another progress/state event to trigger an activity update.
    this.resumeVerificationTrackId = trackId;
    this.resumeVerificationTimeout = setTimeout(() => {
      this.resumeVerificationTimeout = undefined;
      this.resumeVerificationTrackId = null;
      if (!this.isEnabled || this.pauseStartedAt === null) return;

      const latest = this.getService(PlayerStateStore).getState();
      if (latest.trackState !== VideoState.Playing || latest.videoDetails?.id !== trackId) return;

      this.videoState = latest.trackState;
      this.videoDetails = latest.videoDetails;
      this.progress = Number.isFinite(latest.videoProgress) ? Math.floor(latest.videoProgress) : 0;
      this.confirmPlaybackResumed("stable-state");
      // Do not rely on another PlayerStateStore event: there may not be one
      // until the user clicks pause/play again.
      if (this.ready && latest.hasFullMetadata) this.updateActivity();
    }, 1_200);
  }

  private requestPauseClear(): void {
    if (!this.isEnabled || !this.ready || !this.pauseExpired || this.pauseClearAcknowledged) return;
    const sent = this.discordClient?.clearActivity() ?? false;
    log.info(`Discord presence: sending activity clear (transport queued: ${sent})`);

    // The transport write alone does not prove Discord has applied it.
    // Retry until a matching SET_ACTIVITY reply confirms the clear. 15s
    // leaves ample headroom under Discord's local RPC rate limit.
    if (this.pauseClearRetryTimer === undefined) {
      this.pauseClearRetryTimer = setInterval(() => {
        if (!this.isEnabled || !this.pauseExpired || this.pauseClearAcknowledged) {
          this.stopPauseClearRetry();
          return;
        }
        if (this.ready) this.requestPauseClear();
      }, 15_000);
    }
  }

  private schedulePauseClear(): void {
    if (!this.isEnabled || !this.isPauseCountdownActive()) return;

    // Absolute deadline from the first pause, independent of Discord RPC
    // connection, metadata refreshes, buffering and repeated state events.
    const remaining = this.pauseStartedAt! + this.getPauseTimeoutMs() - Date.now();
    if (remaining <= 0) {
      clearTimeout(this.pauseTimeout);
      this.pauseTimeout = undefined;
      if (!this.pauseExpired) {
        this.pauseExpired = true;
        this.stopPauseProgressRefresh();
        clearTimeout(this.activityDebounceTimeout);
        this.activityDebounceTimeout = undefined;
        log.info("Discord presence: pause timeout elapsed; requesting activity clear");
        this.pauseClearAcknowledged = false;
        this.requestPauseClear();
      }
      return;
    }

    if (this.pauseExpired) {
      // Extending the pause setting can restore previously expired activity.
      this.pauseExpired = false;
      this.pauseClearAcknowledged = false;
      this.stopPauseClearRetry();
      if (this.ready) this.updateActivity();
    }

    // Frequent state-changed events must not reschedule or extend the timer.
    if (this.pauseTimeout !== undefined) return;
    this.pauseTimeout = setTimeout(() => {
      this.pauseTimeout = undefined;
      this.schedulePauseClear();
    }, remaining);
  }

  private updateActivity() {
    // Enforce the absolute pause deadline before *any* RPC publication.
    // A late timer callback must not allow another 5s+1s refresh cycle.
    if (this.isPauseCountdownActive()) this.schedulePauseClear();
    if (!this.ready || this.pauseExpired || !this.videoDetails || this.activityDebounceTimeout) return;
    this.activityDebounceTimeout = setTimeout(() => {
      this.activityDebounceTimeout = undefined;
      if (!this.ready || this.pauseExpired || !this.videoDetails) return;
      if (this.isPauseCountdownActive()) {
        this.schedulePauseClear();
        if (this.pauseExpired) return;
      }
      const { title, author, album, id, thumbnails, durationSeconds, channelId, albumId } = this.videoDetails;
      const thumbnail = getHighestResThumbnail(thumbnails);
      const displayPreference = this.getService(ConfigStore).get("integrations.discordPresenceStatusDisplayType");
      // Preferences 3 and 4 combine metadata locally, while Discord RPC accepts only status types 0-2.
      const combinedStatus = displayPreference === 3 || displayPreference === 4;
      const statusDisplayType: DiscordActivityStatusDisplayType =
        displayPreference === DiscordActivityStatusDisplayType.Name ||
        displayPreference === DiscordActivityStatusDisplayType.Details
          ? displayPreference
          : DiscordActivityStatusDisplayType.State;
      const stateText =
        displayPreference === 3 ? `${author} - ${title}` :
        displayPreference === 4 ? `${title} - ${author}` : author;
      const now = Date.now();
      const frozenTimeline =
        this.isPauseCountdownActive() &&
        this.shouldFreezePlaybackOnPause() &&
        this.pausedPlaybackPosition !== null &&
        Number.isFinite(durationSeconds) &&
        durationSeconds > 0;
      const pausedPosition = Math.max(0, Math.min(durationSeconds, this.pausedPlaybackPosition ?? this.progress));
      this.discordClient?.setActivity({
        type: DiscordActivityType.Listening,
        status_display_type: statusDisplayType,
        details: stringLimit(title, 128, 2),
        details_url: `https://music.youtube.com/watch?v=${id}`,
        state: stringLimit(stateText, 128, 2),
        state_url: combinedStatus ? undefined : `https://music.youtube.com/channel/${channelId}`,
        timestamps: {
          start: !this.isPauseCountdownActive() && this.videoState === VideoState.Playing ? now - this.progress * 1000 : frozenTimeline ? now - pausedPosition * 1000 : undefined,
          end: !this.isPauseCountdownActive() && this.videoState === VideoState.Playing ? now + (durationSeconds - this.progress) * 1000 : frozenTimeline ? now + (durationSeconds - pausedPosition) * 1000 : undefined
        },
        assets: {
          large_image: (thumbnail?.length ?? 0) <= 256 ? thumbnail : "ytmd-logo",
          large_text: album ? stringLimit(album, 128, 2) : undefined,
          large_url: albumId ? `https://music.youtube.com/browse/${albumId}` : undefined,
          small_image: getSmallImageKey(this.isPauseCountdownActive() ? VideoState.Paused : this.videoState),
          small_text: getSmallImageText(this.isPauseCountdownActive() ? VideoState.Paused : this.videoState)
        },
        instance: false
      });
      this.schedulePauseProgressRefresh();
    }, 1000);
  }

  private playerStateChanged(state: PlayerState) {
    if (!this.isEnabled) return;

    // Observe player state even while Discord is offline or reconnecting.
    const { videoDetails, videoProgress, trackState, hasFullMetadata } = state;
    const oldState = this.videoState;
    const oldId = this.videoDetails?.id ?? null;
    const oldProgress = this.progress;
    this.videoState = trackState;
    this.videoDetails = videoDetails;
    this.progress = Number.isFinite(videoProgress) ? Math.floor(videoProgress) : 0;

    let pausedPositionChanged = false;
    let playbackActuallyResumed = false;
    if (trackState === VideoState.Playing) {
      if (this.pauseStartedAt !== null) {
        // Forward progress on consecutive Playing events confirms immediately.
        // Otherwise confirm sustained Playing after 1.2s (even if no new
        // progress event arrives, as happens on some playback resumes).
        const progressConfirmed =
          oldState === VideoState.Playing &&
          videoDetails !== null &&
          oldId === videoDetails.id &&
          this.progress > oldProgress;
        if (progressConfirmed) {
          this.confirmPlaybackResumed("progress");
          playbackActuallyResumed = true;
        } else {
          this.scheduleResumeVerification(videoDetails?.id ?? null);
          this.schedulePauseClear();
        }
      }
    } else {
      this.cancelResumeVerification();
      if (trackState === VideoState.Paused) {
        if (this.pauseStartedAt === null) {
          this.pauseStartedAt = Date.now();
          this.pauseExpired = false;
          this.pauseClearAcknowledged = false;
          this.stopPauseClearRetry();
          this.pausedPlaybackPosition = this.progress;
          log.info(`Discord presence: paused; clearing after ${this.getPauseTimeoutMs() / 1000}s`);
        } else if (
          oldId !== videoDetails?.id ||
          (this.pausedPlaybackPosition !== null && Math.abs(this.progress - this.pausedPlaybackPosition) > 1)
        ) {
          // Seeking or changing metadata updates the frozen progress only.
          this.pausedPlaybackPosition = this.progress;
          pausedPositionChanged = true;
        }
      }
      // Buffering and Unknown do not restart an established pause deadline.
      if (this.isPauseCountdownActive()) this.schedulePauseClear();
    }

    if (!videoDetails) {
      clearTimeout(this.activityDebounceTimeout);
      this.activityDebounceTimeout = undefined;
      this.stopPauseProgressRefresh();
      if (this.ready) this.discordClient?.clearActivity();
      return;
    }
    if (!this.ready || this.pauseExpired) return;

    if (
      hasFullMetadata &&
      (oldState !== this.videoState || oldId !== videoDetails.id || Math.abs(this.progress - oldProgress) > 1 || oldProgress > this.progress || pausedPositionChanged || playbackActuallyResumed)
    ) {
      this.updateActivity();
    }
  }

  private retryDiscordConnection() {
    if (!this.isEnabled) return;
    if (this.connectionRetries >= 30) {
      const memoryStore = this.getService(MemoryStore<MemoryStoreSchema>);
      memoryStore.set("discordPresenceConnectionFailed", true);
      return;
    }

    this.connectionRetries++;
    log.info(`Connecting to Discord attempt ${this.connectionRetries}/30`);

    clearTimeout(this.connectionRetryTimeout);
    this.connectionRetryTimeout = setTimeout(() => {
      if (!this.discordClient) return;
      this.discordClient.connect().catch(() => this.retryDiscordConnection());
    }, 5 * 1000);
  }

  public onSetup() {
    this.getService(ConfigStore).onDidChange("integrations.discordPresencePauseTimeoutSeconds", () => {
      if (this.isEnabled && this.isPauseCountdownActive()) {
        clearTimeout(this.pauseTimeout);
        this.pauseTimeout = undefined;
        this.schedulePauseClear();
      }
    });
    this.getService(ConfigStore).onDidChange("integrations.discordPresenceFreezePlaybackOnPause", () => {
      if (this.isEnabled && this.ready && this.isPauseCountdownActive() && !this.pauseExpired) {
        this.stopPauseProgressRefresh();
        this.updateActivity();
      }
    });
  }

  public onEnabled(): void {
    if (this.discordClient) return;
    this.discordClient = new DiscordClient(DISCORD_CLIENT_ID);

    this.discordClient.on("activity-cleared", () => {
      if (!this.pauseExpired) return;
      this.pauseClearAcknowledged = true;
      this.stopPauseClearRetry();
      log.info("Discord presence: activity clear acknowledged by Discord RPC");
    });
    this.discordClient.on("activity-clear-error", error => {
      log.warn("Discord presence: activity clear rejected by Discord RPC", error);
    });

    this.discordClient.on("connect", () => {
      this.ready = true;
      this.pauseClearAcknowledged = false;
      this.connectionRetries = 0;
      const memoryStore = this.getService(MemoryStore<MemoryStoreSchema>);
      memoryStore.set("discordPresenceConnectionFailed", false);
      // Expired pauses must stay cleared even after Discord reconnects.
      this.playerStateChanged(this.getService(PlayerStateStore).getState());
      if (this.pauseExpired) this.requestPauseClear();
      else if (this.videoDetails) this.updateActivity();
    });
    this.discordClient.on("close", () => {
      log.info("Discord connection closed");
      this.ready = false;
      this.pauseClearAcknowledged = false;
      // Do not stop the independent pause deadline during an IPC outage.
      this.stopPauseProgressRefresh();
      clearTimeout(this.activityDebounceTimeout);
      this.activityDebounceTimeout = undefined;
      this.retryDiscordConnection();
    });
    this.discordClient.connect().catch(() => this.retryDiscordConnection());
    this.stateCallback = event => {
      this.playerStateChanged(event);
    };

    const playerStateStore = this.getService(PlayerStateStore);
    playerStateStore.on("state-changed", this.stateCallback);
  }

  public onDisabled(): void {
    this.connectionRetries = 0;
    const memoryStore = this.getService(MemoryStore<MemoryStoreSchema>);
    memoryStore.set("discordPresenceConnectionFailed", false);

    clearTimeout(this.activityDebounceTimeout);
    clearTimeout(this.pauseTimeout);
    clearTimeout(this.connectionRetryTimeout);
    this.stopPauseProgressRefresh();
    this.stopPauseClearRetry();
    this.cancelResumeVerification();
    this.activityDebounceTimeout = this.pauseTimeout = this.connectionRetryTimeout = undefined;
    this.pauseClearAcknowledged = false;
    this.pauseStartedAt = null;
    this.pauseExpired = false;
    this.pausedPlaybackPosition = null;
    this.videoState = VideoState.Unknown;
    this.videoDetails = null;

    if (this.stateCallback) {
      const playerStateStore = this.getService(PlayerStateStore);
      playerStateStore.off("state-changed", this.stateCallback);
    }

    if (!this.discordClient) return;
    this.ready = false;
    const client = this.discordClient;
    this.discordClient = null;
    // Clear the activity before shutting down the socket instead of relying
    // solely on Discord noticing the process disconnect.
    client.clearActivity();
    client.close();
    const destroyTimer = setTimeout(() => client.destroy(), 250);
    destroyTimer.unref();
  }
}
