import {
  QUALITY_PANE_SELECTOR,
  compareTrackQuality,
  currentPlayerState,
  isCurrentTrack,
  persistSelectedTrack,
  readStoredTrackIntent,
  resolveHighestConcretePlayerTrack,
  resolveStorage,
  selectedTrackOutcome,
  selectionContextMatches,
} from "./player-model.js";
import { createPlayerSelectionGuards } from "./player-selection-guards.js";
export { PLAYER_LAYOUT_SELECTOR, QUALITY_PANE_SELECTOR, QUALITY_STORAGE_KEY } from "./player-model.js";
import "./ad-response-controller.js";

const INITIAL_DISCOVERY_TARGET_RESOLUTION = 1080;
const DEFAULT_QUALITY_INTENT = Object.freeze({
  height: 1080,
  label: "1080p",
  resolution: 1080,
  videoBitrate: 0,
  width: 1920,
});
const RETRY_DELAYS_MS = [0, 50, 250, 1000, 3000];
const RESPONSIVE_SETTLE_DELAY_MS = 250;
const RESPONSIVE_RECHECK_DELAYS_MS = [250, 1000, 3000];
const SELECTION_CONFIRM_DELAYS_MS = [50, 200, 750];
const SELECTION_STABLE_MS = 5000;
const WATCHDOG_INTERVAL_MS = 1000;
const MAX_SELECTION_WRITES_PER_CANDIDATE = 2;
const MAX_GLOBAL_SELECTION_WRITES = 4;
const TRACK_LIST_EVENT_TYPES = ["addtrack", "removetrack", "change"];
const CONTROLLER_SLOT = Symbol.for("chzzk.highest-quality-player-controller");

function ignorePageAccessFailure() {
  return false;
}

export function isPlayerPageLocation(value) {
  let hostname = "";
  let pathname;
  try {
    if (typeof value?.pathname === "string") {
      pathname = value.pathname;
      hostname = typeof value.hostname === "string" ? value.hostname.toLowerCase() : "";
    } else {
      const url = new globalThis.URL(String(value), "https://chzzk.naver.com");
      hostname = url.hostname.toLowerCase();
      pathname = url.pathname;
    }
  } catch {
    return false;
  }
  return (
    pathname.startsWith("/") &&
    (!hostname || hostname === "chzzk.naver.com" || hostname.endsWith(".chzzk.naver.com"))
  );
}

export function selectHighestAllowedPlayerTrack({
  allowSelectionWrite = true,
  documentRef = globalThis.document,
  persistSelection = true,
  storage,
} = {}) {
  const resolvedStorage = resolveStorage(storage);
  const resolution = resolveHighestConcretePlayerTrack(documentRef);
  if (resolution.outcome) return resolution.outcome;

  const changed = !isCurrentTrack(resolution.player, resolution.candidate);
  if (changed) {
    if (!allowSelectionWrite) return { reason: "selection-required", selected: false };
    try {
      resolution.candidate.track.selected = true;
    } catch {
      return { reason: "selection-failed", selected: false };
    }
  }

  const observedResolution = resolveHighestConcretePlayerTrack(documentRef);
  if (!selectionContextMatches(resolution, observedResolution)) {
    return { reason: "selection-context-changed", selected: false };
  }
  if (!isCurrentTrack(observedResolution.player, observedResolution.candidate)) {
    return { reason: "selection-not-applied", selected: false };
  }
  if (persistSelection) persistSelectedTrack(resolvedStorage, observedResolution.candidate);
  return selectedTrackOutcome(observedResolution.candidate, changed);
}

function nodeBelongsToQualityPane(node) {
  try {
    if (node?.matches?.(QUALITY_PANE_SELECTOR) || node?.closest?.(QUALITY_PANE_SELECTOR)) return true;
  } catch {
    ignorePageAccessFailure();
  }
  const tagName = String(node?.tagName ?? "").toUpperCase();
  if (tagName === "PZP-PC-SETTING-QUALITY-PANE" || tagName === "PZP-SETTING-QUALITY") {
    return true;
  }
  const classes = String(node?.className ?? "")
    .split(/\s+/)
    .filter(Boolean);
  return classes.includes("pzp-pc-setting-quality-pane") || classes.includes("pzp-setting-quality-pane");
}

