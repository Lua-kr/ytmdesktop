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

  private stopPauseProgressRefresh(): void {
    clearTimeout(this.pauseProgressRefreshTimeout);
    this.pauseProgressRefreshTimeout = undefined;
  }

  private schedulePauseProgressRefresh(): void {
    this.stopPauseProgressRefresh();
    if (
      !this.ready ||
      this.pauseExpired ||
      this.videoState !== VideoState.Paused ||
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
        this.videoState === VideoState.Paused &&
        this.shouldFreezePlaybackOnPause()
      ) {
        this.updateActivity();
      }
    }, 5_000);
  }

  private schedulePauseClear(): void {
    clearTimeout(this.pauseTimeout);
    this.pauseTimeout = undefined;
    if (!this.ready || this.videoState !== VideoState.Paused || this.pauseStartedAt === null) return;

    const remaining = this.pauseStartedAt + this.getPauseTimeoutMs() - Date.now();
    if (remaining <= 0) {
      if (!this.pauseExpired) {
        this.pauseExpired = true;
        this.stopPauseProgressRefresh();
        clearTimeout(this.activityDebounceTimeout);
        this.activityDebounceTimeout = undefined;
        this.discordClient?.clearActivity();
      }
      return;
    }

    if (this.pauseExpired) {
      // A longer timeout may restore an activity that has already expired.
      this.pauseExpired = false;
      this.updateActivity();
    }

    this.pauseTimeout = setTimeout(() => {
      this.pauseTimeout = undefined;
      this.schedulePauseClear();
    }, remaining);
  }

  private updateActivity() {
    if (this.activityDebounceTimeout) return;
    this.activityDebounceTimeout = setTimeout(() => {
      this.activityDebounceTimeout = undefined;
      if (!this.ready || !this.videoDetails) return;
      if (this.videoState === VideoState.Paused) {
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
        this.videoState === VideoState.Paused &&
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
          start: this.videoState === VideoState.Playing ? now - this.progress * 1000 : frozenTimeline ? now - pausedPosition * 1000 : undefined,
          end: this.videoState === VideoState.Playing ? now + (durationSeconds - this.progress) * 1000 : frozenTimeline ? now + (durationSeconds - pausedPosition) * 1000 : undefined
        },
        assets: {
          large_image: (thumbnail?.length ?? 0) <= 256 ? thumbnail : "ytmd-logo",
          large_text: album ? stringLimit(album, 128, 2) : undefined,
          large_url: albumId ? `https://music.youtube.com/browse/${albumId}` : undefined,
          small_image: getSmallImageKey(this.videoState),
          small_text: getSmallImageText(this.videoState)
        },
        instance: false
      });
      this.schedulePauseProgressRefresh();
    }, 1000);
  }

  private playerStateChanged(state: PlayerState) {
    if (!this.ready) return;

    const { videoDetails, videoProgress, trackState, hasFullMetadata } = state;
    if (!videoDetails) {
      clearTimeout(this.activityDebounceTimeout);
      clearTimeout(this.pauseTimeout);
      this.stopPauseProgressRefresh();
      this.activityDebounceTimeout = this.pauseTimeout = undefined;
      this.pauseStartedAt = null;
      this.pauseExpired = false;
      this.pausedPlaybackPosition = null;
      this.videoDetails = null;
      this.videoState = trackState;
      this.discordClient?.clearActivity();
      return;
    }
    const oldState = this.videoState;
    const oldId = this.videoDetails?.id ?? null;
    const oldProgress = this.progress;
    this.videoState = trackState;
    this.videoDetails = videoDetails;
    this.progress = Math.floor(videoProgress);

    let pausedPositionChanged = false;
    if (trackState === VideoState.Paused) {
      if (oldState !== VideoState.Paused || this.pauseStartedAt === null || oldId !== this.videoDetails.id) {
        this.pauseStartedAt = Date.now();
        this.pauseExpired = false;
        this.pausedPlaybackPosition = this.progress;
      } else if (this.pausedPlaybackPosition !== null && Math.abs(this.progress - this.pausedPlaybackPosition) > 1) {
        // A seek while paused should change the frozen position, not restart the pause deadline.
        this.pausedPlaybackPosition = this.progress;
        pausedPositionChanged = true;
      }
      // State updates during pause must not restart the countdown.
      this.schedulePauseClear();
    } else {
      clearTimeout(this.pauseTimeout);
      this.pauseTimeout = undefined;
      this.stopPauseProgressRefresh();
      this.pauseStartedAt = null;
      this.pauseExpired = false;
      this.pausedPlaybackPosition = null;
    }

    if (
      !this.pauseExpired &&
      hasFullMetadata &&
      (oldState !== this.videoState || oldId !== this.videoDetails.id || Math.abs(this.progress - oldProgress) > 1 || oldProgress > this.progress || pausedPositionChanged)
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
      if (this.isEnabled && this.ready && this.videoState === VideoState.Paused) {
        this.schedulePauseClear();
      }
    });
    this.getService(ConfigStore).onDidChange("integrations.discordPresenceFreezePlaybackOnPause", () => {
      if (this.isEnabled && this.ready && this.videoState === VideoState.Paused && !this.pauseExpired) {
        this.stopPauseProgressRefresh();
        this.updateActivity();
      }
    });
  }

  public onEnabled(): void {
    if (this.discordClient) return;
    this.discordClient = new DiscordClient(DISCORD_CLIENT_ID);

    this.discordClient.on("connect", () => {
      this.ready = true;
      this.connectionRetries = 0;
      const memoryStore = this.getService(MemoryStore<MemoryStoreSchema>);
      memoryStore.set("discordPresenceConnectionFailed", false);
      // Reconcile a pause that started before (re)connection.
      this.playerStateChanged(this.getService(PlayerStateStore).getState());
      if (this.videoDetails && !this.pauseExpired) this.updateActivity();
    });
    this.discordClient.on("close", () => {
      log.info("Discord connection closed");
      this.ready = false;
      clearTimeout(this.pauseTimeout);
      this.pauseTimeout = undefined;
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
    this.activityDebounceTimeout = this.pauseTimeout = this.connectionRetryTimeout = undefined;
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
    this.discordClient.destroy();
    this.discordClient = null;
  }
}
