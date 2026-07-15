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
    probeMaxBytes: 256e3,
    probeResolutionBudgetMs: 3e3,
    probeTimeoutMs: 1500,
    notes: [
      "Firefox MV2 declares CHZZK and trusted HLS CDN origins as required permissions so core site access is granted at install time instead of exposed as optional MV3 site toggles.",
      "A minimal MV2 content script runs at document_start on CHZZK live pages only and sends a live-page-ready message; it does not query or mutate the page DOM.",
      "The persistent background page uses blocking webRequest, but an unresolved candidate search can delay a request only for blockingProbeBudgetMs before failing open while one shared per-tab/context resolution continues in the background.",
      "A trusted HLS master playlist starts non-blocking scoring by resolution, frame rate, then bitrate; the resolved target is cached only while the tab/context token is current.",
      "Numeric quality replacement changes pathname markers only and preserves signed query strings and fragments byte-for-byte.",
      "Without a cached target, configured candidates are checked from highest to lowest within probeResolutionBudgetMs; concurrent requests share the same in-flight resolution.",
      "The generated quality regex matches numeric qualities lower than the resolved per-tab target; it does not enumerate only today's menu values.",
      "CHZZK livecloud playlist hosts may resolve/use GSCdn; keep gscdn.net covered for HLS playlist requests.",
      "Request URL, initiator, method, resource type, trusted request domain, CHZZK live context, and known CHZZK/livecloud HLS URL shape constrain redirects; CHZZK-originated or CHZZK-marked numeric playlist URLs are covered even when Firefox omits page request metadata.",
      "Prewarm marks the CHZZK live tab only; it is a supporting signal, not the sole gate. The runtime resolves the best actually available HLS variant from trusted playlist evidence instead of seeding a fixed startup quality.",
      "Candidate probes reject redirects because Firefox does not expose manual redirect hops; bodies are capped by probeMaxBytes, and numeric/master evidence must prove the requested candidate before it can seed a target.",
      "Navigation and tab close abort pending probes and invalidate their context token before clearing state so stale completions cannot restore a target.",
    ],
  };

  // src/shared/quality.js
  var QUALITY_LABEL_RE = /^(\d{3,4})p$/i;
  var DEFAULT_QUALITY_CANDIDATES = ["2160p", "1440p", "1080p", "720p", "480p", "360p", "270p", "144p"];
  var QUALITY_PATH_MARKER_SOURCE = String.raw`(?:chunklist_|\/)(\d{3,4}p)(?=(?:[_-][^/]*)?\.m3u8$|\/)`;
  var RESOLUTION_RE = /(?:RESOLUTION=|^)(\d{3,5})x(\d{3,5})(?:[,\s]|$)/i;
  var TEXT_QUALITY_RE = /(?:^|[^0-9])(\d{3,4})\s*p(?:[^0-9]|$)/i;
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
  function redactMediaUrl(url) {
    if (typeof url !== "string" || url === "") return "";
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return "[redacted-url]";
      const quality = parseQualityFromUrl(url);
      const isPlaylist = /\.m3u8$/i.test(parsed.pathname);
      const mediaShape = isPlaylist ? `/${quality ?? "playlist"}.m3u8` : quality ? `/${quality}` : "";
      const hadSensitiveTail = Boolean(parsed.search || parsed.hash);
      return `${parsed.protocol}//${parsed.host}/[redacted-path]${mediaShape}${hadSensitiveTail ? "?[redacted]" : ""}`;
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
    if (typeof url !== "string" || !normalizedTarget || !target || !currentQuality) return null;
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
    return replacedAny ? `${urlParts[1]}${replacedPath}${urlParts[3] ?? ""}` : null;
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
    if (current) result.push(current);
    return result;
  }
  function parseHlsAttributeList(value) {
    return Object.fromEntries(
      splitHlsAttributeList(value)
        .map((entry) => {
          const separator = entry.indexOf("=");
          if (separator === -1) return null;
          const key = entry.slice(0, separator).trim().toUpperCase();
          const rawValue = entry
            .slice(separator + 1)
            .trim()
            .replace(/^"|"$/g, "");
          return key ? [key, rawValue] : null;
        })
        .filter(Boolean),
    );
  }
  function numericAttribute(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
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
        averageBandwidth: numericAttribute(attributes["AVERAGE-BANDWIDTH"]),
        bandwidth: numericAttribute(attributes.BANDWIDTH),
        frameRate: numericAttribute(attributes["FRAME-RATE"]),
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
  function chooseBestHlsVariant(playlistText, baseUrl = "", { minRedirectQuality = "100p" } = {}) {
    const min = qualityNumber(minRedirectQuality) ?? 0;
    return (
      parseHlsMasterPlaylistVariants(playlistText, baseUrl)
        .filter((variant) => (variantScore(variant).height || 0) >= min)
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
  function createEmptyDiagnostics({ maxSamples = 200 } = {}) {
    return {
      decisions: [],
      generatedAt: /* @__PURE__ */ new Date(0).toISOString(),
      maxSamples,
      qualities: {},
      runtimeRedirects: {
        activeTabIds: [],
        lastError: null,
        targetsByTab: {},
        updatedAt: /* @__PURE__ */ new Date(0).toISOString(),
      },
      samples: [],
      totalHlsRequests: 0,
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
    diagnostics.totalHlsRequests = (diagnostics.totalHlsRequests ?? 0) + 1;
    diagnostics.qualities ??= {};
    diagnostics.qualities[quality] = (diagnostics.qualities[quality] ?? 0) + 1;
    diagnostics.samples ??= [];
    diagnostics.samples.push({
      quality,
      seenAt: now.toISOString(),
      tabId: context.tabId ?? null,
      type: context.type ?? null,
      url: redactMediaUrl(url),
    });
    capList(diagnostics.samples, diagnostics.maxSamples ?? 200);
    diagnostics.generatedAt = now.toISOString();
    return true;
  }
  function recordDecision(diagnostics, decision, details = {}, { now = /* @__PURE__ */ new Date() } = {}) {
    if (!diagnostics || !decision) return false;
    diagnostics.decisions ??= [];
    diagnostics.decisions.push({
      ok: Boolean(decision.ok),
      quality: decision.quality ?? null,
      reason: decision.reason ?? "unknown",
      redirectedCurrentRequest: Boolean(decision.redirectedCurrentRequest),
      seenAt: now.toISOString(),
      tabId: decision.tabId ?? details.tabId ?? null,
      targetQuality: decision.targetQuality ?? null,
      type: details.type ?? null,
      url: redactMediaUrl(details.url ?? ""),
    });
    capList(diagnostics.decisions, diagnostics.maxSamples ?? 200);
    diagnostics.generatedAt = now.toISOString();
    return true;
  }
  function updateRuntimeRedirectDiagnostics(
    diagnostics,
    { activeTabIds = [], lastError = null, now = /* @__PURE__ */ new Date(), targetsByTab = {} } = {},
  ) {
    if (!diagnostics) return false;
    diagnostics.runtimeRedirects = {
      activeTabIds: [...activeTabIds].sort((a, b) => a - b),
      lastError,
      targetsByTab: Object.fromEntries(
        Object.entries(targetsByTab).sort(([left], [right]) => Number(left) - Number(right)),
      ),
      updatedAt: now.toISOString(),
    };
    diagnostics.generatedAt = now.toISOString();
    return true;
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
  function knownChzzkHlsPath(pathname) {
    const normalized = String(pathname ?? "").toLowerCase();
    if (!/(^|\/)chzzk(\/|$)/.test(normalized)) return false;
    return /(?:^|\/)\d{3,4}p(?:\/|$)/.test(normalized) || /(?:^|\/)chunklist_\d{3,4}p/i.test(normalized);
  }
  function isKnownChzzkHlsUrl(url, policy) {
    if (!isNumericHlsPlaylistUrl(url) || !isTrustedRequestDomain(url, policy)) return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      const hostname = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      if (trustedInitiatorDomains(policy).some((domain) => domainMatches(hostname, domain))) return true;
      if (knownChzzkHlsHost(hostname)) return true;
      if (knownChzzkHlsPath(pathname)) return true;
    } catch {
      return false;
    }
    return false;
  }
  function isTrustedChzzkContext(details, policy, { trustedLiveTabIds = null } = {}) {
    if (!details || !isValidRedirectTabId(details.tabId)) return false;
    if (trustedLiveTabIds?.has?.(details.tabId)) return true;
    if (isChzzkLiveUrl(details.documentUrl, policy)) return true;
    if (isChzzkLiveUrl(details.originUrl, policy)) return true;
    const initiatorDomain = canonicalHttpsDomainFromUrl(details.initiator);
    const hasTrustedInitiator = Boolean(
      initiatorDomain &&
      trustedInitiatorDomains(policy).some((domain) => domainMatches(initiatorDomain, domain)),
    );
    if (hasTrustedInitiator && isNumericHlsPlaylistUrl(details.url)) return true;
    return isKnownChzzkHlsUrl(details.url, policy);
  }
  function isTrustedMasterPlaylistRequest(details, policy, { trustedLiveTabIds = null } = {}) {
    if (!details || !isValidRedirectTabId(details.tabId) || !isHttpsUrl(details.url)) return false;
    if (!isHlsPlaylistUrl(details.url) || parseQualityFromUrl(details.url)) return false;
    if (details.type && !resourceTypes(policy).includes(details.type)) return false;
    const method = String(details.method ?? "GET").toLowerCase();
    if (!requestMethods(policy).includes(method) || !isTrustedRequestDomain(details.url, policy))
      return false;
    if (trustedLiveTabIds?.has?.(details.tabId)) return true;
    if (isChzzkLiveUrl(details.documentUrl, policy) || isChzzkLiveUrl(details.originUrl, policy)) return true;
    const initiatorDomain = canonicalHttpsDomainFromUrl(details.initiator);
    return Boolean(
      initiatorDomain &&
      trustedInitiatorDomains(policy).some((domain) => domainMatches(initiatorDomain, domain)),
    );
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
      .map((domain) =>
        trustedInitiatorDomains(policy).includes(domain)
          ? `https://*.${domain}/live/*`
          : `https://*.${domain}/*`,
      )
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
  var activeTargetsByTab = /* @__PURE__ */ new Map();
  var liveContextByTab = /* @__PURE__ */ new Map();
  var resolutionByTab = /* @__PURE__ */ new Map();
  var resolvedTargetsByTab = /* @__PURE__ */ new Set();
  var tabContextTokenByTab = /* @__PURE__ */ new Map();
  var diagnosticsMutationQueue = Promise.resolve();
  var diagnosticsMutationQueueDepth = 0;
  function normalizeDiagnostics(value) {
    const empty = createEmptyDiagnostics({ maxSamples: quality_policy_default.maxDiagnosticsSamples });
    if (!value || typeof value !== "object") return empty;
    const runtimeRedirects =
      value.runtimeRedirects && typeof value.runtimeRedirects === "object" ? value.runtimeRedirects : {};
    return {
      ...empty,
      ...value,
      decisions: Array.isArray(value.decisions) ? value.decisions : [],
      maxSamples:
        Number.isSafeInteger(value.maxSamples) && value.maxSamples > 0 ? value.maxSamples : empty.maxSamples,
      qualities:
        value.qualities && typeof value.qualities === "object" && !Array.isArray(value.qualities)
          ? value.qualities
          : {},
      runtimeRedirects: {
        ...empty.runtimeRedirects,
        ...runtimeRedirects,
        activeTabIds: Array.isArray(runtimeRedirects.activeTabIds) ? runtimeRedirects.activeTabIds : [],
        targetsByTab:
          runtimeRedirects.targetsByTab &&
          typeof runtimeRedirects.targetsByTab === "object" &&
          !Array.isArray(runtimeRedirects.targetsByTab)
            ? runtimeRedirects.targetsByTab
            : {},
      },
      samples: Array.isArray(value.samples) ? value.samples : [],
      totalHlsRequests: Number.isFinite(Number(value.totalHlsRequests)) ? Number(value.totalHlsRequests) : 0,
    };
  }
  async function loadDiagnostics() {
    const stored = await api.storage.local.get(STORAGE_KEY);
    return normalizeDiagnostics(stored?.[STORAGE_KEY]);
  }
  async function saveDiagnostics(diagnostics) {
    await api.storage.local.set({ [STORAGE_KEY]: diagnostics });
  }
  async function mutateDiagnostics(mutator) {
    const diagnostics = await loadDiagnostics();
    const result = mutator(diagnostics);
    await saveDiagnostics(diagnostics);
    return { diagnostics, result };
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
    return {
      activeTabIds: [...activeLiveTabIds],
      lastError,
      targetsByTab: Object.fromEntries(
        [...activeTargetsByTab.entries()].map(([tabId, targetQuality]) => [String(tabId), targetQuality]),
      ),
    };
  }
  function activeTargetCoversObserved(tabId, observedQuality) {
    const activeTarget = activeTargetsByTab.get(tabId);
    const activeTargetNumber = qualityNumber(activeTarget);
    const observedNumber = qualityNumber(observedQuality);
    return Boolean(activeTargetNumber && observedNumber && activeTargetNumber >= observedNumber);
  }
  function resolvedTargetCoversObserved(tabId, observedQuality) {
    return resolvedTargetsByTab.has(tabId) && activeTargetCoversObserved(tabId, observedQuality);
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
  function isLikelyHlsPlaylist(text) {
    return /^\s*#EXTM3U/m.test(String(text ?? ""));
  }
  function responseHeader(response, name) {
    return response?.headers?.get?.(name) ?? null;
  }
  function responseContentLength(response) {
    const value = Number(responseHeader(response, "content-length") ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  async function readResponseTextWithLimit(response, maxBytes) {
    const declaredLength = responseContentLength(response);
    if (declaredLength > maxBytes) return null;
    if (!response?.body?.getReader) {
      const text = await response.text();
      return text.length > maxBytes ? null : text;
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
  async function fetchSupportsExpectedQuality(url, expectedQuality, { signal = null } = {}) {
    const evidence = await fetchPlaylistEvidence(url, { signal });
    if (!evidence) return false;
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
  async function resolveHighestSupportedQuality(details, observedQuality, { signal = null } = {}) {
    const observedNumber = qualityNumber(observedQuality);
    if (!observedNumber) return null;
    const candidates = normalizeQualityCandidates(quality_policy_default.qualityCandidates, {
      include: [observedQuality],
      minRedirectQuality: quality_policy_default.minRedirectQuality,
    });
    for (const candidate of candidates) {
      if (signal?.aborted) return null;
      const candidateNumber = qualityNumber(candidate);
      if (!candidateNumber || candidateNumber < observedNumber) continue;
      const candidateUrl = replaceQualityInUrl(details.url, candidate);
      if (!candidateUrl) continue;
      if (candidate === parseQualityFromUrl(details.url) || candidateUrl === details.url) return candidate;
      if (await fetchSupportsExpectedQuality(candidateUrl, candidate, { signal })) return candidate;
    }
    return signal?.aborted ? null : observedQuality;
  }
  function bestVariantTargetQuality(variant) {
    return variant?.quality ?? (variant?.resolution?.height ? `${variant.resolution.height}p` : null);
  }
  async function resolveBestVariantFromMaster(details, { signal = null } = {}) {
    const evidence = await fetchPlaylistEvidence(details.url, { signal });
    if (!evidence || signal?.aborted) return null;
    const variant = chooseBestHlsVariant(evidence.text, evidence.finalUrl, {
      minRedirectQuality: quality_policy_default.minRedirectQuality,
    });
    const targetQuality = bestVariantTargetQuality(variant);
    if (!variant?.url || !targetQuality || !isTrustedRequestDomain(variant.url, quality_policy_default))
      return null;
    if (!urlQualityMarkersMatch(variant.url, targetQuality)) return null;
    return targetQuality;
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
  function registerRequestContext(details) {
    const tabId = details?.tabId;
    if (!isValidRedirectTabId(tabId)) return false;
    const requestContext = requestLiveContext(details);
    if (!requestContext) return true;
    const knownContext = liveContextByTab.get(tabId);
    if (knownContext && knownContext !== requestContext) {
      invalidateTabResolution(tabId);
      activeTargetsByTab.delete(tabId);
      resolvedTargetsByTab.delete(tabId);
      liveContextByTab.delete(tabId);
      activeLiveTabIds.delete(tabId);
      scheduleRedirectDiagnostics();
      return false;
    }
    if (!knownContext) {
      currentTabContextToken(tabId);
      liveContextByTab.set(tabId, requestContext);
      activeLiveTabIds.add(tabId);
    }
    return true;
  }
  function currentTabContextToken(tabId) {
    if (!tabContextTokenByTab.has(tabId)) tabContextTokenByTab.set(tabId, {});
    return tabContextTokenByTab.get(tabId);
  }
  function invalidateTabResolution(tabId, { dropToken = false } = {}) {
    const activeResolution = resolutionByTab.get(tabId);
    activeResolution?.controller.abort();
    resolutionByTab.delete(tabId);
    tabContextTokenByTab.set(tabId, {});
    if (dropToken) tabContextTokenByTab.delete(tabId);
  }
  function resolutionContextKey(details) {
    return (
      liveContextByTab.get(details.tabId) ??
      liveContextKey(details.documentUrl) ??
      liveContextKey(details.originUrl) ??
      "trusted-request"
    );
  }
  function resolutionContextIsCurrent(tabId, contextKey) {
    const adoptedContext = liveContextByTab.get(tabId);
    return contextKey === "trusted-request" ? !adoptedContext : adoptedContext === contextKey;
  }
  function resolutionIsCurrent(tabId, state) {
    return (
      tabContextTokenByTab.get(tabId) === state.token &&
      resolutionByTab.get(tabId) === state &&
      resolutionContextIsCurrent(tabId, state.contextKey)
    );
  }
  async function setTabTarget(
    tabId,
    targetQuality,
    { contextKey = null, resolved = false, token = null } = {},
  ) {
    if (!isValidRedirectTabId(tabId) || !targetQuality) return false;
    if (token && tabContextTokenByTab.get(tabId) !== token) return false;
    if (contextKey && !resolutionContextIsCurrent(tabId, contextKey)) return false;
    const previous = activeTargetsByTab.get(tabId);
    activeTargetsByTab.set(tabId, targetQuality);
    if (resolved) resolvedTargetsByTab.add(tabId);
    if (previous !== targetQuality || resolved) scheduleRedirectDiagnostics();
    return true;
  }
  function startTabResolution(details, resolver, resolverKind) {
    const tabId = details.tabId;
    const contextKey = resolutionContextKey(details);
    let token = currentTabContextToken(tabId);
    const existing = resolutionByTab.get(tabId);
    if (existing?.token === token && existing.contextKey === contextKey) {
      if (resolverKind !== "master" || existing.resolverKind === "master") return existing.promise;
      invalidateTabResolution(tabId);
      token = currentTabContextToken(tabId);
    } else {
      existing?.controller.abort();
    }
    const controller = new AbortController();
    const resolutionTimeout = setTimeout(() => controller.abort(), probeResolutionBudgetMs());
    const state = { contextKey, controller, promise: null, resolverKind, token };
    state.promise = Promise.resolve()
      .then(() => resolver({ signal: controller.signal }))
      .then(async (targetQuality) => {
        if (!targetQuality || !resolutionIsCurrent(tabId, state)) return null;
        const stored = await setTabTarget(tabId, targetQuality, {
          contextKey,
          resolved: true,
          token,
        });
        return stored ? targetQuality : null;
      })
      .catch((error) => {
        if (controller.signal.aborted) return null;
        throw error;
      })
      .finally(() => {
        clearTimeout(resolutionTimeout);
        if (resolutionByTab.get(tabId) === state) resolutionByTab.delete(tabId);
      });
    resolutionByTab.set(tabId, state);
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
    return startTabResolution(
      details,
      ({ signal }) => resolveHighestSupportedQuality(details, decision.quality, { signal }),
      "numeric",
    );
  }
  function startMasterTargetResolution(details) {
    return startTabResolution(
      details,
      ({ signal }) => resolveBestVariantFromMaster(details, { signal }),
      "master",
    );
  }
  async function prewarmLiveTab(tabId, url = null) {
    if (!isValidRedirectTabId(tabId)) return;
    currentTabContextToken(tabId);
    const nextContext = liveContextKey(url);
    const previousContext = liveContextByTab.get(tabId);
    const activeResolution = resolutionByTab.get(tabId);
    const hasUnboundState =
      !previousContext &&
      (activeResolution?.contextKey === "trusted-request" ||
        activeTargetsByTab.has(tabId) ||
        resolvedTargetsByTab.has(tabId));
    const contextChanged = Boolean(
      nextContext && ((previousContext && previousContext !== nextContext) || hasUnboundState),
    );
    let hadTarget = false;
    if (contextChanged) {
      hadTarget = activeTargetsByTab.delete(tabId);
      invalidateTabResolution(tabId);
      resolvedTargetsByTab.delete(tabId);
    }
    if (nextContext) liveContextByTab.set(tabId, nextContext);
    const previousSize = activeLiveTabIds.size;
    activeLiveTabIds.add(tabId);
    if (hadTarget || activeLiveTabIds.size !== previousSize) await updateRedirectDiagnostics();
  }
  async function removeTabTarget(tabId) {
    if (!isValidRedirectTabId(tabId)) return;
    invalidateTabResolution(tabId, { dropToken: true });
    const hadTarget = activeTargetsByTab.delete(tabId);
    const hadLiveTab = activeLiveTabIds.delete(tabId);
    const hadContext = liveContextByTab.delete(tabId);
    resolvedTargetsByTab.delete(tabId);
    if (hadTarget || hadLiveTab || hadContext) await updateRedirectDiagnostics();
  }
  async function clearRuntimeRedirectState() {
    for (const state of resolutionByTab.values()) state.controller.abort();
    activeLiveTabIds.clear();
    activeTargetsByTab.clear();
    liveContextByTab.clear();
    resolutionByTab.clear();
    resolvedTargetsByTab.clear();
    tabContextTokenByTab.clear();
    await updateRedirectDiagnostics();
  }
  async function recordRequestDiagnostics(details, decision) {
    await enqueueDiagnosticsMutation((current) => {
      recordDiagnosticUrl(current, details.url, { context: details });
      recordDecision(current, decision, details);
    });
  }
  async function handleRequest(details) {
    if (!registerRequestContext(details)) return void 0;
    const redirectOptions = { trustedLiveTabIds: activeLiveTabIds };
    const shouldRecord = shouldRecordDiagnostics(details, quality_policy_default, redirectOptions);
    let decision = shouldRedirectRequest(details, quality_policy_default, redirectOptions);
    let redirectUrl = null;
    if (decision.ok) {
      try {
        let targetQuality = activeTargetsByTab.get(decision.tabId);
        if (!targetQuality) {
          targetQuality = await waitForBlockingResolution(startHighestTargetResolution(details, decision));
        } else if (!resolvedTargetCoversObserved(decision.tabId, decision.quality)) {
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
  api.webRequest.onBeforeRequest.addListener(
    (details) =>
      handleRequest(details).catch((error) => {
        console.warn("[CHZZK] diagnostics/redirect handling failed", error);
        return void 0;
      }),
    {
      urls: WEB_REQUEST_URLS,
      types: configuredResourceTypes(quality_policy_default),
    },
    ["blocking"],
  );
  async function prewarmMessageTab(tabId) {
    if (!isValidRedirectTabId(tabId) || typeof api.tabs?.get !== "function") return;
    const currentTab = await api.tabs.get(tabId);
    if (currentTab?.id !== tabId || !isChzzkLiveUrl(currentTab.url, quality_policy_default)) return;
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
      removeTabTarget(tabId).catch((error) =>
        console.warn("[CHZZK] failed to clear tab target for document load", error),
      );
    }
    if (!changeInfo?.url) return;
    if (isChzzkLiveUrl(changeInfo.url, quality_policy_default)) {
      prewarmLiveTab(tabId, changeInfo.url).catch((error) =>
        console.warn("[CHZZK] failed to prewarm live tab from URL update", error),
      );
      return;
    }
    removeTabTarget(tabId).catch((error) => console.warn("[CHZZK] failed to clear tab target", error));
  });
  api.tabs?.onRemoved?.addListener((tabId) => {
    removeTabTarget(tabId).catch((error) => console.warn("[CHZZK] failed to remove tab target", error));
  });
  api.runtime.onInstalled?.addListener(() => {
    resetAndPrewarmRuntimeState().catch((error) => console.warn("[CHZZK] startup cleanup failed", error));
  });
  api.runtime.onStartup?.addListener(() => {
    resetAndPrewarmRuntimeState().catch((error) => console.warn("[CHZZK] startup cleanup failed", error));
  });
})();
