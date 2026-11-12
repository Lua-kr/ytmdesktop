<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import { MiniplayerHideTarget } from "~shared/store/schema";
import { LikeStatus, PlayerState, RepeatMode, Thumbnail, VideoState } from "~shared/playerstatestore/types";
import RangeInput from "../../components/RangeInput.vue";

const props = defineProps<{
  hiddenSections: MiniplayerHideTarget[];
  hideEntireUi: boolean;
  alwaysShowLiked: boolean;
}>();

const state = ref<PlayerState | null>(null);
state.value = await window.ytmd.playerStore.getState();

const volume = ref(state.value?.volume ?? 0);

const videoProgress = ref(0);
const videoLength = ref(0);
const videoId = ref("");

const seekbarContainer = useTemplateRef("seekbarContainer");
const infoContainer = useTemplateRef("infoContainer");
const infoTitle = useTemplateRef("infoTitle");
const controlsRow = useTemplateRef<HTMLDivElement>("controlsRow");
const playbackGroup = useTemplateRef<HTMLDivElement>("playbackGroup");
const reactionsGroup = useTemplateRef<HTMLDivElement>("reactionsGroup");
const rightGroup = useTemplateRef<HTMLDivElement>("rightGroup");
const reactionsInTopbar = ref(false);
const bottomControlsHidden = computed(() =>
  props.hiddenSections.includes("reactions") && props.hiddenSections.includes("playback")
);
let controlsResizeObserver: ResizeObserver | null = null;

// Use the actual available space, not a fixed viewport-width breakpoint.
function reconcileReactionsPlacement() {
  if (!controlsRow.value || !playbackGroup.value || !reactionsGroup.value || !rightGroup.value) return;
  // Symmetric grid sides preserve the absolute center of the transport.
  // At very narrow widths the volume section stacks to fit its own side.
  const availableSideWidth = Math.max(0, (controlsRow.value.clientWidth - playbackGroup.value.offsetWidth) / 2);
  reactionsInTopbar.value = reactionsGroup.value.offsetWidth + 6 > availableSideWidth;
}


function getHighestResThumbnail(thumbnails: Thumbnail[]): string {
  return thumbnails.reduce(
    (accumulator, current) => (current.height * current.width <= accumulator.height * accumulator.width ? accumulator : current),
    thumbnails[0]
  ).url;
}

let seekbarDragging = false;

async function stateChanged(newState) {
  state.value = newState;

  if (newState.videoDetails && newState.videoDetails.id != videoId.value) {
    const thumbnailUrl = getHighestResThumbnail(newState.videoDetails?.thumbnails);
    if (thumbnailUrl) {
      document.body.style.backgroundImage = `url("${thumbnailUrl}")`;
    } else {
      document.body.style.backgroundImage = "";
    }
    videoLength.value = newState.videoDetails.durationSeconds;
    videoId.value = newState.videoDetails.id;

    nextTick(() => {
      reconcileMarquee();
    });
  }

  if (!seekbarDragging) {
    videoProgress.value = newState.videoProgress;
  }

  volume.value = newState.volume;
  state.value = newState;
}

function reconcileMarquee() {
  if (infoTitle.value) {
    if (infoTitle.value.scrollWidth > infoContainer.value.clientWidth) {
      infoTitle.value.classList.add("marquee");
    } else {
      infoTitle.value.classList.remove("marquee");
    }
  }
}

onMounted(() => {
  window.ytmd.playerStore.handleStateChanged(newState => {
    stateChanged(newState);
  });

  window.ytmd.requestWindowState();
  stateChanged(state.value);
  nextTick(() => {
    reconcileReactionsPlacement();
    if (controlsRow.value && playbackGroup.value && reactionsGroup.value && rightGroup.value) {
      controlsResizeObserver = new ResizeObserver(reconcileReactionsPlacement);
      controlsResizeObserver.observe(controlsRow.value);
      controlsResizeObserver.observe(playbackGroup.value);
      controlsResizeObserver.observe(reactionsGroup.value);
      controlsResizeObserver.observe(rightGroup.value);
    }
  });
  window.addEventListener("resize", reconcileReactionsPlacement);
});

