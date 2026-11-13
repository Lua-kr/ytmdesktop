<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { MiniplayerAppearance, MiniplayerHideTarget } from "~shared/store/schema";
import Miniplayer from "./Miniplayer.vue";

const isWayland = ref(window.ytmd.isWayland());
const alwaysOnTop = ref(true);
const pointerInside = ref(false);
const appearance = ref<MiniplayerAppearance>({
  miniplayerAutoHideEnabled: false,
  miniplayerHideOnLeave: ["all"],
  miniplayerTransparency: 0,
  miniplayerAlwaysShowLiked: false
});

onMounted(() => {
  // Electron's draggable body does not dispatch normal pointer events.
  // Observe main-process cursor hit testing instead, including the album art.
  window.ytmd.onMiniplayerPointerInside(inside => {
    pointerInside.value = inside;
  });
  window.ytmd.getMiniplayerPointerInside().then(inside => {
    pointerInside.value = inside;
  });
  window.ytmd.onMiniplayerAppearanceChanged(next => {
    appearance.value = next;
  });
  window.ytmd.getMiniplayerAppearance().then(next => {
    appearance.value = next;
  });
});

const autoHideActive = computed(() => appearance.value.miniplayerAutoHideEnabled && !pointerInside.value);
const hideEntireUi = computed(() =>
  autoHideActive.value &&
  appearance.value.miniplayerHideOnLeave.includes("all")
);
const hiddenSections = computed<MiniplayerHideTarget[]>(() => {
  if (pointerInside.value || !appearance.value.miniplayerAutoHideEnabled) return [];
  const selected = appearance.value.miniplayerHideOnLeave;
  return selected.includes("all")
    ? ["windowControls", "reactions", "playback", "seekbar", "title"]
    : selected;
});

window.ytmd.handleWindowEvents(windowState => {
  alwaysOnTop.value = windowState.alwaysOnTop;
});

function closeMiniplayer() {
  window.ytmd.closeWindow();
}

function closeLikeMainWindow() {
  window.ytmd.closeLikeMainWindow();
}

function pinUnpinMiniplayer() {
  window.ytmd.setAlwaysOnTopWindow(!alwaysOnTop.value);
}
</script>

<template>
  <div class="miniplayer-shell">
  <div
    class="topbar"
    :class="{ 'ui-hidden': hiddenSections.includes('windowControls') }"
  >
    <div class="backdrop" />
    <div class="button-container">
      <button
        class="pin"
        :title="!isWayland ? `Pin/Unpin Miniplayer` : `Use your native window manager to pin the miniplayer`"
        @click="pinUnpinMiniplayer"
        :disabled="isWayland"
      >
        <span
          v-if="alwaysOnTop"
          class="icon material-symbols-outlined"
        >keep</span>
        <span
          v-if="!alwaysOnTop"
          class="icon material-symbols-outlined"
        >keep_off</span>
      </button>
      <button
        class="pip-exit"
        title="Close Miniplayer"
        @click="closeMiniplayer"
      >
        <span class="icon material-symbols-outlined">pip_exit</span>
      </button>
      <button
        class="window-close"
        title="Close YTMDesktop (or hide to tray when enabled)"
        aria-label="Close YTMDesktop"
        @click="closeLikeMainWindow"
      >
        <span class="icon material-symbols-outlined">close</span>
      </button>
    </div>
  </div>
  <Suspense>
    <Miniplayer
      :hidden-sections="hiddenSections"
      :hide-entire-ui="hideEntireUi"
      :auto-hide-active="autoHideActive"
      :always-show-liked="appearance.miniplayerAlwaysShowLiked"
    />
  </Suspense>
  </div>
</template>

<style scoped>
.miniplayer-shell {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.ui-hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

.topbar {
  height: 36px;
  display: flex;
  justify-content: right;
  position: relative;
}

.topbar .backdrop {
  position: absolute;
  width: 100%;
  height: 200%;
  top: -100%;
  backdrop-filter: blur(10px);
  mask-image: linear-gradient(to bottom, black 0%, black 25%, transparent 100%);
  z-index: -888;
  background-color: rgba(0, 0, 0, 0.75);
}

.topbar button {
  background: transparent;
  border: none;
  cursor: pointer;
  width: 36px;
  height: 36px;
  -webkit-app-region: no-drag;
}

.topbar .icon {
  font-size: 20px;
}
</style>
