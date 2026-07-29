export const PLAYER_LAYOUT_SELECTOR = "#live_player_layout > pzp-pc-layout";
export const QUALITY_PANE_SELECTOR =
  "#live_player_layout pzp-pc-setting-quality-pane, " + "#live_player_layout pzp-setting-quality";
export const QUALITY_STORAGE_KEY = "live-player-video-track";

const MAX_TRACKS = 64;
const RETRY_DELAYS_MS = [0, 50, 250, 1000, 3000];
const RESPONSIVE_SETTLE_DELAY_MS = 250;
const MEDIA_SETTLE_DELAY_MS = 250;
const MEDIA_STALLED_RECHECK_DELAY_MS = 1000;
const SELECTION_CONFIRM_DELAYS_MS = [50, 200, 750];
const SELECTION_STABLE_MS = 5000;
const GLOBAL_SELECTION_RECOVERY_DELAY_MS = 5000;
const MAX_MEDIA_READINESS_RECHECKS = 1;
const MAX_SELECTION_WRITES_PER_CANDIDATE = 2;
const MAX_GLOBAL_SELECTION_WRITES = 4;
const MANUAL_QUALITY_LABEL_RE = /^\d{3,4}p$/i;
const TRACK_LIST_EVENT_TYPES = ["addtrack", "removetrack", "change"];

export function isPlayerPageLocation(value) {
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
  return Number.isFinite(number) && number > 0 && number <= 32_768 ? number : null;
}

function playerTracks(player) {
  try {
    const tracks = player?.videoTracks;
    return tracks ? Array.from(tracks).slice(0, MAX_TRACKS) : [];
  } catch {
    return [];
  }
}

