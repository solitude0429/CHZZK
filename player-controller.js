(() => {
  // src/runtime/ad-response-controller.js
  var GFP_SCHEDULE_DESCRIPTION = "GFP Video Ad Schedule";
  var NAVER_WATERFALL_DESCRIPTION = "Naver SSP Waterfall List";
  var AD_PROTOCOL_VERSION = "0.0.1";
  var CHZZK_LIVE_VIDEO_SCHEDULE_IDS = /* @__PURE__ */ new Set([
    "LIVE_CHZZK_NDP_SCH",
    "LIVE_CHZZK_NDP_SCH_EVENT",
  ]);
  var CHZZK_VOD_VIDEO_SCHEDULE_ID = "CHZZK_NDP_SCH";
  var CHZZK_LIVE_AD_UNIT = /^(?:event_)?w_live_chzzk_naver_va(?:_[a-z0-9]+)*$/i;
  var CHZZK_VOD_AD_UNITS = /* @__PURE__ */ new Set(["w_chzzk_naver_va", "w_chzzk_naver_va_mid"]);
  var MAX_MARKER_SCAN_BYTES = 16384;
  var CONTROLLER_SLOT = /* @__PURE__ */ Symbol.for("chzzk.ad-response-controller");
  var STYLE_ATTRIBUTE = "data-chzzk-extension-ad-guard";
  var AD_UI_STYLE = `
[data-nlog-area="ad_blocking_info_layer"],
.webplayer-internal-core-dimmed,
.webplayer-internal-core-ad-ui,
#live_rs_banner,
#vod_rs_banner {
  display: none !important;
}
`;
  function ignoreAdGuardFailure() {
    return false;
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isChzzkLiveAdUnit(value) {
    return typeof value === "string" && CHZZK_LIVE_AD_UNIT.test(value);
  }
  function isChzzkVodAdUnit(value) {
    return CHZZK_VOD_AD_UNITS.has(value);
  }
  function hasRecognizedChzzkScheduleBreak(videoAdScheduleId, adBreaks) {
    if (CHZZK_LIVE_VIDEO_SCHEDULE_IDS.has(videoAdScheduleId)) {
      return adBreaks.some((adBreak) => isRecord(adBreak) && isChzzkLiveAdUnit(adBreak.adUnitId));
    }
    return (
      videoAdScheduleId === CHZZK_VOD_VIDEO_SCHEDULE_ID &&
      adBreaks.some(
        (adBreak) =>
          isRecord(adBreak) &&
          isChzzkVodAdUnit(adBreak.adUnitId) &&
          Array.isArray(adBreak.adSources) &&
          adBreak.adSources.length > 0,
      )
    );
  }
  function isNeutralSchedule(adBreaks) {
    if (adBreaks.length !== 1 || !isRecord(adBreaks[0])) return false;
    const adBreak = adBreaks[0];
    return (
      adBreak.id === "" &&
      adBreak.startDelay === 0 &&
      adBreak.preFetch === 0 &&
      adBreak.adUnitId === "" &&
      Array.isArray(adBreak.adSources) &&
      adBreak.adSources.length === 0
    );
  }
  function sanitizeChzzkAdResponse(value) {
    if (
      !isRecord(value) ||
      !isRecord(value.head) ||
      value.head.version !== AD_PROTOCOL_VERSION ||
      typeof value.requestId !== "string" ||
      value.requestId === ""
    ) {
      return null;
    }
    if (
      value.head.description === GFP_SCHEDULE_DESCRIPTION &&
      Array.isArray(value.adBreaks) &&
      value.adBreaks.length > 0 &&
      hasRecognizedChzzkScheduleBreak(value.videoAdScheduleId, value.adBreaks) &&
      !isNeutralSchedule(value.adBreaks)
    ) {
      return {
        ...value,
        adBreaks: [
          {
            id: "",
            startDelay: 0,
            preFetch: 0,
            adUnitId: "",
            adSources: [],
          },
        ],
      };
    }
    if (
      value.head.description === NAVER_WATERFALL_DESCRIPTION &&
      (isChzzkLiveAdUnit(value.adUnit) || isChzzkVodAdUnit(value.adUnit)) &&
      isRecord(value.eventTracking) &&
      Number.isFinite(value.randomNumber) &&
      Array.isArray(value.ads) &&
      value.ads.length > 0
    ) {
      return { ...value, ads: [] };
    }
    return null;
  }
  function firstMeaningfulByteIsObject(bytes) {
    let index = 0;
    if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
      index = 3;
    }
    while (
      index < bytes.length &&
      (bytes[index] === 9 || bytes[index] === 10 || bytes[index] === 13 || bytes[index] === 32)
    ) {
      index += 1;
    }
    return bytes[index] === 123;
  }
  function bytesInclude(bytes, marker) {
    const limit = Math.min(bytes.length, MAX_MARKER_SCAN_BYTES);
    if (marker.length === 0 || marker.length > limit) return false;
    const lastStart = limit - marker.length;
    outer: for (let start = 0; start <= lastStart; start += 1) {
      for (let index = 0; index < marker.length; index += 1) {
        if (bytes[start + index] !== marker[index]) continue outer;
      }
      return true;
    }
    return false;
  }
  function rewriteChzzkAdResponseBytes(
    bytes,
    {
      decoder = new globalThis.TextDecoder("utf-8", { fatal: true }),
      encoder = new globalThis.TextEncoder(),
      parse = globalThis.JSON.parse,
      stringify = globalThis.JSON.stringify,
    } = {},
  ) {
    if (!bytes || bytes.byteLength === 0 || !firstMeaningfulByteIsObject(bytes)) return null;
    const scheduleMarker = encoder.encode(GFP_SCHEDULE_DESCRIPTION);
    const waterfallMarker = encoder.encode(NAVER_WATERFALL_DESCRIPTION);
    if (!bytesInclude(bytes, scheduleMarker) && !bytesInclude(bytes, waterfallMarker)) return null;
    try {
      const parsed = parse(decoder.decode(bytes));
      const sanitized = sanitizeChzzkAdResponse(parsed);
      return sanitized ? encoder.encode(stringify(sanitized)) : null;
    } catch {
      return null;
    }
  }
  function createChzzkAdResponseController({
    documentRef = globalThis.document,
    globalRef = globalThis,
  } = {}) {
    const OriginalUint8Array = globalRef.Uint8Array;
    const ProxyImpl = globalRef.Proxy;
    const ReflectImpl = globalRef.Reflect;
    const TextDecoderImpl = globalRef.TextDecoder;
    const TextEncoderImpl = globalRef.TextEncoder;
    const parse = globalRef.JSON?.parse?.bind(globalRef.JSON);
    const stringify = globalRef.JSON?.stringify?.bind(globalRef.JSON);
    let active = false;
    let styleElement = null;
    let wrappedUint8Array = null;
    function installStyle() {
      if (styleElement || typeof documentRef?.createElement !== "function") return;
      const parent = documentRef.head ?? documentRef.documentElement;
      if (!parent?.append) return;
      try {
        const style = documentRef.createElement("style");
        style.setAttribute(STYLE_ATTRIBUTE, "");
        style.textContent = AD_UI_STYLE;
        parent.append(style);
        styleElement = style;
      } catch {
        styleElement = null;
      }
    }
    function start() {
      if (active) return;
      active = true;
      installStyle();
      if (
        typeof OriginalUint8Array !== "function" ||
        typeof ProxyImpl !== "function" ||
        typeof ReflectImpl?.construct !== "function" ||
        typeof TextDecoderImpl !== "function" ||
        typeof TextEncoderImpl !== "function" ||
        typeof parse !== "function" ||
        typeof stringify !== "function"
      ) {
        return;
      }
      const decoder = new TextDecoderImpl("utf-8", { fatal: true });
      const encoder = new TextEncoderImpl();
      wrappedUint8Array = new ProxyImpl(OriginalUint8Array, {
        construct(target, args, newTarget) {
          const candidate = ReflectImpl.construct(target, args, newTarget);
          try {
            const replacement = rewriteChzzkAdResponseBytes(candidate, {
              decoder,
              encoder,
              parse,
              stringify,
            });
            return replacement ? ReflectImpl.construct(target, [replacement], newTarget) : candidate;
          } catch {
            return candidate;
          }
        },
      });
      try {
        globalRef.Uint8Array = wrappedUint8Array;
        if (globalRef.Uint8Array !== wrappedUint8Array) wrappedUint8Array = null;
      } catch {
        wrappedUint8Array = null;
      }
    }
    function stop() {
      if (!active) return;
      active = false;
      try {
        if (wrappedUint8Array && globalRef.Uint8Array === wrappedUint8Array) {
          globalRef.Uint8Array = OriginalUint8Array;
        }
      } catch {
        ignoreAdGuardFailure();
      }
      wrappedUint8Array = null;
      try {
        styleElement?.remove?.();
      } catch {
        ignoreAdGuardFailure();
      }
      styleElement = null;
    }
    return Object.freeze({ start, stop });
  }
  function replacePreviousController() {
    try {
      globalThis[CONTROLLER_SLOT]?.stop?.();
    } catch {
      ignoreAdGuardFailure();
    }
    const controller = createChzzkAdResponseController();
    try {
      Object.defineProperty(globalThis, CONTROLLER_SLOT, {
        configurable: true,
        value: controller,
      });
    } catch {
      ignoreAdGuardFailure();
    }
    controller.start();
  }
  if (typeof document !== "undefined") replacePreviousController();

  // src/runtime/player-controller.js
  var PLAYER_LAYOUT_SELECTOR = "#live_player_layout > pzp-pc-layout";
  var QUALITY_PANE_SELECTOR =
    "#live_player_layout pzp-pc-setting-quality-pane, #live_player_layout pzp-setting-quality, #live_player_layout .pzp-pc-setting-quality-pane, #live_player_layout .pzp-setting-quality-pane";
  var QUALITY_STORAGE_KEY = "live-player-video-track";
  var MAX_TRACKS = 64;
  var MAX_PLAYER_SCAN_NODES = 256;
  var MAX_REACT_FIBER_DEPTH = 32;
  var MAX_REACT_FIBER_NODES = 1024;
  var MAX_REACT_STATE_NODES = 1024;
  var MAX_REACT_STATE_DEPTH = 8;
  var INITIAL_DISCOVERY_TARGET_RESOLUTION = 1080;
  var DEFAULT_QUALITY_INTENT = Object.freeze({
    height: 1080,
    label: "1080p",
    resolution: 1080,
    videoBitrate: 0,
    width: 1920,
  });
  var RETRY_DELAYS_MS = [0, 50, 250, 1e3, 3e3];
  var RESPONSIVE_SETTLE_DELAY_MS = 250;
  var RESPONSIVE_RECHECK_DELAYS_MS = [250, 1e3, 3e3];
  var SELECTION_CONFIRM_DELAYS_MS = [50, 200, 750];
  var SELECTION_STABLE_MS = 5e3;
  var WATCHDOG_INTERVAL_MS = 1e3;
  var MAX_SELECTION_WRITES_PER_CANDIDATE = 2;
  var MAX_GLOBAL_SELECTION_WRITES = 4;
  var MANUAL_QUALITY_LABEL_RE = /^\d{3,4}p$/i;
  var TRACK_LIST_EVENT_TYPES = ["addtrack", "removetrack", "change"];
  var CONTROLLER_SLOT2 = /* @__PURE__ */ Symbol.for("chzzk.highest-quality-player-controller");
  var FILTER_WRAPPER_SLOT = /* @__PURE__ */ Symbol.for("chzzk.highest-quality-filter-wrapper");
  function ignorePageAccessFailure() {
    return false;
  }
  function isPlayerPageLocation(value) {
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
  function positiveDimension(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 32768 ? number : null;
  }
  function positiveVideoBitrate(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 1e9 ? number : 0;
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
    if ((typeof object !== "object" && typeof object !== "function") || object == null) return void 0;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : void 0;
    } catch {
      return void 0;
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
        if (nested !== void 0) queue.push({ depth: depth + 1, value: nested });
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
      for (
        let depth = 0;
        fiber && depth < MAX_REACT_FIBER_DEPTH && scan.remainingFiberNodes > 0;
        depth += 1
      ) {
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
    const seen = /* @__PURE__ */ new Set();
    const reactScan = {
      fibers: /* @__PURE__ */ new Set(),
      remainingFiberNodes: MAX_REACT_FIBER_NODES,
      remainingStateNodes: MAX_REACT_STATE_NODES,
      stateValues: /* @__PURE__ */ new Set(),
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
    if (storage !== void 0) return storage;
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
    const currentConcrete = concreteCandidates.find((candidate2) => isCurrentTrack(player, candidate2));
    const candidate =
      currentConcrete && sameTrackQuality(currentConcrete, highestConcrete)
        ? currentConcrete
        : highestConcrete;
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
  function selectHighestAllowedPlayerTrack({
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
              "#live_player_layout, video, pzp-pc-layout, pzp-pc-setting-quality-pane, pzp-setting-quality, .pzp-pc-setting-quality-pane, .pzp-setting-quality-pane",
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
  function createHighestQualityPlayerController({
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
    const guardedTracks = /* @__PURE__ */ new Map();
    let wrappedFilter = null;
    let wrappedFilterOwnDescriptor = null;
    let wrappedPane = null;
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
    function restoreWrappedFilter() {
      if (!wrappedPane || !wrappedFilter) return;
      try {
        const current = Object.getOwnPropertyDescriptor(wrappedPane, "filter");
        if (wrappedPane.filter === wrappedFilter && current?.value === wrappedFilter) {
          if (wrappedFilterOwnDescriptor) {
            Object.defineProperty(wrappedPane, "filter", wrappedFilterOwnDescriptor);
          } else {
            delete wrappedPane.filter;
          }
        }
      } catch {
        ignorePageAccessFailure();
      }
      wrappedFilter = null;
      wrappedFilterOwnDescriptor = null;
      wrappedPane = null;
    }
    function restoreTrackGuard(track) {
      const guard = guardedTracks.get(track);
      if (!guard) return;
      guardedTracks.delete(track);
      try {
        const current = Object.getOwnPropertyDescriptor(track, "selected");
        if (current?.get !== guard.get || current?.set !== guard.set) return;
        if (guard.ownDescriptor) {
          Object.defineProperty(track, "selected", guard.ownDescriptor);
        } else {
          delete track.selected;
        }
      } catch {
        ignorePageAccessFailure();
      }
    }
    function restoreTrackGuardsExcept(retainedTracks = null) {
      for (const track of [...guardedTracks.keys()]) {
        if (!retainedTracks?.has(track)) restoreTrackGuard(track);
      }
    }
    function ensureTrackSelectionGuards(resolution) {
      if (resolution?.outcome || !resolution?.player) {
        restoreTrackGuardsExcept();
        return;
      }
      const currentTracks = playerTracks(resolution.player);
      const retainedTracks = new Set(currentTracks);
      restoreTrackGuardsExcept(retainedTracks);
      for (const [index, track] of currentTracks.entries()) {
        const existingGuard = guardedTracks.get(track);
        if (existingGuard) {
          let currentDescriptor;
          try {
            currentDescriptor = Object.getOwnPropertyDescriptor(track, "selected");
          } catch {
            continue;
          }
          if (currentDescriptor?.get === existingGuard.get && currentDescriptor?.set === existingGuard.set) {
            continue;
          }
          guardedTracks.delete(track);
        }
        let ownDescriptor;
        try {
          ownDescriptor = Object.getOwnPropertyDescriptor(track, "selected");
        } catch {
          continue;
        }
        if (ownDescriptor && ownDescriptor.configurable !== true) continue;
        const selectedDescriptor = ownDescriptor ?? inheritedPropertyDescriptor(track, "selected");
        if (typeof selectedDescriptor?.get !== "function" || typeof selectedDescriptor?.set !== "function") {
          continue;
        }
        const get = function () {
          return Reflect.apply(selectedDescriptor.get, track, []);
        };
        const set = function (next) {
          if (next === true) {
            const currentResolution = resolveHighestConcretePlayerTrack(documentRef);
            if (!currentResolution.outcome) {
              const requested = trackDescriptor(track, index);
              const highest = currentResolution.candidate;
              if (highest?.track !== track && (!requested || !sameTrackQuality(requested, highest))) {
                if (!isCurrentTrack(currentResolution.player, highest)) {
                  highest.track.selected = true;
                }
                return;
              }
            }
          }
          Reflect.apply(selectedDescriptor.set, track, [next]);
        };
        try {
          Object.defineProperty(track, "selected", {
            configurable: true,
            enumerable: selectedDescriptor.enumerable === true,
            get,
            set,
          });
          const installed = Object.getOwnPropertyDescriptor(track, "selected");
          if (installed?.get !== get || installed?.set !== set) continue;
        } catch {
          continue;
        }
        guardedTracks.set(track, {
          get,
          ownDescriptor,
          set,
        });
      }
    }
    function ensureHighestQualityFilter() {
      let pane;
      let filter;
      try {
        pane = documentRef?.querySelector?.(QUALITY_PANE_SELECTOR) ?? null;
        filter = pane?.filter;
      } catch {
        restoreWrappedFilter();
        return;
      }
      if (pane === wrappedPane && filter === wrappedFilter) return;
      restoreWrappedFilter();
      if (!pane || typeof filter !== "function") return;
      let ownDescriptor;
      let filterDescriptor;
      try {
        ownDescriptor = Object.getOwnPropertyDescriptor(pane, "filter");
        if (ownDescriptor && ownDescriptor.configurable !== true) return;
        filterDescriptor = ownDescriptor ?? inheritedPropertyDescriptor(pane, "filter");
      } catch {
        return;
      }
      const wrapper = function (track, ...args) {
        if (trackDescriptor(track, 0)) return true;
        return Reflect.apply(filter, this, [track, ...args]);
      };
      try {
        Object.defineProperty(wrapper, FILTER_WRAPPER_SLOT, {
          value: true,
        });
        Object.defineProperty(pane, "filter", {
          configurable: true,
          enumerable: filterDescriptor?.enumerable === true,
          value: wrapper,
          writable: true,
        });
        if (pane.filter !== wrapper) throw new Error("filter wrapper rejected");
      } catch {
        try {
          const current = Object.getOwnPropertyDescriptor(pane, "filter");
          if (current?.value === wrapper) {
            if (ownDescriptor) {
              Object.defineProperty(pane, "filter", ownDescriptor);
            } else {
              delete pane.filter;
            }
          }
        } catch {
          ignorePageAccessFailure();
        }
        return;
      }
      wrappedFilter = wrapper;
      wrappedFilterOwnDescriptor = ownDescriptor;
      wrappedPane = pane;
    }
    function resolveControllerPlayerTrack() {
      ensureHighestQualityFilter();
      const resolution = resolveHighestConcretePlayerTrack(documentRef);
      ensureTrackSelectionGuards(resolution);
      return resolution;
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
      restoreTrackGuardsExcept();
      restoreWrappedFilter();
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
      globalThis[CONTROLLER_SLOT2]?.stop?.();
      return true;
    } catch {
      return false;
    }
  }
  function publishGlobalController(controller) {
    try {
      Object.defineProperty(globalThis, CONTROLLER_SLOT2, {
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
})();
