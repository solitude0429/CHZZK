export const PLAYER_LAYOUT_SELECTOR = "#live_player_layout > pzp-pc-layout";
export const QUALITY_PANE_SELECTOR =
  "#live_player_layout pzp-pc-setting-quality-pane, " +
  "#live_player_layout pzp-setting-quality, " +
  "#live_player_layout .pzp-pc-setting-quality-pane, " +
  "#live_player_layout .pzp-setting-quality-pane";
export const QUALITY_STORAGE_KEY = "live-player-video-track";

const MAX_TRACKS = 64;
const MAX_PLAYER_SCAN_NODES = 256;
const MAX_REACT_FIBER_DEPTH = 32;
const MAX_REACT_FIBER_NODES = 1024;
const MAX_REACT_STATE_NODES = 1024;
const MAX_REACT_STATE_DEPTH = 8;
const MANUAL_QUALITY_LABEL_RE = /^\d{3,4}p$/i;
function ignorePageAccessFailure() {
  return false;
}

function positiveDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 32_768 ? number : null;
}

function positiveVideoBitrate(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1_000_000_000 ? number : 0;
}

function playerTracks(player) {
  try {
    const tracks = player?.videoTracks;
    return tracks ? Array.from(tracks).slice(0, MAX_TRACKS) : [];
  } catch {
    return [];
  }
}