function currentPlayerState(documentRef) {
  try {
    const player = documentRef?.querySelector?.(PLAYER_LAYOUT_SELECTOR) ?? null;
    return { player, tracks: player?.videoTracks ?? null };
  } catch {
    return { player: null, tracks: null };
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

function compareTrackCandidates(left, right) {
  return compareTrackQuality(left, right) || right.index - left.index;
}

function compareTrackQuality(left, right) {
  return right.resolution - left.resolution || right.width * right.height - left.width * left.height;
}

function sameTrackQuality(left, right) {
  return compareTrackQuality(left, right) === 0;
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

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function resolveHighestAllowedPlayerTrack(documentRef) {
  let filter;
  let pane;
  let player;
  let tracks;
  try {
    player = documentRef?.querySelector?.(PLAYER_LAYOUT_SELECTOR);
    pane = documentRef?.querySelector?.(QUALITY_PANE_SELECTOR);
    filter = pane?.filter;
    tracks = player?.videoTracks ?? null;
  } catch {
    return { outcome: { reason: "player-access-failed", selected: false } };
  }
  if (!player) return { outcome: { reason: "player-missing", selected: false } };

  if (typeof filter !== "function") {
    return { outcome: { reason: "quality-filter-missing", selected: false } };
  }

  const concreteCandidates = playerTracks(player).map(trackDescriptor).filter(Boolean);
  const candidates = concreteCandidates
    .filter((candidate) => {
      try {
        return filter.call(pane, candidate.track) === true;
      } catch {
        return false;
      }
    })
    .sort(compareTrackCandidates);
  const highestAllowed = candidates[0];
  if (!highestAllowed) return { outcome: { reason: "allowed-track-missing", selected: false } };
  const currentConcrete = concreteCandidates.find((candidate) => isCurrentTrack(player, candidate));
  const currentAllowed = candidates.find((candidate) => candidate.track === currentConcrete?.track);
  if (currentConcrete && !currentAllowed && compareTrackQuality(currentConcrete, highestAllowed) < 0) {
    return {
      filter,
      pane,
      player,
      preserved: currentConcrete,
      tracks,
    };
  }
  const candidate =
    currentAllowed && sameTrackQuality(currentAllowed, highestAllowed) ? currentAllowed : highestAllowed;
  return { candidate, filter, pane, player, tracks };
}

function selectedTrackOutcome(candidate, changed) {
  return {
    changed,
    height: candidate.height,
    label: candidate.label,
    selected: true,
    width: candidate.width,
  };
}

function selectionContextMatches(left, right) {
  return Boolean(
    left &&
    right &&
    !right.outcome &&
    !right.preserved &&
    left.filter === right.filter &&
    left.pane === right.pane &&
    left.player === right.player &&
    left.tracks === right.tracks &&
    left.candidate.track === right.candidate.track,
  );
}

export function selectHighestAllowedPlayerTrack({
  allowSelectionWrite = true,
  documentRef = globalThis.document,
  storage,
} = {}) {
  const resolvedStorage = resolveStorage(storage);
  const resolution = resolveHighestAllowedPlayerTrack(documentRef);
  if (resolution.outcome) return resolution.outcome;
  if (resolution.preserved) {
    return {
      changed: false,
      height: resolution.preserved.height,
      label: resolution.preserved.label,
      preserved: true,
      reason: "current-track-above-responsive-filter",
      selected: true,
      width: resolution.preserved.width,
    };
  }

  const changed = !isCurrentTrack(resolution.player, resolution.candidate);
  if (changed) {
    if (!allowSelectionWrite) return { reason: "selection-required", selected: false };
    try {
      resolution.candidate.track.selected = true;
    } catch {
      return { reason: "selection-failed", selected: false };
    }
  }

  const observedResolution = resolveHighestAllowedPlayerTrack(documentRef);
  if (!selectionContextMatches(resolution, observedResolution)) {
    return { reason: "selection-context-changed", selected: false };
  }
  if (!isCurrentTrack(observedResolution.player, observedResolution.candidate)) {
    return { reason: "selection-not-applied", selected: false };
  }
  persistSelectedTrack(resolvedStorage, observedResolution.candidate);
  return selectedTrackOutcome(observedResolution.candidate, changed);
}

function eventBelongsToQualityPane(event) {
  const nodes =
    typeof event?.composedPath === "function" ? event.composedPath() : [event?.target].filter(Boolean);
  return nodes.some((node) => {
    const tagName = String(node?.tagName ?? "").toUpperCase();
    return tagName === "PZP-PC-SETTING-QUALITY-PANE" || tagName === "PZP-SETTING-QUALITY";
  });
}

function currentPlayerMediaEvent(event, documentRef) {
  let player;
  let tracks;
  try {
    player = documentRef?.querySelector?.(PLAYER_LAYOUT_SELECTOR);
    tracks = player?.videoTracks ?? null;
  } catch {
    return null;
  }
  if (!player) return null;
  const nodes =
    typeof event?.composedPath === "function" ? event.composedPath() : [event?.target].filter(Boolean);
  const media = nodes.find((node) => String(node?.tagName ?? "").toUpperCase() === "VIDEO");
  if (!media || !nodes.includes(player)) return null;
  try {
    const primaryMedia = player.querySelector?.("video") ?? null;
    if (primaryMedia !== media) return null;
  } catch {
    return null;
  }
  return { media, player, tracks };
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
} = {}) {
  const resolvedStorage = resolveStorage(storage);
  let active = false;
  let boundTracks = null;
  const eventRestorers = [];
  let globalAvailableWrites = MAX_GLOBAL_SELECTION_WRITES;
  let globalFreshMediaRecoveryAvailable = true;
  let globalLastRefillAt = null;
  let globalRecoveryAvailable = true;
  let globalRecoveryTimer = null;
  const historyRestorers = [];
  let lastNow = 0;
  let mediaHold = null;
  let mediaSettledTimer = null;
  let mediaStalledTimer = null;
  let observer = null;
  let responsiveTimer = null;
  let retryIndex = 0;
  let scheduledTimer = null;
  let selectionConfirmationTimer = null;
  let selectionToken = 0;
  let selectionTransaction = null;

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

  function cancelResponsiveScan() {
    if (responsiveTimer == null) return;
    clearTimeoutImpl(responsiveTimer);
    responsiveTimer = null;
  }

  function cancelMediaSettledScan() {
    if (mediaSettledTimer == null) return;
    clearTimeoutImpl(mediaSettledTimer);
    mediaSettledTimer = null;
  }

  function cancelMediaStalledScan() {
    if (mediaStalledTimer == null) return;
    clearTimeoutImpl(mediaStalledTimer);
    mediaStalledTimer = null;
  }

  function clearMediaHold() {
    cancelMediaSettledScan();
    cancelMediaStalledScan();
    mediaHold = null;
  }

  function grantFreshMediaRecovery(hold) {
    if (
      hold?.hadUnsettled !== true ||
      globalAvailableWrites > 0 ||
      globalRecoveryAvailable ||
      !globalFreshMediaRecoveryAvailable
    ) {
      return;
    }
    globalAvailableWrites = 1;
    globalFreshMediaRecoveryAvailable = false;
    if (selectionTransaction?.phase === "quiescent") selectionTransaction.phase = "idle";
  }

  function cancelSelectionConfirmation() {
    if (selectionConfirmationTimer == null) return;
    clearTimeoutImpl(selectionConfirmationTimer);
    selectionConfirmationTimer = null;
  }

  function cancelGlobalRecovery() {
    if (globalRecoveryTimer == null) return;
    clearTimeoutImpl(globalRecoveryTimer);
    globalRecoveryTimer = null;
  }

  function clearSelectionTransaction() {
    cancelSelectionConfirmation();
    cancelGlobalRecovery();
    selectionToken += 1;
    selectionTransaction = null;
  }

  function transactionMatches(transaction, resolution) {
    return Boolean(
      transaction &&
      selectionContextMatches(
        {
          candidate: { track: transaction.track },
          filter: transaction.filter,
          pane: transaction.pane,
          player: transaction.player,
          tracks: transaction.tracks,
        },
        resolution,
      ),
    );
  }

  function beginSelectionTransaction(resolution) {
    clearSelectionTransaction();
    selectionTransaction = {
      availableWrites: MAX_SELECTION_WRITES_PER_CANDIDATE,
      confirmationIndex: 0,
      filter: resolution.filter,
      lastRefillAt: null,
      pane: resolution.pane,
      phase: "idle",
      player: resolution.player,
      stableSince: null,
      token: selectionToken,
      track: resolution.candidate.track,
      tracks: resolution.tracks,
    };
    return selectionTransaction;
  }

  function mediaBlocksTransaction(transaction) {
    return Boolean(
      mediaHold &&
      mediaHold.player === transaction.player &&
      (mediaHold.tracks == null || mediaHold.tracks === transaction.tracks),
    );
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

  function primaryMediaForPlayer(player) {
    try {
      return player?.querySelector?.("video") ?? null;
    } catch {
      return null;
    }
  }

  function mediaHasResumed(media) {
    try {
      const readyState = Number(media?.readyState);
      return Number.isFinite(readyState) && readyState >= 3 && media?.paused !== true;
    } catch {
      return false;
    }
  }

  function scheduleMediaReadinessRecheck(hold) {
    if (mediaStalledTimer != null || hold.readinessRechecksRemaining <= 0) return;
    mediaStalledTimer = setTimeoutImpl(() => {
      mediaStalledTimer = null;
      if (!active || mediaHold !== hold) return;

      const { player, tracks } = currentPlayerState(documentRef);
      const primaryMedia = primaryMediaForPlayer(player);
      if (!player) return;
      hold.readinessRechecksRemaining -= 1;
      if (player !== hold.player || primaryMedia !== hold.media) {
        cancelMediaSettledScan();
        hold.media = primaryMedia;
        hold.player = player;
        hold.reason = "replacement";
        hold.tracks = tracks;
        if (mediaHasResumed(hold.media)) {
          grantFreshMediaRecovery(hold);
          clearMediaHold();
          scheduleFreshEvidenceScan();
        }
        return;
      }
      if (tracks) hold.tracks = tracks;
      if (hold.reason !== "waiting" && mediaHasResumed(hold.media)) {
        grantFreshMediaRecovery(hold);
        clearMediaHold();
        scheduleFreshEvidenceScan();
      }
    }, MEDIA_STALLED_RECHECK_DELAY_MS);
  }

  function reconcileMediaHold(player, tracks) {
    if (!mediaHold) return;
    const primaryMedia = primaryMediaForPlayer(player);
    if (!player) return;
    if (player !== mediaHold.player || primaryMedia !== mediaHold.media) {
      cancelMediaSettledScan();
      mediaHold.media = primaryMedia;
      mediaHold.player = player;
      mediaHold.reason = "replacement";
      mediaHold.tracks = tracks;
      scheduleMediaReadinessRecheck(mediaHold);
      return;
    }
    if (!mediaHold.media && primaryMedia) mediaHold.media = primaryMedia;
    if (tracks) mediaHold.tracks = tracks;
  }

  function bindCurrentTracks() {
    const { player, tracks } = currentPlayerState(documentRef);
    reconcileMediaHold(player, tracks);
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
    globalFreshMediaRecoveryAvailable = true;
    globalRecoveryAvailable = true;
    globalLastRefillAt += refillCount * SELECTION_STABLE_MS;
  }

  function markSelectionUnstable(transaction) {
    transaction.lastRefillAt = null;
    transaction.stableSince = null;
  }

  function confirmSelection(resolution, transaction, changed) {
    cancelSelectionConfirmation();
    const confirmation = selectHighestAllowedPlayerTrack({
      allowSelectionWrite: false,
      documentRef,
      storage: resolvedStorage,
    });
    const observedResolution = resolveHighestAllowedPlayerTrack(documentRef);
    if (
      !confirmation.selected ||
      confirmation.preserved ||
      !selectionContextMatches(resolution, observedResolution) ||
      !transactionMatches(transaction, observedResolution)
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
    transaction.confirmationIndex = 0;
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
      const resolution = resolveHighestAllowedPlayerTrack(documentRef);
      if (resolution.preserved) {
        clearSelectionTransaction();
        return;
      }
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
      if (mediaBlocksTransaction(transaction)) {
        transaction.phase = "waiting-media";
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

  function scheduleGlobalRecovery(transaction) {
    if (!globalRecoveryAvailable) {
      transaction.phase = "quiescent";
      return { retry: false };
    }
    if (globalRecoveryTimer != null) return { retry: false };
    transaction.phase = "global-cooldown";
    const token = transaction.token;
    globalRecoveryTimer = setTimeoutImpl(() => {
      globalRecoveryTimer = null;
      if (
        !active ||
        selectionTransaction !== transaction ||
        transaction.token !== token ||
        !isPlayerPageLocation(locationRef)
      ) {
        return;
      }

      bindCurrentTracks();
      const resolution = resolveHighestAllowedPlayerTrack(documentRef);
      if (resolution.preserved) {
        clearSelectionTransaction();
        return;
      }
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
        confirmSelection(resolution, transaction, false);
        return;
      }
      if (mediaBlocksTransaction(transaction)) {
        transaction.phase = "waiting-media";
        return;
      }

      globalRecoveryAvailable = false;
      globalAvailableWrites = 1;
      transaction.phase = "idle";
      performSelectionWrite(resolution, transaction);
    }, GLOBAL_SELECTION_RECOVERY_DELAY_MS);
    return { retry: false };
  }

  function performSelectionWrite(resolution, transaction) {
    if (transaction.availableWrites <= 0) {
      transaction.phase = "quiescent";
      return { retry: false };
    }
    if (globalAvailableWrites <= 0) {
      return scheduleGlobalRecovery(transaction);
    }
    if (mediaBlocksTransaction(transaction)) {
      transaction.phase = "waiting-media";
      return { retry: false };
    }

    transaction.availableWrites -= 1;
    globalAvailableWrites -= 1;
    globalLastRefillAt = null;
    transaction.phase = "applying";
    markSelectionUnstable(transaction);
    try {
      resolution.candidate.track.selected = true;
    } catch {
      scheduleSelectionConfirmation(transaction, 0);
      return { retry: false };
    }

    bindCurrentTracks();
    const observedResolution = resolveHighestAllowedPlayerTrack(documentRef);
    if (observedResolution.preserved) {
      clearSelectionTransaction();
      return { retry: false };
    }
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
    replenishGlobalSelectionBudget(now());
    const resolution = resolveHighestAllowedPlayerTrack(documentRef);
    if (resolution.outcome) {
      clearSelectionTransaction();
      return { retry: true };
    }
    if (resolution.preserved) {
      clearSelectionTransaction();
      return { retry: false };
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
    if (transaction.phase === "waiting-media" && mediaBlocksTransaction(transaction)) {
      return { retry: false };
    }
    if (transaction.phase === "quiescent") {
      return { retry: false };
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
        unbindCurrentTracks();
        clearMediaHold();
        clearSelectionTransaction();
        return;
      }
      bindCurrentTracks();
      const result = reconcileSelection();
      if (!result.retry || retryIndex >= RETRY_DELAYS_MS.length - 1) {
        retryIndex = 0;
        return;
      }
      retryIndex += 1;
      scheduleScan();
    }, delay);
  }

  function scheduleResponsiveScan() {
    if (!active) return;
    cancelScheduledScan();
    cancelResponsiveScan();
    cancelSelectionConfirmation();
    cancelGlobalRecovery();
    if (selectionTransaction?.phase === "applying" || selectionTransaction?.phase === "global-cooldown") {
      selectionTransaction.phase = "idle";
    }
    responsiveTimer = setTimeoutImpl(() => {
      responsiveTimer = null;
      if (!active) return;
      retryIndex = 0;
      scheduleScan({ restart: true });
    }, RESPONSIVE_SETTLE_DELAY_MS);
  }

  function scheduleFreshEvidenceScan() {
    if (responsiveTimer != null) {
      scheduleResponsiveScan();
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
    if (!isPlayerPageLocation(locationRef)) globalLastRefillAt = null;
    scheduleResponsiveScan();
  }

  function handleResponsiveChange() {
    scheduleResponsiveScan();
  }

  function handleMediaUnsettled(event) {
    const evidence = currentPlayerMediaEvent(event, documentRef);
    if (!evidence) return;
    cancelMediaSettledScan();
    const sameMedia = mediaHold?.media === evidence.media && mediaHold?.player === evidence.player;
    const hadWaiting = event?.type === "waiting" || (sameMedia && mediaHold?.hadWaiting === true);
    const reason = hadWaiting ? "waiting" : "stalled";
    if (!mediaHold) {
      mediaHold = {
        ...evidence,
        hadWaiting,
        hadUnsettled: true,
        readinessRechecksRemaining: MAX_MEDIA_READINESS_RECHECKS,
        reason,
      };
    } else {
      mediaHold.media = evidence.media;
      mediaHold.player = evidence.player;
      mediaHold.hadWaiting = hadWaiting;
      mediaHold.reason = reason;
      mediaHold.tracks = evidence.tracks;
    }
    if (reason === "waiting") cancelMediaStalledScan();
    if (mediaHold.reason === "stalled") scheduleMediaReadinessRecheck(mediaHold);
  }

  function handleMediaSettled(event) {
    const evidence = currentPlayerMediaEvent(event, documentRef);
    if (!evidence || !mediaHold) return;
    if (evidence.media !== mediaHold.media || evidence.player !== mediaHold.player) {
      cancelMediaSettledScan();
      cancelMediaStalledScan();
      mediaHold.media = evidence.media;
      mediaHold.player = evidence.player;
      mediaHold.reason = "settling";
      mediaHold.tracks = evidence.tracks;
    } else {
      mediaHold.tracks = evidence.tracks;
      mediaHold.reason = "settling";
      cancelMediaStalledScan();
      if (mediaSettledTimer != null) return;
    }
    const settledHold = mediaHold;
    mediaSettledTimer = setTimeoutImpl(() => {
      mediaSettledTimer = null;
      if (!active) return;
      const { player, tracks } = currentPlayerState(documentRef);
      const primaryMedia = primaryMediaForPlayer(player);
      if (mediaHold !== settledHold) {
        return;
      }
      if (player !== settledHold.player || primaryMedia !== settledHold.media) {
        reconcileMediaHold(player, tracks);
        return;
      }
      if (tracks) settledHold.tracks = tracks;
      grantFreshMediaRecovery(settledHold);
      clearMediaHold();
      scheduleFreshEvidenceScan();
    }, MEDIA_SETTLE_DELAY_MS);
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
        if (mutationTouchesPlayer(records)) scheduleResponsiveScan();
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
    installEventListener(documentRef, "loadedmetadata", handleLoadedMetadata, true);
    installEventListener(documentRef, "change", handleQualityChange, true);
    installEventListener(documentRef, "waiting", handleMediaUnsettled, true);
    installEventListener(documentRef, "stalled", handleMediaUnsettled, true);
    installEventListener(documentRef, "playing", handleMediaSettled, true);
    installEventListener(documentRef, "canplay", handleMediaSettled, true);
    installEventListener(documentRef, "timeupdate", handleMediaSettled, true);
    if (!installObserver()) {
      installEventListener(documentRef, "DOMContentLoaded", handleDocumentReady, { once: true });
    }
    installEventListener(windowRef, "popstate", handleRouteChange);
    installEventListener(windowRef, "resize", handleResponsiveChange);
    installEventListener(windowRef, "orientationchange", handleResponsiveChange);
    installEventListener(visualViewportRef, "resize", handleResponsiveChange);
    installHistoryHooks();
    scheduleScan({ restart: true });
  }

  function stop() {
    if (!active) return;
    active = false;
    cancelScheduledScan();
    cancelResponsiveScan();
    clearMediaHold();
    clearSelectionTransaction();
    unbindCurrentTracks();
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

if (typeof document !== "undefined") {
  createHighestQualityPlayerController().start();
}