function eventBelongsToQualityPane(event) {
  const nodes =
    typeof event?.composedPath === "function" ? event.composedPath() : [event?.target].filter(Boolean);
  return nodes.some(nodeBelongsToQualityPane);
}

function eventBelongsToPlayerMedia(event, documentRef) {
  const nodes =
    typeof event?.composedPath === "function" ? event.composedPath() : [event?.target].filter(Boolean);
  const media = nodes.find((node) => String(node?.tagName ?? "").toUpperCase() === "VIDEO");
  if (!media) return false;
  try {
    const layout = documentRef?.querySelector?.("#live_player_layout") ?? null;
    if (!layout) return false;
    return (
      layout === media ||
      layout.contains?.(media) === true ||
      media.closest?.("#live_player_layout") === layout
    );
  } catch {
    return false;
  }
}

function mutationTouchesPlayer(records) {
  return (Array.isArray(records) ? records : []).some((record) => {
    if (nodeBelongsToQualityPane(record?.target)) return true;
    return [...(record?.addedNodes ?? []), ...(record?.removedNodes ?? [])].some((node) => {
      try {
        const tagName = String(node?.tagName ?? "").toUpperCase();
        if (
          node?.id === "live_player_layout" ||
          tagName === "VIDEO" ||
          tagName === "PZP-PC-LAYOUT" ||
          nodeBelongsToQualityPane(node)
        ) {
          return true;
        }
        return Boolean(
          node?.querySelector?.(
            "#live_player_layout, video, pzp-pc-layout, pzp-pc-setting-quality-pane, " +
              "pzp-setting-quality, .pzp-pc-setting-quality-pane, .pzp-setting-quality-pane",
          ),
        );
      } catch {
        return false;
      }
    });
  });
}

function mutationContainsPlayerRoot(records) {
  return (Array.isArray(records) ? records : []).some((record) =>
    [...(record?.addedNodes ?? []), ...(record?.removedNodes ?? [])].some((node) => {
      try {
        const tagName = String(node?.tagName ?? "").toUpperCase();
        if (node?.id === "live_player_layout" || tagName === "VIDEO" || tagName === "PZP-PC-LAYOUT") {
          return true;
        }
        return Boolean(node?.querySelector?.("#live_player_layout, video, pzp-pc-layout"));
      } catch {
        return false;
      }
    }),
  );
}

function defaultMonotonicNow() {
  try {
    const value = globalThis.performance?.now?.();
    if (Number.isFinite(value)) return value;
  } catch {
    return globalThis.Date.now();
  }
  return globalThis.Date.now();
}