onUnmounted(() => {
  controlsResizeObserver?.disconnect();
  window.removeEventListener("resize", reconcileReactionsPlacement);
});

const seekHandleVisible = ref(false);

function showSeekHandle() {
  seekHandleVisible.value = true;
}

function hideSeekHandle() {
  seekHandleVisible.value = false;
}

function startDrag(event) {
  seekbarDragging = true;
  seek(event);

  document.body.style.userSelect = "none";
}

function getOffsetX(event, rect) {
  let offsetX = event.clientX - rect.left;
  offsetX = Math.max(0, Math.min(offsetX, rect.width));
  return offsetX;
}

function seek(event) {
  const seekbarRect = seekbarContainer.value.getBoundingClientRect();
  const offsetX = getOffsetX(event, seekbarRect);
  const seekToValue = (offsetX * videoLength.value) / seekbarRect.width;
  videoProgress.value = seekToValue;
  window.ytmd.executeCommandInYTMView("seekTo", seekToValue);
}

document.addEventListener("mousemove", event => {
  if (!seekbarDragging) return;
  if (event.clientX > -1) {
    seek(event);
  }
});

document.addEventListener("mouseup", () => {
  if (seekbarDragging) {
    seekbarDragging = false;

    document.body.style.userSelect = "";
  }
});

function previousVideo() {
  window.ytmd.executeCommandInYTMView("previous");
}
function playPauseVideo() {
  window.ytmd.executeCommandInYTMView("playPause");
}
function nextVideo() {
  window.ytmd.executeCommandInYTMView("next");
}
function toggleLike() {
  window.ytmd.executeCommandInYTMView("toggleLike");
}
function toggleDislike() {
  window.ytmd.executeCommandInYTMView("toggleDislike");
}
function cycleRepeat() {
  window.ytmd.executeCommandInYTMView("cycleRepeatMode");
}
function volumeChanged(newVolume: number) {
  window.ytmd.executeCommandInYTMView("setVolume", newVolume);
}
function toggleMute() {
  if (!state.value?.muted) {
    window.ytmd.executeCommandInYTMView("mute");
  } else {
    window.ytmd.executeCommandInYTMView("unmute");
  }
}

window.addEventListener("resize", reconcileMarquee);
</script>

