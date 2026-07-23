(() => {
  // policy/quality-policy.json
  var quality_policy_default = {
    mode: "highest-supported-grid-quality",
    qualityCandidates: ["2160p", "1440p", "1080p", "720p", "480p", "360p", "270p", "144p"],
    minRedirectQuality: "100p",
    trustedInitiatorDomains: ["chzzk.naver.com"],
    trustedRequestDomains: ["akamaized.net", "chzzk.naver.com", "gscdn.net", "navercdn.com", "pstatic.net"],
    resourceTypes: ["media", "other", "xmlhttprequest"],
    requestMethods: ["get"],
    urlQualityPrefixes: ["chunklist_", "/"],
    mediaExtensions: ["m3u8"],
    maxDiagnosticsSamples: 200,
    maxPendingDiagnosticsMutations: 50,
    blockingProbeBudgetMs: 150,
    markerEvidenceTtlMs: 1e4,
    probeMaxBytes: 256e3,
    probeResolutionBudgetMs: 3e3,
    probeTimeoutMs: 1500,
    redirectFailureBackoffMs: 1e4,
    notes: [
      "Firefox MV2 declares the CHZZK origin and trusted HLS CDN origins as required permissions so webRequest can observe dedicated livecloud playlists initiated by the site's same-origin small-player pages instead of exposing core access as optional MV3 site toggles.",
      "A minimal MV2 content script runs at document_start on CHZZK live pages only and sends a live-page-ready message; it does not query or mutate the page DOM.",
      "The persistent background page uses blocking webRequest, but an unresolved candidate search can delay a request only for blockingProbeBudgetMs before failing open while one shared per-tab/live-context/playlist-family resolution continues in the background.",
      "A trusted HLS master playlist starts non-blocking scoring by resolution, frame rate, then bitrate; the resolved target is cached only while the tab/context token and secret-free playlist family are current.",
      "Numeric quality replacement changes safe pathname markers only, preserves the observed 360p-directory/chunklist_480p legacy shape, rejects other marker contradictions, and preserves signed query strings and fragments byte-for-byte.",
      "Without a cached target, configured candidates are checked from highest to lowest within probeResolutionBudgetMs; only concurrent requests in the same playlist family share an in-flight resolution.",
      "URL-marker-only media evidence uses markerEvidenceTtlMs as an idle TTL: Firefox passes redirected response chunks through immediately, keeps any stream-write/filter failure sticky, strips only the unsent client-side fragment for exact network-event URL comparison, and renews only after both a successful 2xx completion and a bounded streamed body prove usable HLS evidence, except that an exact-network-URL HTTP 304 renews prior validated evidence after bodyless cache revalidation; status-only, empty/HTML/malformed or oversized non-304, other 3xx, HTTP 204/205, 4xx/5xx, final-URL mismatch, and request-error results invalidate and suppress the failed family target for redirectFailureBackoffMs before it may be considered again.",
      "The generated quality regex matches numeric qualities lower than the resolved family target; it does not enumerate only today's menu values.",
      "CHZZK livecloud playlist hosts may resolve/use GSCdn; keep gscdn.net covered for HLS playlist requests.",
      "Request URL, initiator, method, resource type, trusted request domain, and CHZZK context constrain redirects; explicit foreign metadata vetoes cache, and a same-site non-live CHZZK document may continue small-player playback only on the two dedicated CHZZK livecloud host suffixes. Origin-only CHZZK metadata also requires a dedicated host unless the tab was authoritatively prewarmed as live; metadata-free contextless compatibility is limited to those same suffixes rather than generic CDN path markers.",
      "Prewarm marks the CHZZK live tab only; it is a supporting signal, not the sole gate. The runtime resolves the best actually available HLS variant from trusted playlist evidence instead of seeding a fixed startup quality.",
      "Candidate probes reject redirects because Firefox does not expose manual redirect hops; bodies require an exact first meaningful EXTM3U line, reject obvious HTML/JSON types, are capped by probeMaxBytes in UTF-8 bytes, and must prove the requested candidate before seeding a target.",
      "Same-URL reload clears quality state separately from authoritatively validated tab trust; navigation and tab close abort pending probes and invalidate their context token so stale completions cannot restore a target.",
      "Diagnostics use an exact bounded schema with saturating non-negative safe-integer counters and canonical allowlist domain labels that discard subdomains and ports.",
    ],
  };

  // src/shared/quality.js
  var QUALITY_LABEL_RE = /^(\d{3,4})p$/i;
  var DEFAULT_QUALITY_CANDIDATES = ["2160p", "1440p", "1080p", "720p", "480p", "360p", "270p", "144p"];
  var QUALITY_PATH_MARKER_SOURCE = String.raw`(?:chunklist_|\/)(\d{3,4}p)(?=(?:[_-][^/]*)?\.m3u8$|\/)`;
  var RESOLUTION_RE = /(?:RESOLUTION=|^)(\d{3,5})x(\d{3,5})(?:[,\s]|$)/i;
  var TEXT_QUALITY_RE = /(?:^|[^0-9])(\d{3,4})\s*p(?:[^0-9]|$)/i;
  var MAX_PLAYLIST_FAMILY_PATH_LENGTH = 4096;
  var MAX_PLAYLIST_FAMILY_SEGMENTS = 64;
  var MAX_HLS_BANDWIDTH = 1e9;
  var MAX_HLS_FRAME_RATE = 240;
  var SIGNED_PATH_TAIL_RE = /(?:^|[~;&])(?:[a-z][a-z0-9_-]{0,31})=/i;
  var DIAGNOSTIC_DOMAIN_LABELS = [
    "akamaized.net",
    "chzzk.naver.com",
    "gscdn.net",
    "navercdn.com",
    "pstatic.net",
  ];
  function normalizeQualityLabel(value) {
    if (typeof value !== "string") return null;
    const resolutionMatch = value.match(RESOLUTION_RE);
    if (resolutionMatch) return `${Number(resolutionMatch[2])}p`;
    const qualityMatch = value.match(TEXT_QUALITY_RE);
    if (!qualityMatch) return null;
    return `${Number(qualityMatch[1])}p`;
  }
  function qualityNumber(label) {
    const normalized = normalizeQualityLabel(label);
    if (!normalized) return null;
    const match = normalized.match(QUALITY_LABEL_RE);
    return match ? Number(match[1]) : null;
  }
  function parseQualitiesFromUrl(url) {
    if (typeof url !== "string") return [];
    let pathname = url;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url.split("?")[0].split("#")[0];
    }
    return [...pathname.matchAll(new RegExp(QUALITY_PATH_MARKER_SOURCE, "gi"))]
      .map((match) => normalizeQualityLabel(match[1]))
      .filter(Boolean);
  }
  function parseQualityFromUrl(url) {
    return parseQualitiesFromUrl(url)[0] ?? null;
  }
  function urlQualityMarkersAreSafe(url) {
    const qualities = parseQualitiesFromUrl(url);
    if (qualities.length <= 1) return true;
    if (qualities.every((quality) => quality === qualities[0])) return true;
    return qualities.length === 2 && qualities[0] === "360p" && qualities[1] === "480p";
  }
  function decodePathSegment(segment) {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }
  function stripSignedPathTail(segment) {
    const decoded = decodePathSegment(segment);
    const match = SIGNED_PATH_TAIL_RE.exec(decoded);
    if (!match) return { prefix: segment, signed: false };
    const prefix = decoded.slice(0, match.index).replace(/[~;&]+$/, "");
    return { prefix: prefix ? encodeURIComponent(prefix) : "", signed: true };
  }
  function playlistNameDiscriminator(segment) {
    const { prefix } = stripSignedPathTail(segment);
    const decoded = decodePathSegment(prefix);
    if (!/\.m3u8$/i.test(decoded)) return null;
    let stem = decoded.slice(0, -".m3u8".length);
    stem = stem.replace(/(^|[_-])\d{3,4}p(?=$|[_-])/gi, "$1{quality}");
    stem = stem.replace(
      /^(?:chunklist(?:_\{quality\})?|index|manifest|master|media|playlist)(?:[_-]+|$)/i,
      "",
    );
    stem = stem.replace(/\{quality\}/gi, "").replace(/^[-_.]+|[-_.]+$/g, "");
    return stem ? encodeURIComponent(stem) : "";
  }
  function playlistFamilyKey(url) {
    if (typeof url !== "string" || url === "") return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !parsed.hostname) return null;
      if (parsed.pathname.length > MAX_PLAYLIST_FAMILY_PATH_LENGTH) return null;
      const rawSegments = parsed.pathname.split("/").filter(Boolean);
      if (rawSegments.length > MAX_PLAYLIST_FAMILY_SEGMENTS) return null;
      const playlistIndex = rawSegments.findIndex((segment) => {
        const { prefix } = stripSignedPathTail(segment);
        return /\.m3u8$/i.test(decodePathSegment(prefix));
      });
      if (playlistIndex === -1) return null;
      const discriminator = playlistNameDiscriminator(rawSegments[playlistIndex]);
      if (discriminator === null) return null;
      const directorySegments = rawSegments.slice(0, playlistIndex);
      const familySegments = [];
      let removedRenditionMarker = false;
      for (const segment of directorySegments) {
        const { prefix, signed } = stripSignedPathTail(segment);
        const decoded = decodePathSegment(prefix);
        if (prefix === "" && signed) break;
        if (/^\d{3,4}p$/i.test(decoded)) {
          removedRenditionMarker = true;
          continue;
        }
        if (removedRenditionMarker && /^(?:media|playlist|playlists|segment|segments)$/i.test(decoded)) {
          continue;
        }
        familySegments.push(prefix);
        if (signed) break;
      }
      return JSON.stringify([
        `${parsed.protocol}//${parsed.host.toLowerCase()}`,
        familySegments,
        discriminator,
      ]);
    } catch {
      return null;
    }
  }
  function redactMediaUrl(url) {
    if (typeof url !== "string" || url === "") return "";
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return "[redacted-url]";
      const quality = parseQualityFromUrl(url);
      const isPlaylist = /\.m3u8$/i.test(parsed.pathname);
      const mediaShape = isPlaylist ? `/${quality ?? "playlist"}.m3u8` : quality ? `/${quality}` : "";
      const hadSensitiveTail = Boolean(parsed.search || parsed.hash);
      const hostname = parsed.hostname.toLowerCase();
      const domainLabel =
        DIAGNOSTIC_DOMAIN_LABELS.find((domain) => hostname === domain || hostname.endsWith(`.${domain}`)) ??
        "other-media.invalid";
      return `${parsed.protocol}//${domainLabel}/[redacted-path]${mediaShape}${hadSensitiveTail ? "?[redacted]" : ""}`;
    } catch {
      return "[redacted-url]";
    }
  }
  function normalizeQualityCandidates(
    candidates = DEFAULT_QUALITY_CANDIDATES,
    { include = [], minRedirectQuality = "100p" } = {},
  ) {
    const min = qualityNumber(minRedirectQuality) ?? 0;
    const labels = [...(Array.isArray(candidates) ? candidates : []), ...include]
      .map((candidate) => normalizeQualityLabel(candidate))
      .filter(Boolean);
    return [...new Set(labels)]
      .map((label) => ({ label, value: qualityNumber(label) }))
      .filter((entry) => entry.value && entry.value >= min)
      .sort((a, b) => b.value - a.value)
      .map((entry) => entry.label);
  }
  function replaceQualityInUrl(url, targetQuality) {
    const normalizedTarget = normalizeQualityLabel(targetQuality);
    const target = qualityNumber(normalizedTarget);
    const currentQuality = parseQualityFromUrl(url);
    if (
      typeof url !== "string" ||
      !normalizedTarget ||
      !target ||
      !currentQuality ||
      !urlQualityMarkersAreSafe(url)
    ) {
      return null;
    }
    const urlParts = url.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)([?#][\s\S]*)?$/i);
    if (!urlParts) return null;
    try {
      new URL(url);
    } catch {
      return null;
    }
    let replacedAny = false;
    const replacedPath = urlParts[2].replace(
      new RegExp(QUALITY_PATH_MARKER_SOURCE, "gi"),
      (match, quality) => {
        const current = qualityNumber(quality);
        if (!current || current >= target) return match;
        replacedAny = true;
        return match.replace(quality, normalizedTarget);
      },
    );
    if (!replacedAny) return null;
    const replacedUrl = `${urlParts[1]}${replacedPath}${urlParts[3] ?? ""}`;
    return urlQualityMarkersAreSafe(replacedUrl) ? replacedUrl : null;
  }
  function splitHlsAttributeList(value) {
    const result = [];
    let current = "";
    let quoted = false;
    for (const char of String(value ?? "")) {
      if (char === '"') quoted = !quoted;
      if (char === "," && !quoted) {
        result.push(current);
        current = "";
        continue;
      }
      current += char;
    }
    if (quoted) return null;
    if (current) result.push(current);
    return result;
  }
  function parseHlsAttributeList(value) {
    const entries = splitHlsAttributeList(value);
    if (!entries) return null;
    const attributes = {};
    for (const entry of entries) {
      const separator = entry.indexOf("=");
      if (separator <= 0) return null;
      const key = entry.slice(0, separator).trim().toUpperCase();
      if (!/^[A-Z0-9-]+$/.test(key) || Object.hasOwn(attributes, key)) return null;
      let rawValue = entry.slice(separator + 1).trim();
      if (rawValue.startsWith('"')) {
        if (rawValue.length < 2 || !rawValue.endsWith('"')) return null;
        rawValue = rawValue.slice(1, -1);
      } else if (rawValue.includes('"')) {
        return null;
      }
      attributes[key] = rawValue;
    }
    return attributes;
  }
  function boundedPositiveDecimalInteger(value, max) {
    if (value == null) return { valid: true, value: null };
    if (typeof value !== "string" || !/^\d+$/.test(value)) return { valid: false, value: null };
    const number = Number(value);
    return {
      valid: Number.isSafeInteger(number) && number > 0 && number <= max,
      value: number,
    };
  }
  function boundedPositiveDecimal(value, max) {
    if (value == null) return { valid: true, value: null };
    if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
      return { valid: false, value: null };
    }
    const number = Number(value);
    return {
      valid: Number.isFinite(number) && number > 0 && number <= max,
      value: number,
    };
  }
  function parseResolutionAttribute(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/^(\d{2,5})x(\d{2,5})$/i);
    if (!match) return null;
    return { height: Number(match[2]), width: Number(match[1]) };
  }
  function parseHlsMasterPlaylistVariants(playlistText, baseUrl = "") {
    const lines = String(playlistText ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim());
    const variants = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.toUpperCase().startsWith("#EXT-X-STREAM-INF:")) continue;
      const attributes = parseHlsAttributeList(line.slice(line.indexOf(":") + 1));
      if (!attributes) continue;
      const averageBandwidth = boundedPositiveDecimalInteger(
        attributes["AVERAGE-BANDWIDTH"],
        MAX_HLS_BANDWIDTH,
      );
      const bandwidth = boundedPositiveDecimalInteger(attributes.BANDWIDTH, MAX_HLS_BANDWIDTH);
      const frameRate = boundedPositiveDecimal(attributes["FRAME-RATE"], MAX_HLS_FRAME_RATE);
      if (!averageBandwidth.valid || !bandwidth.valid || bandwidth.value === null || !frameRate.valid) {
        continue;
      }
      let uriIndex = index + 1;
      while (uriIndex < lines.length && !lines[uriIndex]) uriIndex += 1;
      const nextUri = lines[uriIndex];
      if (!nextUri || nextUri.startsWith("#")) continue;
      const resolution = parseResolutionAttribute(attributes.RESOLUTION);
      let url = nextUri;
      try {
        url = new URL(nextUri, baseUrl).toString();
      } catch {
        url = nextUri;
      }
      const quality = resolution ? normalizeQualityLabel(attributes.RESOLUTION) : parseQualityFromUrl(url);
      variants.push({
        averageBandwidth: averageBandwidth.value,
        bandwidth: bandwidth.value,
        frameRate: frameRate.value,
        quality,
        resolution,
        url,
      });
    }
    return variants;
  }
  function variantScore(variant) {
    const height = variant?.resolution?.height ?? qualityNumber(variant?.quality) ?? 0;
    return {
      bitrate: variant?.averageBandwidth ?? variant?.bandwidth ?? 0,
      frameRate: variant?.frameRate ?? 0,
      height,
      peakBandwidth: variant?.bandwidth ?? 0,
    };
  }
  function chooseBestHlsVariant(
    playlistText,
    baseUrl = "",
    { excludedQualities = [], minRedirectQuality = "100p" } = {},
  ) {
    const min = qualityNumber(minRedirectQuality) ?? 0;
    const excluded = new Set(
      (Array.isArray(excludedQualities) ? excludedQualities : []).map(normalizeQualityLabel).filter(Boolean),
    );
    return (
      parseHlsMasterPlaylistVariants(playlistText, baseUrl)
        .filter((variant) => (variantScore(variant).height || 0) >= min)
        .filter((variant) => {
          const quality =
            normalizeQualityLabel(variant?.quality) ??
            (variant?.resolution?.height ? `${variant.resolution.height}p` : null);
          return !quality || !excluded.has(quality);
        })
        .map((variant, index) => ({ index, score: variantScore(variant), variant }))
        .sort(
          (left, right) =>
            right.score.height - left.score.height ||
            right.score.frameRate - left.score.frameRate ||
            right.score.bitrate - left.score.bitrate ||
            right.score.peakBandwidth - left.score.peakBandwidth ||
            left.index - right.index,
        )[0]?.variant ?? null
    );
  }
  function buildHighestQualityRedirectUrl(url, { targetQuality, minRedirectQuality = "100p" } = {}) {
    const currentQuality = qualityNumber(parseQualityFromUrl(url));
    const target = qualityNumber(targetQuality);
    const min = qualityNumber(minRedirectQuality);
    if (!currentQuality || !target || !min || currentQuality < min || currentQuality >= target) return null;
    return replaceQualityInUrl(url, targetQuality);
  }

  // src/shared/diagnostics.js
  var EPOCH_ISO = /* @__PURE__ */ new Date(0).toISOString();
  var HARD_MAX_DIAGNOSTIC_SAMPLES = 1e3;
  var MAX_DIAGNOSTIC_QUALITY_KEYS = 64;
  var MAX_DIAGNOSTIC_REASON_LENGTH = 64;
  var MAX_DIAGNOSTIC_TYPE_LENGTH = 32;
  var MAX_DIAGNOSTIC_URL_INPUT_LENGTH = 4096;
  function normalizedMaxSamples(value, fallback = 200) {
    const normalizedFallback =
      Number.isSafeInteger(fallback) && fallback > 0 ? Math.min(fallback, HARD_MAX_DIAGNOSTIC_SAMPLES) : 200;
    return Number.isSafeInteger(value) && value > 0
      ? Math.min(value, normalizedFallback)
      : normalizedFallback;
  }
  function normalizedCounter(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  function incrementCounter(value) {
    const normalized = normalizedCounter(value);
    return normalized >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : normalized + 1;
  }
  function normalizedQuality(value, { nullable = false } = {}) {
    if (nullable && value === null) return null;
    if (typeof value !== "string" || !/^\d{3,4}p$/i.test(value)) return void 0;
    return normalizeQualityLabel(value) ?? void 0;
  }
  function normalizedIsoTimestamp(value) {
    if (typeof value !== "string" || value.length > 40) return EPOCH_ISO;
    const timestamp = new Date(value);
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : EPOCH_ISO;
  }
  function normalizedTabId(value, { nullable = false } = {}) {
    if (nullable && value === null) return null;
    return Number.isSafeInteger(value) && value >= 0 ? value : void 0;
  }
  function normalizedType(value) {
    if (value === null) return null;
    return typeof value === "string" && value.length <= MAX_DIAGNOSTIC_TYPE_LENGTH ? value : void 0;
  }
  function normalizedDiagnosticUrl(value) {
    if (typeof value !== "string" || value.length > MAX_DIAGNOSTIC_URL_INPUT_LENGTH) return void 0;
    return redactMediaUrl(value);
  }
  function normalizedRuntimeError(value) {
    return typeof value === "string" && value.length > 0 ? "runtime-error" : null;
  }
  function normalizeSample(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const quality = normalizedQuality(value.quality);
    const tabId = normalizedTabId(value.tabId, { nullable: true });
    const type = normalizedType(value.type);
    const url = normalizedDiagnosticUrl(value.url);
    if (!quality || tabId === void 0 || type === void 0 || url === void 0) return null;
    const seenAt = normalizedIsoTimestamp(value.seenAt);
    if (seenAt === EPOCH_ISO && value.seenAt !== EPOCH_ISO) return null;
    return { quality, seenAt, tabId, type, url };
  }
  function normalizeDecision(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const quality = normalizedQuality(value.quality, { nullable: true });
    const targetQuality = normalizedQuality(value.targetQuality, { nullable: true });
    const tabId = normalizedTabId(value.tabId, { nullable: true });
    const type = normalizedType(value.type);
    const url = normalizedDiagnosticUrl(value.url);
    const seenAt = normalizedIsoTimestamp(value.seenAt);
    if (
      typeof value.ok !== "boolean" ||
      typeof value.redirectedCurrentRequest !== "boolean" ||
      quality === void 0 ||
      targetQuality === void 0 ||
      tabId === void 0 ||
      type === void 0 ||
      url === void 0 ||
      (seenAt === EPOCH_ISO && value.seenAt !== EPOCH_ISO) ||
      typeof value.reason !== "string" ||
      value.reason.length === 0 ||
      value.reason.length > MAX_DIAGNOSTIC_REASON_LENGTH
    ) {
      return null;
    }
    return {
      ok: value.ok,
      quality,
      reason: value.reason,
      redirectedCurrentRequest: value.redirectedCurrentRequest,
      seenAt,
      tabId,
      targetQuality,
      type,
      url,
    };
  }
  function normalizeQualityCounters(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const counters = {};
    for (const [rawQuality, rawCount] of Object.entries(value)) {
      if (Object.keys(counters).length >= MAX_DIAGNOSTIC_QUALITY_KEYS) break;
      const quality = normalizedQuality(rawQuality);
      if (!quality || normalizedCounter(rawCount) !== rawCount) continue;
      counters[quality] = rawCount;
    }
    return counters;
  }
  function normalizeActiveTabIds(value, maxSamples) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((tabId) => normalizedTabId(tabId) !== void 0))]
      .sort((left, right) => left - right)
      .slice(-maxSamples);
  }
  function normalizeTargetsByTab(value, maxSamples) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([tabId, quality]) => {
          const parsedTabId = Number(tabId);
          return (
            String(parsedTabId) === tabId &&
            normalizedTabId(parsedTabId) !== void 0 &&
            normalizedQuality(quality)
          );
        })
        .sort(([left], [right]) => Number(left) - Number(right))
        .slice(-maxSamples)
        .map(([tabId, quality]) => [tabId, normalizedQuality(quality)]),
    );
  }
  function normalizeDiagnostics(value, { maxSamples = 200 } = {}) {
    const policyMaxSamples = normalizedMaxSamples(maxSamples, HARD_MAX_DIAGNOSTIC_SAMPLES);
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const effectiveMaxSamples = normalizedMaxSamples(source.maxSamples, policyMaxSamples);
    const runtimeSource =
      source.runtimeRedirects &&
      typeof source.runtimeRedirects === "object" &&
      !Array.isArray(source.runtimeRedirects)
        ? source.runtimeRedirects
        : {};
    const lastError = normalizedRuntimeError(runtimeSource.lastError);
    return {
      decisions: (Array.isArray(source.decisions) ? source.decisions.slice(-effectiveMaxSamples) : [])
        .map(normalizeDecision)
        .filter(Boolean),
      generatedAt: normalizedIsoTimestamp(source.generatedAt),
      maxSamples: effectiveMaxSamples,
      qualities: normalizeQualityCounters(source.qualities),
      runtimeRedirects: {
        activeTabIds: normalizeActiveTabIds(runtimeSource.activeTabIds, effectiveMaxSamples),
        lastError,
        targetsByTab: normalizeTargetsByTab(runtimeSource.targetsByTab, effectiveMaxSamples),
        updatedAt: normalizedIsoTimestamp(runtimeSource.updatedAt),
      },
      samples: (Array.isArray(source.samples) ? source.samples.slice(-effectiveMaxSamples) : [])
        .map(normalizeSample)
        .filter(Boolean),
      totalHlsRequests: normalizedCounter(source.totalHlsRequests),
    };
  }
  function capList(list, maxItems) {
    if (list.length > maxItems) {
      list.splice(0, list.length - maxItems);
    }
  }
  function recordDiagnosticUrl(diagnostics, url, { context = {}, now = /* @__PURE__ */ new Date() } = {}) {
    if (!diagnostics || typeof url !== "string" || !/\.m3u8(?:[?#]|$)/i.test(url)) return false;
    const quality = parseQualityFromUrl(url);
    if (!quality) return false;
    const sample = normalizeSample({
      quality,
      seenAt: now.toISOString(),
      tabId: context.tabId ?? null,
      type: context.type ?? null,
      url,
    });
    if (!sample) return false;
    diagnostics.totalHlsRequests = incrementCounter(diagnostics.totalHlsRequests);
    if (
      !diagnostics.qualities ||
      typeof diagnostics.qualities !== "object" ||
      Array.isArray(diagnostics.qualities)
    ) {
      diagnostics.qualities = {};
    }
    diagnostics.qualities[quality] = incrementCounter(diagnostics.qualities[quality]);
    if (!Array.isArray(diagnostics.samples)) diagnostics.samples = [];
    diagnostics.samples.push(sample);
    capList(diagnostics.samples, normalizedMaxSamples(diagnostics.maxSamples, HARD_MAX_DIAGNOSTIC_SAMPLES));
    diagnostics.generatedAt = now.toISOString();
    return true;
  }
  function recordDecision(diagnostics, decision, details = {}, { now = /* @__PURE__ */ new Date() } = {}) {
    if (!diagnostics || !decision) return false;
    if (!Array.isArray(diagnostics.decisions)) diagnostics.decisions = [];
    const entry = normalizeDecision({
      ok: Boolean(decision.ok),
      quality: decision.quality ?? null,
      reason: decision.reason ?? "unknown",
      redirectedCurrentRequest: Boolean(decision.redirectedCurrentRequest),
      seenAt: now.toISOString(),
      tabId: decision.tabId ?? details.tabId ?? null,
      targetQuality: decision.targetQuality ?? null,
      type: details.type ?? null,
      url: details.url ?? "",
    });
    if (!entry) return false;
    diagnostics.decisions.push(entry);
    capList(diagnostics.decisions, normalizedMaxSamples(diagnostics.maxSamples, HARD_MAX_DIAGNOSTIC_SAMPLES));
    diagnostics.generatedAt = now.toISOString();
    return true;
  }
  function updateRuntimeRedirectDiagnostics(
    diagnostics,
    { activeTabIds = [], lastError = null, now = /* @__PURE__ */ new Date(), targetsByTab = {} } = {},
  ) {
    if (!diagnostics) return false;
    const maxSamples = normalizedMaxSamples(diagnostics.maxSamples, HARD_MAX_DIAGNOSTIC_SAMPLES);
    diagnostics.runtimeRedirects = {
      activeTabIds: normalizeActiveTabIds(activeTabIds, maxSamples),
      lastError: normalizedRuntimeError(lastError),
      targetsByTab: normalizeTargetsByTab(targetsByTab, maxSamples),
      updatedAt: now.toISOString(),
    };
    diagnostics.generatedAt = now.toISOString();
    return true;
  }

  // src/shared/playlist-evidence.js
  function isLikelyHlsPlaylist(text) {
    let source = String(text ?? "");
    if (source.charCodeAt(0) === 65279) source = source.slice(1);
    for (const line of source.split(/\r\n|[\r\n]/)) {
      const candidate = line.replace(/^[\t ]+|[\t ]+$/g, "");
      if (candidate === "") continue;
      return candidate === "#EXTM3U";
    }
    return false;
  }
  function isUtf8TextWithinByteLimit(text, maxBytes) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) return false;
    return new TextEncoder().encode(String(text ?? "")).byteLength <= maxBytes;
  }

  // src/shared/request-policy.js
  var DEFAULT_RESOURCE_TYPES = ["media", "other", "xmlhttprequest"];
  var DEFAULT_REQUEST_METHODS = ["get"];
  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }
  function isHttpsUrl(value) {
    if (typeof value !== "string" || value === "") return false;
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }
  function canonicalHttpsDomainFromUrl(value) {
    if (typeof value !== "string" || value === "") return null;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  function hasExplicitMetadataValue(value) {
    return value !== void 0 && value !== null;
  }
  function domainMatches(hostname, canonicalDomain) {
    return hostname === canonicalDomain || hostname.endsWith(`.${canonicalDomain}`);
  }
  function trustedInitiatorDomains(policy) {
    return asArray(policy.trustedInitiatorDomains).length > 0
      ? asArray(policy.trustedInitiatorDomains)
      : ["chzzk.naver.com"];
  }
  function trustedRequestDomains(policy) {
    return asArray(policy.trustedRequestDomains).length > 0
      ? asArray(policy.trustedRequestDomains)
      : ["akamaized.net", "chzzk.naver.com", "gscdn.net", "navercdn.com", "pstatic.net"];
  }
  function resourceTypes(policy) {
    return asArray(policy.resourceTypes).length > 0 ? asArray(policy.resourceTypes) : DEFAULT_RESOURCE_TYPES;
  }
  function requestMethods(policy) {
    return asArray(policy.requestMethods).length > 0
      ? asArray(policy.requestMethods)
      : DEFAULT_REQUEST_METHODS;
  }
  function isValidRedirectTabId(tabId) {
    return Number.isSafeInteger(tabId) && tabId >= 0;
  }
  function isTrustedRequestDomain(url, policy) {
    const hostname = canonicalHttpsDomainFromUrl(url);
    if (!hostname) return false;
    return trustedRequestDomains(policy).some((domain) => domainMatches(hostname, domain));
  }
  function isChzzkLiveUrl(url, policy) {
    if (typeof url !== "string" || url === "") return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      if (
        !trustedInitiatorDomains(policy).some((domain) =>
          domainMatches(parsed.hostname.toLowerCase(), domain),
        )
      ) {
        return false;
      }
      return parsed.pathname === "/live" || parsed.pathname.startsWith("/live/");
    } catch {
      return false;
    }
  }
  function isHlsPlaylistUrl(value) {
    if (typeof value !== "string" || value === "") return false;
    try {
      return /\.m3u8$/i.test(new URL(value).pathname);
    } catch {
      return false;
    }
  }
  function isNumericHlsPlaylistUrl(url) {
    return isHlsPlaylistUrl(url) && Boolean(parseQualityFromUrl(url));
  }
  function knownChzzkHlsHost(hostname) {
    const knownSuffixes = ["livecloud.pstatic.net.live.gscdn.net", "nvelop-livecloud.pstatic.net"];
    return knownSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  }
  function isDedicatedChzzkHlsUrl(url, policy) {
    return isNumericHlsPlaylistUrl(url) && isDedicatedChzzkHlsPlaylistUrl(url, policy);
  }
  function isDedicatedChzzkHlsPlaylistUrl(url, policy) {
    if (!isHlsPlaylistUrl(url) || !isTrustedRequestDomain(url, policy)) return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      return knownChzzkHlsHost(parsed.hostname.toLowerCase());
    } catch {
      return false;
    }
  }
  function trustedInitiatorUrl(value, policy) {
    const hostname = canonicalHttpsDomainFromUrl(value);
    return Boolean(
      hostname && trustedInitiatorDomains(policy).some((domain) => domainMatches(hostname, domain)),
    );
  }
  function metadataIncludesPageLocation(value) {
    try {
      const parsed = new URL(value);
      return parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "";
    } catch {
      return false;
    }
  }
  function requestContextEvidence(details, policy) {
    let ambiguousChzzkOrigin = false;
    let hasMetadata = false;
    let hasLivePageEvidence = false;
    let requiresDedicatedHls = false;
    let trusted = false;
    if (hasExplicitMetadataValue(details?.documentUrl)) {
      hasMetadata = true;
      if (isChzzkLiveUrl(details.documentUrl, policy)) {
        hasLivePageEvidence = true;
        trusted = true;
      } else if (trustedInitiatorUrl(details.documentUrl, policy)) {
        requiresDedicatedHls = true;
        trusted = true;
      } else {
        return { hasMetadata, trusted: false, veto: true };
      }
    }
    if (hasExplicitMetadataValue(details?.originUrl)) {
      hasMetadata = true;
      if (!trustedInitiatorUrl(details.originUrl, policy)) {
        return { hasMetadata, trusted: false, veto: true };
      }
      if (isChzzkLiveUrl(details.originUrl, policy)) {
        hasLivePageEvidence = true;
      } else if (metadataIncludesPageLocation(details.originUrl)) {
        requiresDedicatedHls = true;
      } else {
        ambiguousChzzkOrigin = true;
      }
      trusted = true;
    }
    if (hasExplicitMetadataValue(details?.initiator)) {
      hasMetadata = true;
      if (!trustedInitiatorUrl(details.initiator, policy)) {
        return { hasMetadata, trusted: false, veto: true };
      }
      if (isChzzkLiveUrl(details.initiator, policy)) {
        hasLivePageEvidence = true;
      } else if (metadataIncludesPageLocation(details.initiator)) {
        requiresDedicatedHls = true;
      } else {
        ambiguousChzzkOrigin = true;
      }
      trusted = true;
    }
    return {
      genericHlsRequiresLiveTab: ambiguousChzzkOrigin && !hasLivePageEvidence && !requiresDedicatedHls,
      hasMetadata,
      requiresDedicatedHls,
      trusted,
      veto: false,
    };
  }
  function contextRequiresDedicatedHls(evidence, tabId, trustedLiveTabIds) {
    return (
      evidence.requiresDedicatedHls ||
      (evidence.genericHlsRequiresLiveTab && !trustedLiveTabIds?.has?.(tabId))
    );
  }
  function hasContradictoryChzzkMetadata(details, policy) {
    return requestContextEvidence(details, policy).veto;
  }
  function hasTrustedChzzkMetadata(details, policy) {
    const evidence = requestContextEvidence(details, policy);
    return evidence.trusted && !evidence.veto;
  }
  function isTrustedChzzkContext(details, policy, { trustedLiveTabIds = null } = {}) {
    if (!details || !isValidRedirectTabId(details.tabId)) return false;
    const evidence = requestContextEvidence(details, policy);
    if (evidence.veto) return false;
    if (contextRequiresDedicatedHls(evidence, details.tabId, trustedLiveTabIds)) {
      return isDedicatedChzzkHlsUrl(details.url, policy);
    }
    if (evidence.trusted) return isNumericHlsPlaylistUrl(details.url);
    if (evidence.hasMetadata) return false;
    if (trustedLiveTabIds?.has?.(details.tabId)) return true;
    return isDedicatedChzzkHlsUrl(details.url, policy);
  }
  function isTrustedMasterPlaylistRequest(details, policy, { trustedLiveTabIds = null } = {}) {
    if (!details || !isValidRedirectTabId(details.tabId) || !isHttpsUrl(details.url)) return false;
    if (!isHlsPlaylistUrl(details.url) || parseQualityFromUrl(details.url)) return false;
    if (details.type && !resourceTypes(policy).includes(details.type)) return false;
    const method = String(details.method ?? "GET").toLowerCase();
    if (!requestMethods(policy).includes(method) || !isTrustedRequestDomain(details.url, policy))
      return false;
    const evidence = requestContextEvidence(details, policy);
    if (evidence.veto) return false;
    if (evidence.trusted) {
      return contextRequiresDedicatedHls(evidence, details.tabId, trustedLiveTabIds)
        ? isDedicatedChzzkHlsPlaylistUrl(details.url, policy)
        : true;
    }
    if (evidence.hasMetadata) return false;
    return Boolean(trustedLiveTabIds?.has?.(details.tabId));
  }
  function shouldRecordDiagnostics(details, policy, options = {}) {
    if (!isHttpsUrl(details?.url)) return false;
    if (!isHlsPlaylistUrl(details?.url)) return false;
    if (!isValidRedirectTabId(details.tabId)) return false;
    if (!isTrustedRequestDomain(details.url, policy)) return false;
    return isTrustedChzzkContext(details, policy, options);
  }
  function shouldRedirectRequest(details, policy, options = {}) {
    const tabId = details?.tabId;
    if (!isHttpsUrl(details?.url)) {
      return { ok: false, reason: "non-https-request-url", tabId: tabId ?? null };
    }
    if (!isValidRedirectTabId(tabId)) {
      return { ok: false, reason: "invalid-tab", tabId: tabId ?? null };
    }
    if (!isHlsPlaylistUrl(details.url)) {
      return { ok: false, reason: "non-playlist-path", tabId };
    }
    const allowedTypes = resourceTypes(policy);
    if (details.type && !allowedTypes.includes(details.type)) {
      return { ok: false, reason: "unsupported-resource-type", tabId };
    }
    const allowedMethods = requestMethods(policy);
    const method = String(details.method ?? "GET").toLowerCase();
    if (!allowedMethods.includes(method)) {
      return { ok: false, reason: "unsupported-request-method", tabId };
    }
    if (!isTrustedRequestDomain(details.url, policy)) {
      return { ok: false, reason: "untrusted-request-domain", tabId };
    }
    if (!isTrustedChzzkContext(details, policy, options)) {
      return { ok: false, reason: "untrusted-initiator", tabId };
    }
    const quality = parseQualityFromUrl(details.url);
    if (quality && !urlQualityMarkersAreSafe(details.url)) {
      return { ok: false, quality, reason: "contradictory-quality-markers", tabId };
    }
    const current = qualityNumber(quality);
    const min = qualityNumber(policy.minRedirectQuality ?? "100p");
    if (!quality || !current || !min) {
      return { ok: false, reason: "unknown-quality-shape", tabId };
    }
    if (current < min) {
      return { ok: false, quality, reason: "quality-below-minimum", tabId };
    }
    return { ok: true, quality, reason: "eligible-chzzk-hls-quality", tabId };
  }
  function configuredRequiredOrigins(policy) {
    return trustedRequestDomains(policy)
      .map((domain) => `https://*.${domain}/*`)
      .sort((left, right) => displayPermissionKey(left).localeCompare(displayPermissionKey(right), "en"));
  }
  function displayPermissionKey(permission) {
    return permission.replace(/^https:\/\/\*\./, "").replace(/^https:\/\//, "");
  }
  function configuredWebRequestUrls(policy) {
    return configuredRequiredOrigins(policy);
  }
  function configuredResourceTypes(policy) {
    return resourceTypes(policy);
  }

  // src/runtime/background.js
  var api = globalThis.browser ?? globalThis.chrome;
  var STORAGE_KEY = "chzzkDiagnostics";
  var WEB_REQUEST_URLS = configuredWebRequestUrls(quality_policy_default);
  var activeLiveTabIds = /* @__PURE__ */ new Set();
  var activeTargetsBySession = /* @__PURE__ */ new Map();
  var failedTargetsBySession = /* @__PURE__ */ new Map();
  var liveContextByTab = /* @__PURE__ */ new Map();
  var pendingTrustValidationByTab = /* @__PURE__ */ new Map();
  var redirectedRequestsById = /* @__PURE__ */ new Map();
  var resolutionBySession = /* @__PURE__ */ new Map();
  var tabContextTokenByTab = /* @__PURE__ */ new Map();
  var MAX_MARKER_EVIDENCE_TTL_MS = 3e4;
  var MAX_REDIRECT_FAILURE_BACKOFF_MS = 3e4;
  var MAX_TRACKED_REDIRECT_REQUESTS = 500;
  var diagnosticsMutationQueue = Promise.resolve();
  var diagnosticsMutationQueueDepth = 0;
  async function loadDiagnostics() {
    const stored = await api.storage.local.get(STORAGE_KEY);
    return normalizeDiagnostics(stored?.[STORAGE_KEY], {
      maxSamples: quality_policy_default.maxDiagnosticsSamples,
    });
  }
  async function saveDiagnostics(diagnostics) {
    const normalized = normalizeDiagnostics(diagnostics, {
      maxSamples: quality_policy_default.maxDiagnosticsSamples,
    });
    await api.storage.local.set({ [STORAGE_KEY]: normalized });
    return normalized;
  }
  async function mutateDiagnostics(mutator) {
    const diagnostics = await loadDiagnostics();
    const result = mutator(diagnostics);
    const savedDiagnostics = await saveDiagnostics(diagnostics);
    return { diagnostics: savedDiagnostics, result };
  }
  function diagnosticsQueueLimit() {
    const configured = Number(quality_policy_default.maxPendingDiagnosticsMutations ?? 50);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : 50;
  }
  async function enqueueDiagnosticsMutation(mutator) {
    if (diagnosticsMutationQueueDepth >= diagnosticsQueueLimit()) {
      return { diagnostics: null, dropped: true, result: false };
    }
    diagnosticsMutationQueueDepth += 1;
    const operation = diagnosticsMutationQueue
      .then(() => mutateDiagnostics(mutator))
      .finally(() => {
        diagnosticsMutationQueueDepth = Math.max(0, diagnosticsMutationQueueDepth - 1);
      });
    diagnosticsMutationQueue = operation.catch((error) => {
      console.warn("[CHZZK] diagnostics mutation failed", error);
    });
    return operation;
  }
  function currentRedirectState(lastError = null) {
    const targetsByTab = {};
    for (const state of activeTargetsBySession.values()) {
      if (state.expiresAt != null && state.expiresAt <= Date.now()) continue;
      const tabKey = String(state.tabId);
      const existing = targetsByTab[tabKey];
      if (!existing || (qualityNumber(state.targetQuality) ?? 0) > (qualityNumber(existing) ?? 0)) {
        targetsByTab[tabKey] = state.targetQuality;
      }
    }
    return {
      activeTabIds: [...activeLiveTabIds],
      lastError,
      targetsByTab,
    };
  }
  function activeTargetCoversObserved(state, observedQuality) {
    const activeTargetNumber = qualityNumber(state?.targetQuality);
    const observedNumber = qualityNumber(observedQuality);
    return Boolean(activeTargetNumber && observedNumber && activeTargetNumber >= observedNumber);
  }
  function resolvedTargetCoversObserved(state, observedQuality) {
    return Boolean(state?.resolved && activeTargetCoversObserved(state, observedQuality));
  }
  function probeTimeoutMs() {
    const configured = Number(quality_policy_default.probeTimeoutMs ?? 1500);
    return Number.isFinite(configured) && configured > 0 ? configured : 1500;
  }
  function blockingProbeBudgetMs() {
    const configured = Number(quality_policy_default.blockingProbeBudgetMs ?? 150);
    return Number.isFinite(configured) && configured > 0 ? configured : 150;
  }
  function probeResolutionBudgetMs() {
    const configured = Number(quality_policy_default.probeResolutionBudgetMs ?? 3e3);
    return Number.isFinite(configured) && configured > 0 ? configured : 3e3;
  }
  function probeMaxBytes() {
    const configured = Number(quality_policy_default.probeMaxBytes ?? 256e3);
    return Number.isFinite(configured) && configured > 0 ? configured : 256e3;
  }
  function markerEvidenceTtlMs() {
    const configured = Number(quality_policy_default.markerEvidenceTtlMs ?? 1e4);
    return Number.isSafeInteger(configured) && configured > 0
      ? Math.min(configured, MAX_MARKER_EVIDENCE_TTL_MS)
      : 1e4;
  }
  function redirectFailureBackoffMs() {
    const configured = Number(quality_policy_default.redirectFailureBackoffMs ?? 1e4);
    return Number.isSafeInteger(configured) && configured > 0
      ? Math.min(configured, MAX_REDIRECT_FAILURE_BACKOFF_MS)
      : 1e4;
  }
  function responseHeader(response, name) {
    return response?.headers?.get?.(name) ?? null;
  }
  function responseContentLength(response) {
    const value = Number(responseHeader(response, "content-length") ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  function hasRejectedPlaylistContentType(response) {
    const contentType = String(responseHeader(response, "content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    return (
      contentType === "application/json" ||
      contentType === "application/xhtml+xml" ||
      contentType === "text/html" ||
      contentType === "text/json" ||
      contentType.endsWith("+json")
    );
  }
  async function readResponseTextWithLimit(response, maxBytes) {
    const declaredLength = responseContentLength(response);
    if (declaredLength > maxBytes) return null;
    if (!response?.body?.getReader) {
      const text = String(await response.text());
      return isUtf8TextWithinByteLimit(text, maxBytes) ? text : null;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let totalBytes = 0;
    try {
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        if (done) break;
        const { value } = chunk;
        totalBytes += value.byteLength ?? value.length ?? 0;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join("");
    } catch {
      return null;
    }
  }
  async function fetchPlaylistEvidence(url, { signal = null } = {}) {
    if (!isTrustedRequestDomain(url, quality_policy_default)) return null;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener?.("abort", abortFromParent, { once: true });
    const timeout = setTimeout(() => controller.abort(), probeTimeoutMs());
    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      if (hasRejectedPlaylistContentType(response)) return null;
      const finalUrl = typeof response?.url === "string" && response.url ? response.url : url;
      if (!isTrustedRequestDomain(finalUrl, quality_policy_default) || finalUrl !== url) return null;
      const text = await readResponseTextWithLimit(response, probeMaxBytes());
      return isLikelyHlsPlaylist(text) ? { finalUrl, text } : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abortFromParent);
    }
  }
  function urlQualityMarkersMatch(url, expectedQuality) {
    const qualities = parseQualitiesFromUrl(url);
    return qualities.length > 0 && qualities.every((quality) => quality === expectedQuality);
  }
  function networkRequestUrl(url) {
    if (typeof url !== "string" || !url) return null;
    const fragmentIndex = url.indexOf("#");
    return fragmentIndex < 0 ? url : url.slice(0, fragmentIndex);
  }
  async function fetchSupportsExpectedQuality(url, expectedQuality, { signal = null } = {}) {
    const evidence = await fetchPlaylistEvidence(url, { signal });
    return playlistEvidenceSupportsExpectedQuality(evidence, expectedQuality);
  }
  function playlistEvidenceSupportsExpectedQuality(evidence, expectedQuality) {
    if (!evidence || !isLikelyHlsPlaylist(evidence.text)) return false;
    const variants = parseHlsMasterPlaylistVariants(evidence.text, evidence.finalUrl);
    if (variants.length > 0 || /#EXT-X-STREAM-INF:/i.test(evidence.text)) {
      return variants.some((variant) => {
        const variantQuality = bestVariantTargetQuality(variant);
        return (
          variantQuality === expectedQuality &&
          typeof variant.url === "string" &&
          isTrustedRequestDomain(variant.url, quality_policy_default) &&
          urlQualityMarkersMatch(variant.url, expectedQuality)
        );
      });
    }
    return urlQualityMarkersMatch(evidence.finalUrl, expectedQuality);
  }
  async function resolveHighestSupportedQuality(
    details,
    observedQuality,
    { signal = null, skipTargetQualities = /* @__PURE__ */ new Set() } = {},
  ) {
    const observedNumber = qualityNumber(observedQuality);
    if (!observedNumber) return null;
    const candidates = normalizeQualityCandidates(quality_policy_default.qualityCandidates, {
      include: [observedQuality],
      minRedirectQuality: quality_policy_default.minRedirectQuality,
    });
    for (const candidate of candidates) {
      if (signal?.aborted) return null;
      if (skipTargetQualities.has(candidate)) continue;
      const candidateNumber = qualityNumber(candidate);
      if (!candidateNumber || candidateNumber < observedNumber) continue;
      const candidateUrl = replaceQualityInUrl(details.url, candidate);
      if (!candidateUrl) continue;
      if (candidate === parseQualityFromUrl(details.url) || candidateUrl === details.url) {
        return { evidenceKind: "url-marker", targetQuality: candidate };
      }
      if (await fetchSupportsExpectedQuality(candidateUrl, candidate, { signal })) {
        return { evidenceKind: "url-marker", targetQuality: candidate };
      }
    }
    return signal?.aborted ? null : { evidenceKind: "url-marker", targetQuality: observedQuality };
  }
  function bestVariantTargetQuality(variant) {
    return variant?.quality ?? (variant?.resolution?.height ? `${variant.resolution.height}p` : null);
  }
  async function resolveBestVariantFromMaster(
    details,
    { signal = null, skipTargetQualities = /* @__PURE__ */ new Set() } = {},
  ) {
    const evidence = await fetchPlaylistEvidence(details.url, { signal });
    if (!evidence || signal?.aborted) return null;
    const variant = chooseBestHlsVariant(evidence.text, evidence.finalUrl, {
      excludedQualities: [...skipTargetQualities],
      minRedirectQuality: quality_policy_default.minRedirectQuality,
    });
    const targetQuality = bestVariantTargetQuality(variant);
    if (!variant?.url || !targetQuality || !isTrustedRequestDomain(variant.url, quality_policy_default))
      return null;
    if (!urlQualityMarkersMatch(variant.url, targetQuality)) return null;
    return { evidenceKind: "master", targetQuality };
  }
  async function updateRedirectDiagnostics(lastError = null) {
    await enqueueDiagnosticsMutation((diagnostics) => {
      updateRuntimeRedirectDiagnostics(diagnostics, currentRedirectState(lastError));
    });
  }
  async function reportRedirectError(error) {
    await updateRedirectDiagnostics(String(error?.message ?? error));
  }
  function scheduleRedirectDiagnostics(lastError = null) {
    updateRedirectDiagnostics(lastError).catch((error) =>
      console.warn("[CHZZK] failed to persist redirect diagnostics", error),
    );
  }
  function liveContextKey(url) {
    if (!isChzzkLiveUrl(url, quality_policy_default)) return null;
    try {
      const parsed = new URL(url);
      return parsed.pathname.replace(/\/+$/, "") || "/live";
    } catch {
      return null;
    }
  }
  function requestLiveContext(details) {
    return liveContextKey(details?.documentUrl) ?? liveContextKey(details?.originUrl);
  }
  function currentTabContextToken(tabId) {
    if (!tabContextTokenByTab.has(tabId)) tabContextTokenByTab.set(tabId, {});
    return tabContextTokenByTab.get(tabId);
  }
  function resolutionContextKey(details) {
    return (
      liveContextByTab.get(details.tabId) ??
      liveContextKey(details.documentUrl) ??
      liveContextKey(details.originUrl) ??
      "trusted-request"
    );
  }
  function playlistSession(details) {
    const familyKey = playlistFamilyKey(details?.url);
    if (!familyKey || !isValidRedirectTabId(details?.tabId)) return null;
    const contextKey = resolutionContextKey(details);
    const tabId = details.tabId;
    return {
      contextKey,
      familyKey,
      key: JSON.stringify([tabId, contextKey, familyKey]),
      tabId,
    };
  }
  function resolutionContextIsCurrent(tabId, contextKey) {
    const adoptedContext = liveContextByTab.get(tabId);
    return contextKey === "trusted-request" ? !adoptedContext : adoptedContext === contextKey;
  }
  function resolutionIsCurrent(state) {
    return (
      tabContextTokenByTab.get(state.tabId) === state.token &&
      resolutionBySession.get(state.key) === state &&
      resolutionContextIsCurrent(state.tabId, state.contextKey)
    );
  }
  function activeTargetForSession(session) {
    const state = activeTargetsBySession.get(session.key);
    if (!state) return null;
    if (state.expiresAt != null && state.expiresAt <= Date.now()) {
      activeTargetsBySession.delete(session.key);
      scheduleRedirectDiagnostics();
      return null;
    }
    return state;
  }
  function failedTargetsForSession(session) {
    const state = failedTargetsBySession.get(session.key);
    if (!state) return /* @__PURE__ */ new Set();
    const now = Date.now();
    for (const [quality, expiresAt] of state.targets) {
      if (expiresAt <= now) state.targets.delete(quality);
    }
    if (state.targets.size === 0) {
      failedTargetsBySession.delete(session.key);
      return /* @__PURE__ */ new Set();
    }
    return new Set(state.targets.keys());
  }
  async function setSessionTarget(session, resolution, token) {
    const targetQuality = resolution?.targetQuality;
    if (!targetQuality || tabContextTokenByTab.get(session.tabId) !== token) return false;
    if (!resolutionContextIsCurrent(session.tabId, session.contextKey)) return false;
    if (failedTargetsForSession(session).has(targetQuality)) return false;
    const previous = activeTargetsBySession.get(session.key);
    activeTargetsBySession.set(session.key, {
      ...session,
      evidenceKind: resolution.evidenceKind,
      expiresAt: resolution.evidenceKind === "url-marker" ? Date.now() + markerEvidenceTtlMs() : null,
      resolved: true,
      targetQuality,
    });
    if (previous?.targetQuality !== targetQuality || !previous?.resolved) scheduleRedirectDiagnostics();
    return true;
  }
  function invalidateSessionResolution(sessionKey) {
    const activeResolution = resolutionBySession.get(sessionKey);
    activeResolution?.controller.abort();
    resolutionBySession.delete(sessionKey);
  }
  function startSessionResolution(details, resolver, resolverKind) {
    const session = playlistSession(details);
    if (!session) return Promise.resolve(null);
    const token = currentTabContextToken(session.tabId);
    const existing = resolutionBySession.get(session.key);
    if (existing?.token === token) {
      if (resolverKind !== "master" || existing.resolverKind === "master") return existing.promise;
      invalidateSessionResolution(session.key);
    } else {
      existing?.controller.abort();
    }
    const controller = new AbortController();
    const resolutionTimeout = setTimeout(() => controller.abort(), probeResolutionBudgetMs());
    const state = { ...session, controller, promise: null, resolverKind, token };
    state.promise = Promise.resolve()
      .then(() =>
        resolver({
          signal: controller.signal,
          skipTargetQualities: failedTargetsForSession(session),
        }),
      )
      .then(async (resolution) => {
        if (!resolution?.targetQuality || !resolutionIsCurrent(state)) return null;
        const stored = await setSessionTarget(session, resolution, token);
        return stored ? resolution.targetQuality : null;
      })
      .catch((error) => {
        if (controller.signal.aborted) return null;
        throw error;
      })
      .finally(() => {
        clearTimeout(resolutionTimeout);
        if (resolutionBySession.get(session.key) === state) resolutionBySession.delete(session.key);
      });
    resolutionBySession.set(session.key, state);
    return state.promise;
  }
  async function waitForBlockingResolution(promise) {
    const timedOut = /* @__PURE__ */ Symbol("blocking-probe-timeout");
    let timeout;
    try {
      const result = await Promise.race([
        promise,
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(timedOut), blockingProbeBudgetMs());
        }),
      ]);
      return result === timedOut ? null : result;
    } finally {
      clearTimeout(timeout);
    }
  }
  function startHighestTargetResolution(details, decision) {
    return startSessionResolution(
      details,
      ({ signal, skipTargetQualities }) =>
        resolveHighestSupportedQuality(details, decision.quality, { signal, skipTargetQualities }),
      "numeric",
    );
  }
  function startMasterTargetResolution(details) {
    return startSessionResolution(
      details,
      ({ signal, skipTargetQualities }) =>
        resolveBestVariantFromMaster(details, { signal, skipTargetQualities }),
      "master",
    );
  }
  function tabHasQualityState(tabId) {
    return (
      [...activeTargetsBySession.values()].some((state) => state.tabId === tabId) ||
      [...resolutionBySession.values()].some((state) => state.tabId === tabId)
    );
  }
  function dropTabQualityState(tabId, { dropToken = false } = {}) {
    let hadTarget = false;
    for (const [key, state] of resolutionBySession) {
      if (state.tabId !== tabId) continue;
      state.controller.abort();
      resolutionBySession.delete(key);
    }
    for (const [key, state] of activeTargetsBySession) {
      if (state.tabId !== tabId) continue;
      hadTarget = true;
      activeTargetsBySession.delete(key);
    }
    for (const [key, state] of failedTargetsBySession) {
      if (state.tabId === tabId) failedTargetsBySession.delete(key);
    }
    for (const [requestId, state] of redirectedRequestsById) {
      if (state.tabId === tabId) {
        state.settled = true;
        redirectedRequestsById.delete(requestId);
      }
    }
    if (dropToken) {
      tabContextTokenByTab.delete(tabId);
    } else {
      tabContextTokenByTab.set(tabId, {});
    }
    return hadTarget;
  }
  function registerRequestContext(details) {
    const tabId = details?.tabId;
    if (!isValidRedirectTabId(tabId)) return false;
    if (hasContradictoryChzzkMetadata(details, quality_policy_default)) {
      removeTabTrustContext(tabId).catch((error) =>
        console.warn("[CHZZK] failed to clear contradicted tab trust", error),
      );
      return false;
    }
    const requestContext = requestLiveContext(details);
    if (!requestContext) return true;
    const knownContext = liveContextByTab.get(tabId);
    if (knownContext && knownContext !== requestContext) {
      removeTabTrustContext(tabId).catch((error) =>
        console.warn("[CHZZK] failed to clear mismatched live context", error),
      );
      return false;
    }
    if (!knownContext) {
      const hadUnboundState = tabHasQualityState(tabId);
      if (hadUnboundState) dropTabQualityState(tabId);
      currentTabContextToken(tabId);
      liveContextByTab.set(tabId, requestContext);
      activeLiveTabIds.add(tabId);
      if (hadUnboundState) scheduleRedirectDiagnostics();
    }
    return true;
  }
  async function prewarmLiveTab(tabId, url = null) {
    if (!isValidRedirectTabId(tabId)) return;
    currentTabContextToken(tabId);
    const nextContext = liveContextKey(url);
    const previousContext = liveContextByTab.get(tabId);
    const hasUnboundState =
      !previousContext &&
      ([...resolutionBySession.values()].some(
        (state) => state.tabId === tabId && state.contextKey === "trusted-request",
      ) ||
        [...activeTargetsBySession.values()].some(
          (state) => state.tabId === tabId && state.contextKey === "trusted-request",
        ));
    const contextChanged = Boolean(
      nextContext && ((previousContext && previousContext !== nextContext) || hasUnboundState),
    );
    const hadTarget = contextChanged ? dropTabQualityState(tabId) : false;
    if (nextContext) liveContextByTab.set(tabId, nextContext);
    const previousSize = activeLiveTabIds.size;
    activeLiveTabIds.add(tabId);
    if (hadTarget || activeLiveTabIds.size !== previousSize) await updateRedirectDiagnostics();
  }
  async function clearTabQualityState(tabId) {
    if (!isValidRedirectTabId(tabId)) return;
    if (dropTabQualityState(tabId)) await updateRedirectDiagnostics();
  }
  async function removeTabTrustContext(tabId) {
    if (!isValidRedirectTabId(tabId)) return;
    pendingTrustValidationByTab.delete(tabId);
    const hadTarget = dropTabQualityState(tabId, { dropToken: true });
    const hadLiveTab = activeLiveTabIds.delete(tabId);
    const hadContext = liveContextByTab.delete(tabId);
    if (hadTarget || hadLiveTab || hadContext) await updateRedirectDiagnostics();
  }
  async function clearRuntimeRedirectState() {
    for (const state of resolutionBySession.values()) state.controller.abort();
    activeLiveTabIds.clear();
    activeTargetsBySession.clear();
    failedTargetsBySession.clear();
    liveContextByTab.clear();
    pendingTrustValidationByTab.clear();
    redirectedRequestsById.clear();
    resolutionBySession.clear();
    tabContextTokenByTab.clear();
    await updateRedirectDiagnostics();
  }
  function startReloadTrustValidation(tabId) {
    if (!isValidRedirectTabId(tabId) || typeof api.tabs?.get !== "function") return null;
    const validation = { promise: null };
    pendingTrustValidationByTab.set(tabId, validation);
    validation.promise = Promise.resolve()
      .then(() => api.tabs.get(tabId))
      .then(async (tab) => {
        if (pendingTrustValidationByTab.get(tabId) !== validation) return false;
        if (tab?.id === tabId && isChzzkLiveUrl(tab.url, quality_policy_default)) {
          await prewarmLiveTab(tabId, tab.url);
          return pendingTrustValidationByTab.get(tabId) === validation;
        }
        await removeTabTrustContext(tabId);
        return false;
      })
      .catch(async () => {
        if (pendingTrustValidationByTab.get(tabId) === validation) {
          await removeTabTrustContext(tabId);
        }
        return false;
      })
      .finally(() => {
        if (pendingTrustValidationByTab.get(tabId) === validation) {
          pendingTrustValidationByTab.delete(tabId);
        }
      });
    return validation.promise;
  }
  async function awaitPendingTrustValidation(tabId) {
    const validation = pendingTrustValidationByTab.get(tabId);
    if (!validation?.promise) return true;
    const timedOut = /* @__PURE__ */ Symbol("tab-trust-validation-timeout");
    let timeout;
    try {
      const result = await Promise.race([
        validation.promise,
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(timedOut), blockingProbeBudgetMs());
        }),
      ]);
      return result !== timedOut && result === true;
    } finally {
      clearTimeout(timeout);
    }
  }
  function settleRedirectedRequest(record) {
    if (record.settled) return;
    const statusCode = record.statusCode;
    if (record.networkFailed) {
      record.settled = true;
      invalidateRedirectedTarget(record);
      return;
    }
    if (!Number.isSafeInteger(statusCode)) return;
    if (statusCode === 304) {
      if (record.bodyEvidence === "pending") return;
      record.settled = true;
      if (redirectedRequestsById.get(record.requestId) === record) {
        redirectedRequestsById.delete(record.requestId);
      }
      if (record.bodyEvidence === "empty" || record.bodyEvidence === "valid") {
        renewSuccessfulRedirectTarget(record);
      } else if (record.bodyEvidence !== "unavailable") {
        invalidateRedirectedTarget(record);
      }
      return;
    }
    const statusFailed =
      statusCode === 204 ||
      statusCode === 205 ||
      (statusCode >= 300 && statusCode <= 399) ||
      (statusCode >= 400 && statusCode <= 599);
    if (statusFailed || record.bodyEvidence === "empty" || record.bodyEvidence === "invalid") {
      record.settled = true;
      invalidateRedirectedTarget(record);
      return;
    }
    if (statusCode < 200 || statusCode > 299) return;
    if (record.bodyEvidence === "pending") return;
    record.settled = true;
    if (redirectedRequestsById.get(record.requestId) === record) {
      redirectedRequestsById.delete(record.requestId);
    }
    if (record.bodyEvidence === "valid") renewSuccessfulRedirectTarget(record);
  }
  function attachRedirectBodyVerifier(record) {
    if (typeof api.webRequest.filterResponseData !== "function") return;
    let filter;
    try {
      filter = api.webRequest.filterResponseData(record.requestId);
    } catch {
      return;
    }
    record.bodyEvidence = "pending";
    record.bodyVerificationFailed = false;
    const chunks = [];
    let totalBytes = 0;
    let oversized = false;
    filter.ondata = (event) => {
      try {
        filter.write(event.data);
        const bytes = new Uint8Array(event.data);
        if (!oversized) {
          totalBytes += bytes.byteLength;
          if (totalBytes <= probeMaxBytes()) chunks.push(bytes.slice());
          else {
            oversized = true;
            chunks.length = 0;
          }
        }
      } catch {
        record.bodyVerificationFailed = true;
        record.bodyEvidence = "invalid";
        settleRedirectedRequest(record);
      }
    };
    filter.onstop = () => {
      try {
        filter.close();
        if (record.bodyVerificationFailed || oversized) {
          record.bodyEvidence = "invalid";
        } else if (totalBytes === 0) {
          record.bodyEvidence = "empty";
        } else {
          const body = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const text = new TextDecoder().decode(body);
          record.bodyEvidence = playlistEvidenceSupportsExpectedQuality(
            { finalUrl: record.redirectNetworkUrl, text },
            record.targetQuality,
          )
            ? "valid"
            : "invalid";
        }
      } catch {
        record.bodyEvidence = "invalid";
      }
      settleRedirectedRequest(record);
    };
    filter.onerror = () => {
      record.bodyVerificationFailed = true;
      record.bodyEvidence = "invalid";
      settleRedirectedRequest(record);
    };
  }
  function attachPendingRedirectBodyVerifier(details) {
    const requestId = details?.requestId == null ? null : String(details.requestId);
    if (!requestId) return;
    const record = redirectedRequestsById.get(requestId);
    if (
      !record ||
      record.settled ||
      record.bodyEvidence !== "unavailable" ||
      networkRequestUrl(details.url) !== record.redirectNetworkUrl
    ) {
      return;
    }
    attachRedirectBodyVerifier(record);
  }
  function rememberRedirectedRequest(details, session, targetQuality, redirectUrl) {
    if (details?.requestId == null || !session || !targetQuality || !redirectUrl) return;
    const requestId = String(details.requestId);
    const redirectNetworkUrl = networkRequestUrl(redirectUrl);
    if (requestId === "" || requestId.length > 128 || !redirectNetworkUrl) return;
    const replacedRecord = redirectedRequestsById.get(requestId);
    if (replacedRecord) replacedRecord.settled = true;
    redirectedRequestsById.delete(requestId);
    const record = {
      ...session,
      bodyEvidence: "unavailable",
      bodyVerificationFailed: false,
      networkFailed: false,
      redirectNetworkUrl,
      redirectUrl,
      requestId,
      settled: false,
      statusCode: null,
      targetQuality,
    };
    redirectedRequestsById.set(requestId, record);
    while (redirectedRequestsById.size > MAX_TRACKED_REDIRECT_REQUESTS) {
      const oldestRequestId = redirectedRequestsById.keys().next().value;
      const oldestRecord = redirectedRequestsById.get(oldestRequestId);
      if (oldestRecord) oldestRecord.settled = true;
      redirectedRequestsById.delete(oldestRequestId);
    }
  }
  function invalidateRedirectedTarget(record) {
    const current = activeTargetsBySession.get(record.key);
    if (current?.targetQuality === record.targetQuality) activeTargetsBySession.delete(record.key);
    invalidateSessionResolution(record.key);
    const failures = failedTargetsBySession.get(record.key) ?? {
      ...record,
      targets: /* @__PURE__ */ new Map(),
    };
    failures.targets.set(record.targetQuality, Date.now() + redirectFailureBackoffMs());
    failedTargetsBySession.set(record.key, failures);
    for (const [requestId, pending] of redirectedRequestsById) {
      if (pending.key === record.key && pending.targetQuality === record.targetQuality) {
        pending.settled = true;
        redirectedRequestsById.delete(requestId);
      }
    }
    scheduleRedirectDiagnostics();
  }
  function renewSuccessfulRedirectTarget(record) {
    const current = activeTargetsBySession.get(record.key);
    if (
      current?.targetQuality !== record.targetQuality ||
      current.evidenceKind !== "url-marker" ||
      !resolutionContextIsCurrent(record.tabId, record.contextKey)
    ) {
      return;
    }
    current.expiresAt = Date.now() + markerEvidenceTtlMs();
  }
  function handleRedirectCompleted(details) {
    const requestId = details?.requestId == null ? null : String(details.requestId);
    if (!requestId) return;
    const record = redirectedRequestsById.get(requestId);
    if (!record) return;
    const statusCode = Number(details.statusCode);
    record.statusCode = statusCode;
    if (networkRequestUrl(details.url) !== record.redirectNetworkUrl) {
      record.bodyEvidence = "invalid";
    }
    settleRedirectedRequest(record);
  }
  function handleRedirectError(details) {
    const requestId = details?.requestId == null ? null : String(details.requestId);
    if (!requestId) return;
    const record = redirectedRequestsById.get(requestId);
    if (!record) return;
    record.networkFailed = true;
    settleRedirectedRequest(record);
  }
  async function recordRequestDiagnostics(details, decision) {
    await enqueueDiagnosticsMutation((current) => {
      recordDiagnosticUrl(current, details.url, { context: details });
      recordDecision(current, decision, details);
    });
  }
  async function handleRequest(details) {
    attachPendingRedirectBodyVerifier(details);
    if (!registerRequestContext(details)) return void 0;
    if (hasTrustedChzzkMetadata(details, quality_policy_default)) {
      if (isChzzkLiveUrl(details.documentUrl, quality_policy_default)) {
        pendingTrustValidationByTab.delete(details.tabId);
      }
    } else if (!(await awaitPendingTrustValidation(details?.tabId))) {
      return void 0;
    }
    const redirectOptions = { trustedLiveTabIds: activeLiveTabIds };
    const shouldRecord = shouldRecordDiagnostics(details, quality_policy_default, redirectOptions);
    let decision = shouldRedirectRequest(details, quality_policy_default, redirectOptions);
    let redirectUrl = null;
    if (decision.ok) {
      try {
        const session = playlistSession(details);
        let targetState = session ? activeTargetForSession(session) : null;
        let targetQuality = targetState?.targetQuality ?? null;
        if (!targetQuality) {
          targetQuality = await waitForBlockingResolution(startHighestTargetResolution(details, decision));
          targetState = session ? activeTargetForSession(session) : null;
        } else if (!resolvedTargetCoversObserved(targetState, decision.quality)) {
          startHighestTargetResolution(details, decision).catch((error) => {
            reportRedirectError(error).catch(() => {});
            console.warn("[CHZZK] failed to resolve highest trusted HLS playlist quality", error);
          });
        }
        if (!redirectUrl && targetQuality) {
          redirectUrl = buildHighestQualityRedirectUrl(details.url, {
            minRedirectQuality: quality_policy_default.minRedirectQuality,
            targetQuality,
          });
        }
        if (targetQuality) {
          decision = { ...decision, redirectedCurrentRequest: Boolean(redirectUrl), targetQuality };
        }
        if (redirectUrl) rememberRedirectedRequest(details, session, targetQuality, redirectUrl);
      } catch (error) {
        scheduleRedirectDiagnostics(String(error?.message ?? error));
        console.warn("[CHZZK] failed to redirect trusted HLS playlist request", error);
      }
    } else if (isTrustedMasterPlaylistRequest(details, quality_policy_default, redirectOptions)) {
      startMasterTargetResolution(details).catch((error) => {
        reportRedirectError(error).catch(() => {});
        console.warn("[CHZZK] failed to score trusted HLS master playlist", error);
      });
    }
    if (shouldRecord) {
      recordRequestDiagnostics(details, decision).catch((error) =>
        console.warn("[CHZZK] diagnostics recording failed", error),
      );
    }
    return redirectUrl ? { redirectUrl } : void 0;
  }
  var WEB_REQUEST_FILTER = {
    urls: WEB_REQUEST_URLS,
    types: configuredResourceTypes(quality_policy_default),
  };
  api.webRequest.onBeforeRequest.addListener(
    (details) =>
      handleRequest(details).catch((error) => {
        console.warn("[CHZZK] diagnostics/redirect handling failed", error);
        return void 0;
      }),
    WEB_REQUEST_FILTER,
    ["blocking"],
  );
  api.webRequest.onCompleted?.addListener(handleRedirectCompleted, WEB_REQUEST_FILTER);
  api.webRequest.onErrorOccurred?.addListener(handleRedirectError, WEB_REQUEST_FILTER);
  async function prewarmMessageTab(tabId) {
    if (!isValidRedirectTabId(tabId) || typeof api.tabs?.get !== "function") return;
    const currentTab = await api.tabs.get(tabId);
    if (currentTab?.id !== tabId || !isChzzkLiveUrl(currentTab.url, quality_policy_default)) return;
    pendingTrustValidationByTab.delete(tabId);
    await prewarmLiveTab(tabId, currentTab.url);
  }
  api.runtime.onMessage?.addListener((message, sender) => {
    if (message?.type !== "chzzk.live-page-ready") return void 0;
    const tabId = sender?.tab?.id;
    if (!isValidRedirectTabId(tabId)) return void 0;
    prewarmMessageTab(tabId).catch((error) =>
      console.warn("[CHZZK] failed to validate and prewarm live tab", error),
    );
    return void 0;
  });
  function liveTabQueryUrls() {
    return (
      quality_policy_default.trustedInitiatorDomains?.length
        ? quality_policy_default.trustedInitiatorDomains
        : ["chzzk.naver.com"]
    )
      .map((domain) => `https://*.${domain}/live/*`)
      .sort();
  }
  async function prewarmExistingLiveTabs() {
    if (typeof api.tabs?.query !== "function") return;
    const tabs = await api.tabs.query({ url: liveTabQueryUrls() });
    await Promise.all(tabs.map((tab) => prewarmLiveTab(tab?.id, tab?.url)));
  }
  async function resetAndPrewarmRuntimeState() {
    await Promise.all([
      clearRuntimeRedirectState().catch((error) =>
        console.warn("[CHZZK] failed to persist startup redirect cleanup", error),
      ),
      prewarmExistingLiveTabs(),
    ]);
  }
  api.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo?.status === "loading") {
      clearTabQualityState(tabId).catch((error) =>
        console.warn("[CHZZK] failed to clear tab quality state for document load", error),
      );
      if (!changeInfo?.url) {
        startReloadTrustValidation(tabId)?.catch((error) =>
          console.warn("[CHZZK] failed to validate tab trust after document load", error),
        );
        return;
      }
    }
    if (!changeInfo?.url) return;
    pendingTrustValidationByTab.delete(tabId);
    if (isChzzkLiveUrl(changeInfo.url, quality_policy_default)) {
      prewarmLiveTab(tabId, changeInfo.url).catch((error) =>
        console.warn("[CHZZK] failed to prewarm live tab from URL update", error),
      );
      return;
    }
    removeTabTrustContext(tabId).catch((error) =>
      console.warn("[CHZZK] failed to clear tab trust context", error),
    );
  });
  api.tabs?.onRemoved?.addListener((tabId) => {
    removeTabTrustContext(tabId).catch((error) =>
      console.warn("[CHZZK] failed to remove tab trust context", error),
    );
  });
  api.runtime.onInstalled?.addListener(() => {
    resetAndPrewarmRuntimeState().catch((error) => console.warn("[CHZZK] startup cleanup failed", error));
  });
  api.runtime.onStartup?.addListener(() => {
    resetAndPrewarmRuntimeState().catch((error) => console.warn("[CHZZK] startup cleanup failed", error));
  });
})();