export function createHighestQualityPlayerController({
  MutationObserverImpl = globalThis.MutationObserver,
  clearTimeoutImpl = globalThis.clearTimeout,
  documentRef = globalThis.document,
  historyRef = globalThis.history,
  locationRef = globalThis.location,
  nowImpl = defaultMonotonicNow,
  setTimeoutImpl = globalThis.setTimeout,
  storage,
  windowRef = globalThis.window,
  visualViewportRef = windowRef?.visualViewport,
  watchdogIntervalMs = WATCHDOG_INTERVAL_MS,
} = {}) {
  const guards = createPlayerSelectionGuards(documentRef);
  const resolveControllerPlayerTrack = guards.resolve;
  const resolvedStorage = resolveStorage(storage);
  const storedIntent = readStoredTrackIntent(resolvedStorage);
  let qualityIntent =
    storedIntent && compareTrackQuality(storedIntent, DEFAULT_QUALITY_INTENT) <= 0
      ? storedIntent
      : DEFAULT_QUALITY_INTENT;
  const watchdogDelay =
    Number.isFinite(Number(watchdogIntervalMs)) && Number(watchdogIntervalMs) > 0
      ? Number(watchdogIntervalMs)
      : null;
  let active = false;
  let boundTracks = null;
  let confirmedSelection = null;
  let discoveryContext = null;
  const eventRestorers = [];
  let globalAvailableWrites = MAX_GLOBAL_SELECTION_WRITES;
  let globalLastRefillAt = null;
  const historyRestorers = [];
  let lastNow = 0;
  let observer = null;
  let responsiveTimer = null;
  let responsiveRecheckIndex = 0;
  let responsiveRecheckLimit = 0;
  let responsiveRecheckTimer = null;
  let responsiveRecheckToken = 0;
  let retryIndex = 0;
  let scheduledTimer = null;
  let selectionConfirmationTimer = null;
  let selectionToken = 0;
  let selectionTransaction = null;
  let watchdogTimer = null;

  function now() {
    try {
      const value = Number(nowImpl());
      if (Number.isFinite(value)) lastNow = Math.max(lastNow, value);
    } catch {
      return lastNow;
    }
    return lastNow;
  }

  function cancelScheduledScan() {
    if (scheduledTimer == null) return;
    clearTimeoutImpl(scheduledTimer);
    scheduledTimer = null;
  }

  function cancelWatchdog() {
    if (watchdogTimer == null) return;
    clearTimeoutImpl(watchdogTimer);
    watchdogTimer = null;
  }

  function scheduleWatchdog() {
    if (!active || watchdogDelay == null || watchdogTimer != null) return;
    watchdogTimer = setTimeoutImpl(() => {
      watchdogTimer = null;
      if (!active) return;
      protectQualityIntent();
      scheduleScan({ restart: true });
      scheduleWatchdog();
    }, watchdogDelay);
  }

  function cancelResponsiveScan() {
    if (responsiveTimer == null) return;
    clearTimeoutImpl(responsiveTimer);
    responsiveTimer = null;
  }

  function cancelResponsiveRecheck() {
    if (responsiveRecheckTimer == null) return;
    clearTimeoutImpl(responsiveRecheckTimer);
    responsiveRecheckTimer = null;
  }

  function clearResponsiveRechecks() {
    cancelResponsiveRecheck();
    responsiveRecheckIndex = 0;
    responsiveRecheckLimit = 0;
    responsiveRecheckToken += 1;
  }

  function armResponsiveRechecks() {
    clearResponsiveRechecks();
    responsiveRecheckLimit = RESPONSIVE_RECHECK_DELAYS_MS.length;
  }

  function scheduleResponsiveRecheck() {
    if (!active || responsiveRecheckTimer != null || responsiveRecheckIndex >= responsiveRecheckLimit) {
      return;
    }
    const index = responsiveRecheckIndex;
    const token = responsiveRecheckToken;
    responsiveRecheckIndex += 1;
    responsiveRecheckTimer = setTimeoutImpl(() => {
      responsiveRecheckTimer = null;
      if (!active || token !== responsiveRecheckToken || !isPlayerPageLocation(locationRef)) {
        return;
      }
      scheduleScan({ restart: true });
    }, RESPONSIVE_RECHECK_DELAYS_MS[index]);
  }

  function cancelSelectionConfirmation() {
    if (selectionConfirmationTimer == null) return;
    clearTimeoutImpl(selectionConfirmationTimer);
    selectionConfirmationTimer = null;
  }

  function clearSelectionTransaction() {
    cancelSelectionConfirmation();
    selectionToken += 1;
    selectionTransaction = null;
  }

  function transactionMatches(transaction, resolution) {
    return Boolean(
      transaction &&
      selectionContextMatches(
        {
          candidate: { track: transaction.track },
          player: transaction.player,
          tracks: transaction.tracks,
        },
        resolution,
      ),
    );
  }

  function confirmedContextMatches(resolution) {
    return Boolean(
      confirmedSelection &&
      resolution &&
      !resolution.outcome &&
      confirmedSelection.player === resolution.player &&
      confirmedSelection.tracks === resolution.tracks,
    );
  }

  function rememberConfirmedSelection(resolution, candidate = resolution?.candidate) {
    if (!resolution || !candidate) return;
    confirmedSelection = {
      player: resolution.player,
      track: candidate.track,
      tracks: resolution.tracks,
    };
  }

  function persistQualityIntent(candidate) {
    if (!candidate) return;
    if (qualityIntent && compareTrackQuality(candidate, qualityIntent) > 0) return;
    qualityIntent = {
      height: candidate.height,
      label: candidate.label,
      resolution: candidate.resolution,
      videoBitrate: candidate.videoBitrate,
      width: candidate.width,
    };
    protectQualityIntent();
  }

  function protectQualityIntent() {
    persistSelectedTrack(resolvedStorage, qualityIntent);
  }

  function continueResponsiveRechecks(resolution) {
    const newDiscoveryContext =
      !discoveryContext ||
      discoveryContext.player !== resolution?.player ||
      discoveryContext.tracks !== resolution?.tracks;
    if (newDiscoveryContext) {
      discoveryContext = {
        player: resolution.player,
        tracks: resolution.tracks,
      };
      if (resolution.candidate.resolution < INITIAL_DISCOVERY_TARGET_RESOLUTION) {
        armResponsiveRechecks();
      }
    }
    scheduleResponsiveRecheck();
  }

  function beginSelectionTransaction(resolution) {
    clearSelectionTransaction();
    const candidateWasConfirmed = Boolean(
      confirmedContextMatches(resolution) && confirmedSelection.track === resolution.candidate.track,
    );
    selectionTransaction = {
      availableWrites: MAX_SELECTION_WRITES_PER_CANDIDATE,
      confirmationIndex: 0,
      everConfirmed: candidateWasConfirmed,
      lastRefillAt: null,
      phase: "idle",
      player: resolution.player,
      retryAvailableAt: null,
      stableSince: null,
      token: selectionToken,
      track: resolution.candidate.track,
      tracks: resolution.tracks,
    };
    return selectionTransaction;
  }

  function unbindCurrentTracks() {
    const tracks = boundTracks;
    boundTracks = null;
    if (!tracks || typeof tracks.removeEventListener !== "function") return;
    for (const eventType of TRACK_LIST_EVENT_TYPES) {
      try {
        tracks.removeEventListener(eventType, handleTrackListChange);
      } catch {
        // Page-owned VideoTrackList implementations may reject individual operations.
        continue;
      }
    }
  }

  function bindCurrentTracks() {
    const { tracks } = currentPlayerState(documentRef);
    if (tracks === boundTracks) return;
    unbindCurrentTracks();
    if (!tracks || typeof tracks.addEventListener !== "function") return;
    boundTracks = tracks;
    for (const eventType of TRACK_LIST_EVENT_TYPES) {
      try {
        tracks.addEventListener(eventType, handleTrackListChange);
      } catch {
        // A later scan can still select from a readable list without event support.
        continue;
      }
    }
  }

  function replenishSelectionBudget(transaction, observedAt) {
    if (transaction.lastRefillAt == null) return;
    const elapsed = observedAt - transaction.lastRefillAt;
    const refillCount = Math.floor(elapsed / SELECTION_STABLE_MS);
    if (refillCount <= 0) return;
    transaction.availableWrites = Math.min(
      MAX_SELECTION_WRITES_PER_CANDIDATE,
      transaction.availableWrites + refillCount,
    );
    transaction.lastRefillAt += refillCount * SELECTION_STABLE_MS;
  }

  function replenishGlobalSelectionBudget(observedAt) {
    if (globalLastRefillAt == null) return;
    const elapsed = observedAt - globalLastRefillAt;
    const refillCount = Math.floor(elapsed / SELECTION_STABLE_MS);
    if (refillCount <= 0) return;
    globalAvailableWrites = Math.min(MAX_GLOBAL_SELECTION_WRITES, globalAvailableWrites + refillCount);
    globalLastRefillAt += refillCount * SELECTION_STABLE_MS;
  }

  function markSelectionUnstable(transaction) {
    transaction.lastRefillAt = null;
    transaction.stableSince = null;
  }

  function confirmSelection(resolution, transaction, changed) {
    cancelSelectionConfirmation();
    const ordinaryConfirmation = selectHighestAllowedPlayerTrack({
      allowSelectionWrite: false,
      documentRef,
      persistSelection: false,
      storage: resolvedStorage,
    });
    const observedResolution = resolveControllerPlayerTrack();
    if (
      !ordinaryConfirmation.selected ||
      observedResolution.outcome ||
      !selectionContextMatches(resolution, observedResolution) ||
      !transactionMatches(transaction, observedResolution) ||
      !isCurrentTrack(observedResolution.player, observedResolution.candidate)
    ) {
      clearSelectionTransaction();
      scheduleResponsiveScan();
      return { reason: "selection-context-changed", selected: false };
    }

    const observedAt = now();
    if (transaction.phase === "confirmed" && transaction.stableSince != null) {
      replenishSelectionBudget(transaction, observedAt);
    } else {
      transaction.stableSince = observedAt;
      transaction.lastRefillAt = observedAt;
    }
    if (globalLastRefillAt == null) {
      globalLastRefillAt = observedAt;
    } else {
      replenishGlobalSelectionBudget(observedAt);
    }
    transaction.phase = "confirmed";
    transaction.availableWrites = MAX_SELECTION_WRITES_PER_CANDIDATE;
    transaction.confirmationIndex = 0;
    transaction.everConfirmed = true;
    transaction.retryAvailableAt = null;
    persistQualityIntent(observedResolution.candidate);
    rememberConfirmedSelection(observedResolution);
    continueResponsiveRechecks(observedResolution);
    return selectedTrackOutcome(observedResolution.candidate, changed);
  }

  function scheduleSelectionConfirmation(transaction, index) {
    cancelSelectionConfirmation();
    transaction.confirmationIndex = index;
    const token = transaction.token;
    selectionConfirmationTimer = setTimeoutImpl(() => {
      selectionConfirmationTimer = null;
      if (
        !active ||
        selectionTransaction !== transaction ||
        transaction.token !== token ||
        !isPlayerPageLocation(locationRef)
      ) {
        return;
      }

      bindCurrentTracks();
      const resolution = resolveControllerPlayerTrack();
      if (resolution.outcome) {
        clearSelectionTransaction();
        scheduleScan({ restart: true });
        return;
      }
      if (!transactionMatches(transaction, resolution)) {
        clearSelectionTransaction();
        scheduleResponsiveScan();
        return;
      }
      if (isCurrentTrack(resolution.player, resolution.candidate)) {
        confirmSelection(resolution, transaction, true);
        return;
      }
      const nextIndex = index + 1;
      if (nextIndex < SELECTION_CONFIRM_DELAYS_MS.length) {
        scheduleSelectionConfirmation(transaction, nextIndex);
        return;
      }
      transaction.phase = "idle";
      performSelectionWrite(resolution, transaction);
    }, SELECTION_CONFIRM_DELAYS_MS[index]);
  }

  function performSelectionWrite(resolution, transaction) {
    if (transaction.availableWrites <= 0) {
      if (
        transaction.retryAvailableAt != null &&
        now() >= transaction.retryAvailableAt &&
        globalAvailableWrites > 0
      ) {
        transaction.availableWrites = 1;
      } else {
        transaction.phase = "quiescent";
        return { retry: false };
      }
    }
    if (globalAvailableWrites <= 0) {
      transaction.phase = "quiescent";
      return { retry: false };
    }
    transaction.availableWrites -= 1;
    globalAvailableWrites -= 1;
    const writtenAt = now();
    globalLastRefillAt = writtenAt;
    if (transaction.availableWrites <= 0) {
      transaction.retryAvailableAt = writtenAt + SELECTION_STABLE_MS;
    }
    transaction.phase = "applying";
    markSelectionUnstable(transaction);
    try {
      resolution.candidate.track.selected = true;
    } catch {
      scheduleSelectionConfirmation(transaction, 0);
      return { retry: false };
    }

    bindCurrentTracks();
    const observedResolution = resolveControllerPlayerTrack();
    if (observedResolution.outcome || !transactionMatches(transaction, observedResolution)) {
      clearSelectionTransaction();
      scheduleResponsiveScan();
      return { retry: false };
    }
    if (isCurrentTrack(observedResolution.player, observedResolution.candidate)) {
      confirmSelection(observedResolution, transaction, true);
      return { retry: false };
    }
    scheduleSelectionConfirmation(transaction, 0);
    return { retry: false };
  }

  function reconcileSelection() {
    protectQualityIntent();
    replenishGlobalSelectionBudget(now());
    const resolution = resolveControllerPlayerTrack();
    if (resolution.outcome) {
      clearSelectionTransaction();
      return { retry: true };
    }
    let transaction = selectionTransaction;
    if (!transactionMatches(transaction, resolution)) {
      transaction = beginSelectionTransaction(resolution);
    }

    if (isCurrentTrack(resolution.player, resolution.candidate)) {
      confirmSelection(resolution, transaction, false);
      return { retry: false };
    }

    if (transaction.phase === "confirmed") {
      replenishSelectionBudget(transaction, now());
      markSelectionUnstable(transaction);
      transaction.phase = "idle";
    }
    if (transaction.phase === "applying" && selectionConfirmationTimer != null) {
      return { retry: false };
    }
    if (transaction.phase === "quiescent") {
      if (globalAvailableWrites <= 0) {
        return { retry: false };
      }
      if (transaction.availableWrites <= 0) {
        if (transaction.retryAvailableAt == null || now() < transaction.retryAvailableAt) {
          return { retry: false };
        }
        transaction.availableWrites = 1;
      }
      transaction.phase = "idle";
    }
    transaction.phase = "idle";
    return performSelectionWrite(resolution, transaction);
  }

  function scheduleScan({ restart = false } = {}) {
    if (!active) return;
    if (responsiveTimer != null) return;
    if (restart) {
      retryIndex = 0;
      cancelScheduledScan();
    }
    if (scheduledTimer != null) return;

    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    scheduledTimer = setTimeoutImpl(() => {
      scheduledTimer = null;
      if (!active) return;
      if (!isPlayerPageLocation(locationRef)) {
        retryIndex = 0;
        globalLastRefillAt = null;
        confirmedSelection = null;
        discoveryContext = null;
        unbindCurrentTracks();
        clearResponsiveRechecks();
        clearSelectionTransaction();
        return;
      }
      bindCurrentTracks();
      const result = reconcileSelection();
      if (!result.retry || retryIndex >= RETRY_DELAYS_MS.length - 1) {
        retryIndex = 0;
        scheduleResponsiveRecheck();
        return;
      }
      retryIndex += 1;
      scheduleScan();
    }, delay);
  }

  function scheduleResponsiveScan({ armRechecks = false, delay = RESPONSIVE_SETTLE_DELAY_MS } = {}) {
    if (!active) return;
    if (armRechecks) armResponsiveRechecks();
    cancelScheduledScan();
    cancelResponsiveScan();
    responsiveTimer = setTimeoutImpl(() => {
      responsiveTimer = null;
      if (!active) return;
      retryIndex = 0;
      scheduleScan({ restart: true });
    }, delay);
  }

  function scheduleFreshEvidenceScan() {
    if (responsiveTimer != null) {
      scheduleResponsiveScan({
        delay: RESPONSIVE_SETTLE_DELAY_MS,
      });
      return;
    }
    scheduleScan({ restart: true });
  }

  function handleLoadedMetadata() {
    scheduleFreshEvidenceScan();
  }

  function handleQualityChange(event) {
    if (eventBelongsToQualityPane(event)) scheduleFreshEvidenceScan();
  }

  function handleTrackListChange() {
    scheduleFreshEvidenceScan();
  }

  function handleRouteChange() {
    if (!isPlayerPageLocation(locationRef)) {
      globalLastRefillAt = null;
    }
    clearResponsiveRechecks();
    clearSelectionTransaction();
    confirmedSelection = null;
    discoveryContext = null;
    scheduleResponsiveScan();
  }

  function handleResponsiveChange() {
    scheduleResponsiveScan({ armRechecks: true, delay: 0 });
  }

  function handleMediaEvidence(event) {
    if (!isPlayerPageLocation(locationRef)) return;
    if (eventBelongsToPlayerMedia(event, documentRef)) scheduleFreshEvidenceScan();
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
            // Do not overwrite a page-owned replacement installed after startup.
            return;
          }
        });
      } catch {
        // DOM mutation and popstate handling remain available when History is immutable.
        continue;
      }
    }
  }

  function removeHistoryHooks() {
    for (const restore of historyRestorers.splice(0).reverse()) restore();
  }

  function installEventListener(target, type, listener, options) {
    try {
      if (typeof target?.addEventListener !== "function") return false;
      target.addEventListener(type, listener, options);
      eventRestorers.push(() => {
        try {
          target.removeEventListener?.(type, listener, options);
        } catch {
          return;
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  function removeEventListeners() {
    for (const restore of eventRestorers.splice(0).reverse()) restore();
  }

  function installObserver() {
    if (observer || !documentRef.documentElement || typeof MutationObserverImpl !== "function") {
      return false;
    }
    try {
      observer = new MutationObserverImpl((records) => {
        if (!mutationTouchesPlayer(records)) return;
        scheduleResponsiveScan({
          delay: mutationContainsPlayerRoot(records) ? 0 : RESPONSIVE_SETTLE_DELAY_MS,
        });
      });
      observer.observe(documentRef.documentElement, { childList: true, subtree: true });
      return true;
    } catch {
      try {
        observer?.disconnect?.();
      } catch {
        observer = null;
      }
      observer = null;
      return false;
    }
  }

  function handleDocumentReady() {
    installObserver();
    scheduleScan({ restart: true });
  }

  function start() {
    if (active || !documentRef?.addEventListener) return;
    active = true;
    protectQualityIntent();
    installEventListener(documentRef, "loadedmetadata", handleLoadedMetadata, true);
    installEventListener(documentRef, "change", handleQualityChange, true);
    installEventListener(documentRef, "waiting", handleMediaEvidence, true);
    installEventListener(documentRef, "stalled", handleMediaEvidence, true);
    installEventListener(documentRef, "playing", handleMediaEvidence, true);
    installEventListener(documentRef, "canplay", handleMediaEvidence, true);
    if (!installObserver()) {
      installEventListener(documentRef, "DOMContentLoaded", handleDocumentReady, { once: true });
    }
    installEventListener(windowRef, "popstate", handleRouteChange);
    installEventListener(windowRef, "resize", handleResponsiveChange);
    installEventListener(windowRef, "orientationchange", handleResponsiveChange);
    installEventListener(visualViewportRef, "resize", handleResponsiveChange);
    installHistoryHooks();
    scheduleScan({ restart: true });
    scheduleWatchdog();
  }

  function stop() {
    if (!active) return;
    active = false;
    cancelScheduledScan();
    cancelWatchdog();
    cancelResponsiveScan();
    clearResponsiveRechecks();
    clearSelectionTransaction();
    confirmedSelection = null;
    discoveryContext = null;
    unbindCurrentTracks();
    guards.restore();
    try {
      observer?.disconnect?.();
    } catch {
      observer = null;
    }
    observer = null;
    removeHistoryHooks();
    removeEventListeners();
  }

  return Object.freeze({ start, stop });
}

function stopPreviousGlobalController() {
  try {
    globalThis[CONTROLLER_SLOT]?.stop?.();
    return true;
  } catch {
    return false;
  }
}

function publishGlobalController(controller) {
  try {
    Object.defineProperty(globalThis, CONTROLLER_SLOT, {
      configurable: true,
      value: controller,
    });
    return true;
  } catch {
    return false;
  }
}

if (typeof document !== "undefined") {
  stopPreviousGlobalController();
  const controller = createHighestQualityPlayerController();
  publishGlobalController(controller);
  controller.start();
}