<template>
  <div
    v-if="state?.videoDetails != null"
    class="container"
  >
    <button
      v-if="props.alwaysShowLiked && props.hiddenSections.includes('reactions') && state.videoDetails.likeStatus === LikeStatus.Like"
      type="button"
      class="pinned-liked"
      aria-label="Unlike current song"
      title="Liked song (click to remove like)"
      @click="toggleLike"
    >
      <span class="icon material-symbols-outlined">thumb_up</span>
    </button>
    <div class="pusher"></div>
    <div
      class="video-data"
      :class="{ 'controls-collapsed': bottomControlsHidden }"
    >
      <div
        class="backdrop"
        :class="{ 'ui-hidden': props.hideEntireUi }"
      />
      <div
        ref="infoContainer"
        class="video-info"
        :class="{ 'ui-hidden': props.hiddenSections.includes('title') }"
      >
        <span
          ref="infoTitle"
          class="title"
        >{{ state?.videoDetails?.title }} • {{ state?.videoDetails?.author }}</span>
      </div>
      <div
        ref="seekbarContainer"
        class="seekbar-container"
        :class="{ 'ui-hidden': props.hiddenSections.includes('seekbar') }"
        @mouseenter="showSeekHandle"
        @mouseleave="hideSeekHandle"
        @mousedown="startDrag"
      >
        <div class="seekbar">
          <div
            class="progress"
            :style="{ width: `${(videoProgress / videoLength) * 100}%` }"
          />
          <div
            v-if="seekHandleVisible"
            id="handle"
            class="handle"
            :style="{ left: `${(videoProgress / videoLength) * 100}%` }"
          />
        </div>
      </div>
      <div
        ref="controlsRow"
        class="video-controls"
        :class="{ 'controls-collapsed': bottomControlsHidden }"
      >
        <div
          ref="reactionsGroup"
          class="controls reactions"
          :class="{ 'in-topbar': reactionsInTopbar, 'ui-hidden': props.hiddenSections.includes('reactions') }"
        >
          <button
            type="button"
            class="reaction"
            :class="{ active: state?.videoDetails?.likeStatus === LikeStatus.Like }"
            :aria-pressed="state?.videoDetails?.likeStatus === LikeStatus.Like"
            aria-label="Like current song"
            title="Like"
            @click="toggleLike"
          >
            <span class="icon material-symbols-outlined">thumb_up</span>
          </button>
          <button
            type="button"
            class="reaction"
            :class="{ active: state?.videoDetails?.likeStatus === LikeStatus.Dislike }"
            :aria-pressed="state?.videoDetails?.likeStatus === LikeStatus.Dislike"
            aria-label="Dislike current song"
            title="Dislike"
            @click="toggleDislike"
          >
            <span class="icon material-symbols-outlined">thumb_down</span>
          </button>
        </div>
        <div
          ref="playbackGroup"
          class="controls playback"
          :class="{ 'ui-hidden': props.hiddenSections.includes('playback') }"
        >
          <button
            class="previous"
            @click="previousVideo"
          >
            <span class="icon material-symbols-outlined">skip_previous</span>
          </button>
          <button
            class="play-pause"
            @click="playPauseVideo"
          >
            <span
              v-if="state?.trackState == VideoState.Paused"
              class="icon material-symbols-outlined"
            >play_arrow</span>
            <span
              v-if="state?.trackState == VideoState.Playing"
              class="icon material-symbols-outlined"
            >pause</span>
            <span
              v-if="state?.trackState == VideoState.Buffering"
              class="icon material-symbols-outlined"
            >data_saver_off</span>
            <span
              v-if="state?.trackState == VideoState.Unknown"
              class="icon material-symbols-outlined"
            >play_arrow</span>
          </button>
          <button
            class="next"
            @click="nextVideo"
          >
            <span class="icon material-symbols-outlined">skip_next</span>
          </button>
        </div>
        <div
          ref="rightGroup"
          class="controls right"
          :class="{ 'ui-hidden': props.hiddenSections.includes('playback') }"
        >
          <div class="volume">
            <RangeInput
              v-model="volume"
              class="slider"
              :min="0"
              :max="100"
              @update:model-value="volumeChanged"
            />
            <button
              class="next"
              @click="toggleMute"
            >
              <span
                v-if="volume <= 50 && !state?.muted"
                class="icon material-symbols-outlined"
              >volume_down</span>
              <span
                v-if="volume > 50 && !state?.muted"
                class="icon material-symbols-outlined"
              >volume_up</span>
              <span
                v-if="state?.muted"
                class="icon material-symbols-outlined"
              >volume_off</span>
            </button>
          </div>
          <button
            class="repeat"
            @click="cycleRepeat"
          >
            <span
              v-if="state?.queue.repeatMode === RepeatMode.None || state?.queue.repeatMode === RepeatMode.Unknown"
              class="icon material-symbols-outlined"
            >repeat</span>
            <span
              v-if="state?.queue.repeatMode === RepeatMode.All"
              class="icon material-symbols-outlined"
            >repeat_on</span>
            <span
              v-if="state?.queue.repeatMode === RepeatMode.One"
              class="icon material-symbols-outlined"
            >repeat_one_on</span>
          </button>
        </div>
      </div>
    </div>
  </div>
  <div
    v-else
    class="container unavailable"
  >
    <p>Video is still loading or no video loaded</p>
  </div>
</template>

<style scoped>
.container {
  width: 100vw;
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 36px);
  max-height: calc(100vh - 36px);
}

.container.unavailable {
  justify-content: center;
  align-items: center;
}

.pusher {
  flex-grow: 1;
}

.video-data {
  display: flex;
  height: 80px;
  flex-direction: column;
  position: relative;
}

/* Remove the actual space reserved for the buttons when both lower
   sections are hidden. The title and seekbar then sit at the bottom. */
.video-data.controls-collapsed {
  height: auto;
}
.video-data.controls-collapsed .seekbar-container {
  padding-bottom: 0;
}
.video-data.controls-collapsed .seekbar-container.ui-hidden,
.video-data.controls-collapsed .video-info.ui-hidden {
  display: none;
}
.video-controls.controls-collapsed {
  display: none;
}

