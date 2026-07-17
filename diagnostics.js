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
      "Firefox MV2 declares CHZZK and trusted HLS CDN origins as required permissions so core site access is granted at install time instead of exposed as optional MV3 site toggles.",
      "A minimal MV2 content script runs at document_start on CHZZK live pages only and sends a live-page-ready message; it does not query or mutate the page DOM.",
      "The persistent background page uses blocking webRequest, but an unresolved candidate search can delay a request only for blockingProbeBudgetMs before failing open while one shared per-tab/live-context/playlist-family resolution continues in the background.",
      "A trusted HLS master playlist starts non-blocking scoring by resolution, frame rate, then bitrate; the resolved target is cached only while the tab/context token and secret-free playlist family are current.",
      "Numeric quality replacement changes safe pathname markers only, preserves the observed 360p-directory/chunklist_480p legacy shape, rejects other marker contradictions, and preserves signed query strings and fragments byte-for-byte.",
      "Without a cached target, configured candidates are checked from highest to lowest within probeResolutionBudgetMs; only concurrent requests in the same playlist family share an in-flight resolution.",
      "URL-marker-only media evidence expires after markerEvidenceTtlMs, and redirect failures suppress the failed family target for redirectFailureBackoffMs before it may be considered again.",
      "The generated quality regex matches numeric qualities lower than the resolved family target; it does not enumerate only today's menu values.",
      "CHZZK livecloud playlist hosts may resolve/use GSCdn; keep gscdn.net covered for HLS playlist requests.",
      "Request URL, initiator, method, resource type, trusted request domain, and CHZZK live context constrain redirects; explicit foreign metadata vetoes cache, and metadata-free contextless compatibility is limited to the two dedicated CHZZK livecloud host suffixes rather than generic CDN path markers.",
      "Prewarm marks the CHZZK live tab only; it is a supporting signal, not the sole gate. The runtime resolves the best actually available HLS variant from trusted playlist evidence instead of seeding a fixed startup quality.",
      "Candidate probes reject redirects because Firefox does not expose manual redirect hops; bodies require an exact first meaningful EXTM3U line, reject obvious HTML/JSON types, are capped by probeMaxBytes in UTF-8 bytes, and must prove the requested candidate before seeding a target.",
      "Same-URL reload clears quality state separately from authoritatively validated tab trust; navigation and tab close abort pending probes and invalidate their context token so stale completions cannot restore a target.",
      "Diagnostics use an exact bounded schema with saturating non-negative safe-integer counters and canonical allowlist domain labels that discard subdomains and ports.",
    ],
  };

  // src/shared/quality.js
  var QUALITY_PATH_MARKER_SOURCE = String.raw`(?:chunklist_|\/)(\d{3,4}p)(?=(?:[_-][^/]*)?\.m3u8$|\/)`;
  var RESOLUTION_RE = /(?:RESOLUTION=|^)(\d{3,5})x(\d{3,5})(?:[,\s]|$)/i;
  var TEXT_QUALITY_RE = /(?:^|[^0-9])(\d{3,4})\s*p(?:[^0-9]|$)/i;
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

  // src/runtime/diagnostics-page.js
  var api = globalThis.browser ?? globalThis.chrome;
  var STORAGE_KEY = "chzzkDiagnostics";
  var summary = document.querySelector("#summary");
  var payload = document.querySelector("#payload");
  var NORMALIZATION_OPTIONS = { maxSamples: quality_policy_default.maxDiagnosticsSamples };
  async function loadDiagnostics() {
    const stored = await api.storage.local.get(STORAGE_KEY);
    return normalizeDiagnostics(stored?.[STORAGE_KEY], NORMALIZATION_OPTIONS);
  }
  function renderQualitySummary(diagnostics) {
    return Object.entries(diagnostics.qualities ?? {})
      .sort(([a], [b]) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
      .map(([quality, count]) => `${quality}: ${count}`)
      .join("\n");
  }
  function renderTargetSummary(runtimeRedirects) {
    const targets = Object.entries(runtimeRedirects.targetsByTab ?? {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([tabId, target]) => `${tabId}:${target}`);
    return targets.join(", ") || "none";
  }
  function render(value) {
    const diagnostics = normalizeDiagnostics(value, NORMALIZATION_OPTIONS);
    const runtimeRedirects = diagnostics.runtimeRedirects;
    const decisions = diagnostics.decisions;
    const lastDecision = decisions.at(-1);
    const qualities = renderQualitySummary(diagnostics);
    summary.textContent = [
      `generatedAt: ${diagnostics.generatedAt}`,
      `totalHlsRequests: ${diagnostics.totalHlsRequests ?? 0}`,
      `activeTabIds: ${(runtimeRedirects.activeTabIds ?? []).join(", ") || "none"}`,
      `targetsByTab: ${renderTargetSummary(runtimeRedirects)}`,
      `runtimeRedirectsUpdatedAt: ${runtimeRedirects.updatedAt}`,
      `lastRuntimeRedirectError: ${runtimeRedirects.lastError ?? "none"}`,
      lastDecision
        ? `lastDecision: ${lastDecision.ok ? "ok" : "blocked"} / ${lastDecision.reason} / tab ${lastDecision.tabId ?? "n/a"}`
        : "lastDecision: none",
      "",
      qualities || "qualities: none",
    ].join("\n");
    payload.value = JSON.stringify(diagnostics, null, 2);
  }
  async function refresh() {
    render(await loadDiagnostics());
  }
  document.querySelector("#refresh").addEventListener("click", refresh);
  document.querySelector("#copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(payload.value);
  });
  document.querySelector("#clear").addEventListener("click", async () => {
    await api.storage.local.remove(STORAGE_KEY);
    await refresh();
  });
  refresh().catch((error) => {
    summary.textContent = String(error?.stack ?? error);
  });
})();