function ownDataValue(object, key) {
  if ((typeof object !== "object" && typeof object !== "function") || object == null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function inheritedPropertyDescriptor(object, key) {
  let current = object;
  for (let depth = 0; current && depth < 8; depth += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return descriptor;
      current = Object.getPrototypeOf(current);
    } catch {
      return null;
    }
  }
  return null;
}

function playerFromReactBridge(value) {
  const publicTracks = trackListForPlayer(value);
  if (publicTracks && playerTracks(value).some((track, index) => trackDescriptor(track, index))) {
    return value;
  }
  const internalPlayer = ownDataValue(value, "_internalPlayer");
  return internalPlayer &&
    trackListForPlayer(internalPlayer) &&
    playerTracks(internalPlayer).some((track, index) => trackDescriptor(track, index))
    ? internalPlayer
    : null;
}

function inspectReactStateForPlayers(root, append, scan) {
  const queue = [{ depth: 0, value: root }];
  while (queue.length > 0 && scan.remainingStateNodes > 0) {
    const { depth, value } = queue.shift();
    if (
      (typeof value !== "object" && typeof value !== "function") ||
      value == null ||
      scan.stateValues.has(value)
    ) {
      continue;
    }
    scan.stateValues.add(value);
    scan.remainingStateNodes -= 1;

    const player = playerFromReactBridge(value);
    if (player) {
      append(player);
      return true;
    }
    if (depth >= MAX_REACT_STATE_DEPTH) continue;

    if (Array.isArray(value)) {
      for (const item of value.slice(0, MAX_TRACKS)) queue.push({ depth: depth + 1, value: item });
      continue;
    }

    for (const key of [
      "baseState",
      "current",
      "deps",
      "lastEffect",
      "memoizedProps",
      "memoizedState",
      "next",
      "queue",
      "stateNode",
      "updateQueue",
      "value",
    ]) {
      const nested = ownDataValue(value, key);
      if (nested !== undefined) queue.push({ depth: depth + 1, value: nested });
    }
  }
  return false;
}

function appendReactPlayers(node, append, scan) {
  let propertyNames;
  try {
    propertyNames = Object.getOwnPropertyNames(node);
  } catch {
    return;
  }
  const roots = propertyNames
    .filter(
      (name) =>
        name.startsWith("__reactFiber$") ||
        name.startsWith("__reactInternalInstance$") ||
        name.startsWith("__reactProps$"),
    )
    .slice(0, 4)
    .map((name) => ownDataValue(node, name))
    .filter(Boolean);

  for (const root of roots) {
    let fiber = root;
    for (let depth = 0; fiber && depth < MAX_REACT_FIBER_DEPTH && scan.remainingFiberNodes > 0; depth += 1) {
      if (scan.fibers.has(fiber)) break;
      scan.fibers.add(fiber);
      scan.remainingFiberNodes -= 1;
      if (
        inspectReactStateForPlayers(ownDataValue(fiber, "memoizedState"), append, scan) ||
        inspectReactStateForPlayers(ownDataValue(fiber, "updateQueue"), append, scan) ||
        inspectReactStateForPlayers(ownDataValue(fiber, "memoizedProps"), append, scan) ||
        inspectReactStateForPlayers(ownDataValue(fiber, "stateNode"), append, scan)
      ) {
        return true;
      }
      fiber = ownDataValue(fiber, "return");
    }
  }
  return false;
}

function candidatePlayerElements(documentRef) {
  const candidates = [];
  const seen = new Set();
  const reactScan = {
    fibers: new Set(),
    remainingFiberNodes: MAX_REACT_FIBER_NODES,
    remainingStateNodes: MAX_REACT_STATE_NODES,
    stateValues: new Set(),
  };
  const append = (candidate) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  try {
    append(documentRef?.querySelector?.(PLAYER_LAYOUT_SELECTOR));
  } catch {
    ignorePageAccessFailure();
  }

  let layout = null;
  let reactPlayerFound = false;
  try {
    layout = documentRef?.querySelector?.("#live_player_layout") ?? null;
    append(layout);
    reactPlayerFound = appendReactPlayers(layout, append, reactScan);
  } catch {
    ignorePageAccessFailure();
  }

  const appendVideoAndAncestors = (video, stopAtLayout) => {
    append(video);
    if (!reactPlayerFound) reactPlayerFound = appendReactPlayers(video, append, reactScan);
    let ancestor = video?.parentElement ?? null;
    for (let depth = 0; ancestor && depth < 16; depth += 1) {
      append(ancestor);
      if (!reactPlayerFound) reactPlayerFound = appendReactPlayers(ancestor, append, reactScan);
      if (ancestor === stopAtLayout) break;
      ancestor = ancestor.parentElement ?? null;
    }
  };

  try {
    const scopedVideos = Array.from(
      documentRef?.querySelectorAll?.("#live_player_layout video") ??
        layout?.querySelectorAll?.("video") ??
        [],
    ).slice(0, MAX_TRACKS);
    for (const video of scopedVideos) {
      appendVideoAndAncestors(video, layout);
    }
  } catch {
    ignorePageAccessFailure();
  }

  if (!reactPlayerFound) {
    try {
      const nodes = Array.from(layout?.querySelectorAll?.("*") ?? []).slice(0, MAX_PLAYER_SCAN_NODES);
      for (const node of nodes) {
        append(node);
        if (!reactPlayerFound) reactPlayerFound = appendReactPlayers(node, append, reactScan);
      }
    } catch {
      ignorePageAccessFailure();
    }
  }

  try {
    const globalVideos = Array.from(
      documentRef?.querySelectorAll?.("video.webplayer-internal-video") ?? [],
    ).slice(0, MAX_TRACKS);
    for (const video of globalVideos) {
      if (seen.has(video)) continue;
      appendVideoAndAncestors(video, null);
    }
  } catch {
    ignorePageAccessFailure();
  }

  return candidates;
}

function trackListForPlayer(player) {
  try {
    return player?.videoTracks ?? null;
  } catch {
    return null;
  }
}

function currentPlayerState(documentRef) {
  let fallback = { player: null, tracks: null };
  for (const player of candidatePlayerElements(documentRef)) {
    const tracks = trackListForPlayer(player);
    if (!fallback.player) fallback = { player, tracks };
    if (tracks && playerTracks(player).length > 0) return { player, tracks };
  }
  return fallback;
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
      videoBitrate: positiveVideoBitrate(track?.videoBitrate),
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
  return (
    right.resolution - left.resolution ||
    right.width * right.height - left.width * left.height ||
    (right.videoBitrate ?? 0) - (left.videoBitrate ?? 0)
  );
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

function readStoredTrackIntent(storage) {
  if (!storage?.getItem) return null;
  try {
    const value = JSON.parse(storage.getItem(QUALITY_STORAGE_KEY));
    const label = typeof value?.label === "string" ? value.label.trim() : "";
    const width = positiveDimension(value?.width);
    const height = positiveDimension(value?.height);
    if (!MANUAL_QUALITY_LABEL_RE.test(label) || width == null || height == null) return null;
    return {
      height,
      label,
      resolution: Math.min(width, height),
      videoBitrate: 0,
      width,
    };
  } catch {
    return null;
  }
}

function resolveHighestConcretePlayerTrack(documentRef) {
  const { player, tracks } = currentPlayerState(documentRef);
  if (!player) return { outcome: { reason: "player-missing", selected: false } };

  const concreteCandidates = playerTracks(player).map(trackDescriptor).filter(Boolean);
  const candidates = concreteCandidates.sort(compareTrackCandidates);
  const highestConcrete = candidates[0];
  if (!highestConcrete) return { outcome: { reason: "concrete-track-missing", selected: false } };
  const currentConcrete = concreteCandidates.find((candidate) => isCurrentTrack(player, candidate));
  const candidate =
    currentConcrete && sameTrackQuality(currentConcrete, highestConcrete) ? currentConcrete : highestConcrete;
  return { candidate, player, tracks };
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
    left.player === right.player &&
    left.tracks === right.tracks &&
    left.candidate.track === right.candidate.track,
  );
}

export {
  compareTrackQuality,
  currentPlayerState,
  inheritedPropertyDescriptor,
  isCurrentTrack,
  persistSelectedTrack,
  playerTracks,
  readStoredTrackIntent,
  resolveHighestConcretePlayerTrack,
  resolveStorage,
  sameTrackQuality,
  selectedTrackOutcome,
  selectionContextMatches,
  trackDescriptor,
};