.video-data .backdrop {
  position: absolute;
  width: 100%;
  height: 200%;
  top: -100%;
  backdrop-filter: blur(10px);
  mask-image: linear-gradient(to top, black 0%, black 25%, transparent 100%);
  z-index: -888;
  background-color: rgba(0, 0, 0, 0.5);
  pointer-events: none;
}

.video-controls {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  padding: 0 4px;
  min-width: 0;
  margin-bottom: 8px;
  -webkit-app-region: no-drag;
}

.controls {
  display: flex;
  flex: 0 0 auto;
  justify-content: center;
  align-items: center;
}

.controls.reactions {
  grid-column: 1;
  justify-self: start;
  gap: 2px;
}

.controls.playback {
  grid-column: 2;
  justify-self: center;
}

.controls.right {
  grid-column: 3;
  justify-self: end;
}

.controls.reactions:not(.in-topbar)::after {
  content: "";
  display: block;
  height: 18px;
  width: 1px;
  margin-left: 8px;
  background: rgba(255, 255, 255, 0.25);
}

.controls.reactions .reaction {
  width: 28px;
  height: 30px;
  flex-basis: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #dddddd;
}

.controls.reactions .reaction .icon {
  font-size: 20px;
}

.controls.reactions .reaction.active {
  color: #ff5757;
  background-color: rgba(255, 87, 87, 0.15);
}

.controls.reactions .reaction:focus-visible {
  outline: 2px solid #ffffff;
  outline-offset: 1px;
}

.controls.reactions.in-topbar {
  position: fixed;
  z-index: 10;
  top: 0;
  left: 4px;
  height: 36px;
  padding-left: 0;
}

.pinned-liked {
  position: fixed;
  z-index: 12;
  top: 2px;
  left: 6px;
  width: 32px;
  height: 32px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ff5757;
  background: rgba(0, 0, 0, 0.25);
  border: none;
  border-radius: 50%;
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.pinned-liked .icon {
  font-size: 20px;
}
.pinned-liked:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 1px;
}

.ui-hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

.controls button {
  position: relative;
  box-sizing: border-box;
  flex: 0 0 30px;
  width: 30px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: transparent;
  border: none;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.volume {
  -webkit-app-region: no-drag;
  display: flex;
  justify-content: center;
  align-items: center;
}

.volume .slider {
  width: 56px;
  flex: 0 0 56px;
  margin-right: 4px;
  margin-bottom: 3px;
}

/* Keep the right-hand group inside its symmetric column without
   pushing the play/pause controls away from the window center. */
@media (min-width: 306px) and (max-width: 340px) {
  .volume .slider {
    width: 40px;
    flex-basis: 40px;
  }
}

@media (max-width: 305px) {
  .video-data:not(.controls-collapsed) {
    height: 110px;
  }
  .controls.right {
    flex-direction: column;
    align-items: flex-end;
  }
  .volume .slider {
    width: 36px;
    flex-basis: 36px;
  }
  .controls.reactions:not(.in-topbar)::after {
    display: none;
  }
}

.video-info {
  display: flex;
  flex-direction: column;
  justify-content: center;
  max-height: 38px;
  overflow: hidden;
  white-space: nowrap;
}

.video-info .title {
  display: inline-flex;
  justify-content: center;
}

.marquee {
  display: inline-flex;
  animation: marquee 16s linear infinite;
}

.seekbar-container {
  padding: 8px 0;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.seekbar {
  width: 100%;
  height: 4px;
  background-color: #323232;
  position: relative;
  user-select: none;
  pointer-events: none;
}

.seekbar .progress {
  height: 100%;
  background-color: #ff0000;
  pointer-events: none;
}

.seekbar .handle {
  width: 16px;
  height: 16px;
  background-color: #ff0000;
  border-radius: 50%;
  position: absolute;
  top: 50%;
  transform: translate(-8px, -50%);
}

@keyframes marquee {
  0% {
    transform: translateX(100%);
  }
  100% {
    transform: translateX(-100%);
  }
}
</style>
