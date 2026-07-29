(() => {
  // src/runtime/player-controller.js
  var PLAYER_LAYOUT_SELECTOR = "#live_player_layout > pzp-pc-layout";
  var QUALITY_PANE_SELECTOR =
    "#live_player_layout pzp-pc-setting-quality-pane, #live_player_layout pzp-setting-quality";
  var QUALITY_STORAGE_KEY = "live-player-video-track";
  var MAX_TRACKS = 64;
  var RETRY_DELAYS_MS = [0, 50, 250, 1e3, 3e3];
  var MANUAL_QUALITY_LABEL_RE = /^\d{3,4}p$/i;
  var TRACK_LIST_EVENT_TYPES = ["addtrack", "removetrack", "change"];
  function isPlayerPageLocation(value) {
    let pathname;
    try {
      pathname =
        typeof value?.pathname === "string"
          ? value.pathname
          : new globalThis.URL(String(value), "https://chzzk.naver.com").pathname;
    } catch {
      return false;
    }
    return (
      pathname === "/live" ||
      pathname.startsWith("/live/") ||
      pathname === "/lives" ||
      pathname.startsWith("/lives/")
    );
  }
  function positiveDimension(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 32768 ? number : null;
  }
  function playerTracks(player) {
    try {
      const tracks = player?.videoTracks;
      return tracks ? Array.from(tracks).slice(0, MAX_TRACKS) : [];
    } catch {
      return [];
    }
  }
  function currentVideoTracks(documentRef) {
    try {
      return documentRef?.querySelector?.(PLAYER_LAYOUT_SELECTOR)?.videoTracks ?? null;
    } catch {
      return null;
    }
  }
  function trackDescriptor(track, index) {
    try {
      const label = typeof track?.label === "string" ? track.label.trim() : "";
      const width = positiveDimension(track?.width);
      const height = positiveDimension(track?.height);
      if (
        !MANUAL_QUALITY_LABEL_RE.test(label) ||
        label.toUpperCase() === "ABR" ||
        width == null ||
        height == null
      ) {
        return null;
      }
      return {
        height,
        index,
        label,
        resolution: Math.min(width, height),
        track,
        width,
      };
    } catch {
      return null;
    }
  }
  function isCurrentTrack(player, candidate) {
    try {
      if (candidate.track?.selected === true) return true;
      const selectedIndex = Number(player?.videoTracks?.selectedIndex);
      return Number.isSafeInteger(selectedIndex) && selectedIndex === candidate.index;
    } catch {
      return false;
    }
  }
  function persistSelectedTrack(storage, candidate) {
    if (!storage?.getItem || !storage?.setItem) return false;
    const serialized = JSON.stringify({
      label: candidate.label,
      width: candidate.width,
      height: candidate.height,
    });
    try {
      if (storage.getItem(QUALITY_STORAGE_KEY) !== serialized) {
        storage.setItem(QUALITY_STORAGE_KEY, serialized);
      }
      return true;
    } catch {
      return false;
    }
  }
  function selectHighestAllowedPlayerTrack({
    documentRef = globalThis.document,
    storage = globalThis.localStorage,
  } = {}) {
    let filter;
    let pane;
    let player;
    try {
      player = documentRef?.querySelector?.(PLAYER_LAYOUT_SELECTOR);
      pane = documentRef?.querySelector?.(QUALITY_PANE_SELECTOR);
      filter = pane?.filter;
    } catch {
      return { reason: "player-access-failed", selected: false };
    }
    if (!player) return { reason: "player-missing", selected: false };
    if (typeof filter !== "function") {
      return { reason: "quality-filter-missing", selected: false };
    }
    const candidates = playerTracks(player)
      .map(trackDescriptor)
      .filter(Boolean)
      .filter((candidate) => {
        try {
          return filter.call(pane, candidate.track) === true;
        } catch {
          return false;
        }
      })
      .sort(
        (left, right) =>
          right.resolution - left.resolution ||
          right.width * right.height - left.width * left.height ||
          right.index - left.index,
      );
    const highest = candidates[0];
    if (!highest) return { reason: "allowed-track-missing", selected: false };
    const changed = !isCurrentTrack(player, highest);
    if (changed) {
      try {
        highest.track.selected = true;
      } catch {
        return { reason: "selection-failed", selected: false };
      }
      if (!isCurrentTrack(player, highest)) {
        return { reason: "selection-not-applied", selected: false };
      }
    }
    persistSelectedTrack(storage, highest);
    return {
      changed,
      height: highest.height,
      label: highest.label,
      selected: true,
      width: highest.width,
    };
  }
  function eventBelongsToQualityPane(event) {
    const nodes =
      typeof event?.composedPath === "function" ? event.composedPath() : [event?.target].filter(Boolean);
    return nodes.some((node) => {
      const tagName = String(node?.tagName ?? "").toUpperCase();
      return tagName === "PZP-PC-SETTING-QUALITY-PANE" || tagName === "PZP-SETTING-QUALITY";
    });
  }
  function mutationTouchesPlayer(records) {
    return (Array.isArray(records) ? records : []).some((record) =>
      [...(record?.addedNodes ?? []), ...(record?.removedNodes ?? [])].some((node) => {
        try {
          const tagName = String(node?.tagName ?? "").toUpperCase();
          if (
            node?.id === "live_player_layout" ||
            tagName === "PZP-PC-LAYOUT" ||
            tagName === "PZP-PC-SETTING-QUALITY-PANE" ||
            tagName === "PZP-SETTING-QUALITY"
          ) {
            return true;
          }
          return Boolean(
            node?.querySelector?.(
              "#live_player_layout, pzp-pc-layout, pzp-pc-setting-quality-pane, pzp-setting-quality",
            ),
          );
        } catch {
          return false;
        }
      }),
    );
  }
  function createHighestQualityPlayerController({
    MutationObserverImpl = globalThis.MutationObserver,
    clearTimeoutImpl = globalThis.clearTimeout,
    documentRef = globalThis.document,
    historyRef = globalThis.history,
    locationRef = globalThis.location,
    setTimeoutImpl = globalThis.setTimeout,
    storage = globalThis.localStorage,
    windowRef = globalThis.window,
  } = {}) {
    let active = false;
    let boundTracks = null;
    const historyRestorers = [];
    let observer = null;
    let retryIndex = 0;
    let scheduledTimer = null;
    function cancelScheduledScan() {
      if (scheduledTimer == null) return;
      clearTimeoutImpl(scheduledTimer);
      scheduledTimer = null;
    }
    function unbindCurrentTracks() {
      const tracks = boundTracks;
      boundTracks = null;
      if (!tracks || typeof tracks.removeEventListener !== "function") return;
      for (const eventType of TRACK_LIST_EVENT_TYPES) {
        try {
          tracks.removeEventListener(eventType, handleTrackListChange);
        } catch {
          continue;
        }
      }
    }
    function bindCurrentTracks() {
      const tracks = currentVideoTracks(documentRef);
      if (tracks === boundTracks) return;
      unbindCurrentTracks();
      if (!tracks || typeof tracks.addEventListener !== "function") return;
      boundTracks = tracks;
      for (const eventType of TRACK_LIST_EVENT_TYPES) {
        try {
          tracks.addEventListener(eventType, handleTrackListChange);
        } catch {
          continue;
        }
      }
    }
    function scheduleScan({ restart = false } = {}) {
      if (!active) return;
      if (restart) retryIndex = 0;
      if (scheduledTimer != null) return;
      const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
      scheduledTimer = setTimeoutImpl(() => {
        scheduledTimer = null;
        if (!active) return;
        if (!isPlayerPageLocation(locationRef)) {
          retryIndex = 0;
          unbindCurrentTracks();
          return;
        }
        bindCurrentTracks();
        const result = selectHighestAllowedPlayerTrack({ documentRef, storage });
        if (result.selected || retryIndex >= RETRY_DELAYS_MS.length - 1) {
          retryIndex = 0;
          return;
        }
        retryIndex += 1;
        scheduleScan();
      }, delay);
    }
    function handleLoadedMetadata() {
      scheduleScan({ restart: true });
    }
    function handleQualityChange(event) {
      if (eventBelongsToQualityPane(event)) scheduleScan({ restart: true });
    }
    function handleTrackListChange() {
      scheduleScan({ restart: true });
    }
    function handleRouteChange() {
      scheduleScan({ restart: true });
    }
    function installHistoryHooks() {
      for (const method of ["pushState", "replaceState"]) {
        try {
          const original = historyRef?.[method];
          if (typeof original !== "function") continue;
          const wrapped = function (...args) {
            const result = Reflect.apply(original, this, args);
            handleRouteChange();
            return result;
          };
          historyRef[method] = wrapped;
          if (historyRef[method] !== wrapped) continue;
          historyRestorers.push(() => {
            try {
              if (historyRef[method] === wrapped) historyRef[method] = original;
            } catch {
              return;
            }
          });
        } catch {
          continue;
        }
      }
    }
    function removeHistoryHooks() {
      for (const restore of historyRestorers.splice(0).reverse()) restore();
    }
    function installObserver() {
      if (observer || !documentRef.documentElement || typeof MutationObserverImpl !== "function") {
        return false;
      }
      observer = new MutationObserverImpl((records) => {
        if (mutationTouchesPlayer(records)) scheduleScan({ restart: true });
      });
      observer.observe(documentRef.documentElement, { childList: true, subtree: true });
      return true;
    }
    function handleDocumentReady() {
      installObserver();
      scheduleScan({ restart: true });
    }
    function start() {
      if (active || !documentRef?.addEventListener) return;
      active = true;
      documentRef.addEventListener("loadedmetadata", handleLoadedMetadata, true);
      documentRef.addEventListener("change", handleQualityChange, true);
      if (!installObserver()) {
        documentRef.addEventListener("DOMContentLoaded", handleDocumentReady, { once: true });
      }
      windowRef?.addEventListener?.("popstate", handleRouteChange);
      installHistoryHooks();
      scheduleScan({ restart: true });
    }
    function stop() {
      if (!active) return;
      active = false;
      cancelScheduledScan();
      unbindCurrentTracks();
      observer?.disconnect();
      observer = null;
      removeHistoryHooks();
      documentRef.removeEventListener("loadedmetadata", handleLoadedMetadata, true);
      documentRef.removeEventListener("change", handleQualityChange, true);
      documentRef.removeEventListener("DOMContentLoaded", handleDocumentReady);
      windowRef?.removeEventListener?.("popstate", handleRouteChange);
    }
    return Object.freeze({ start, stop });
  }
  if (typeof document !== "undefined") {
    createHighestQualityPlayerController().start();
  }
})();
