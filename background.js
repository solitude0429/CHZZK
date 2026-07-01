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
    probeTimeoutMs: 1500,
    notes: [
      "Firefox MV2 declares CHZZK and trusted HLS CDN origins as required permissions so core site access is granted at install time instead of exposed as optional MV3 site toggles.",
      "A minimal MV2 content script runs at document_start on CHZZK live pages only and sends a live-page-ready message; it does not query or mutate the page DOM.",
      "The persistent background page uses blocking webRequest so eligible numeric HLS playlist requests can be redirected even if content-script prewarm is late or unavailable.",
      "For each eligible numeric HLS playlist URL, the runtime probes configured quality candidates from highest to lowest and caches the highest candidate per tab while the tab is open.",
      "The generated quality regex matches numeric qualities lower than the resolved per-tab target; it does not enumerate only today's menu values.",
      "CHZZK livecloud playlist hosts may resolve/use GSCdn; keep gscdn.net covered for HLS playlist requests.",
      "Request URL, initiator, method, resource type, trusted request domain, CHZZK live context, and known CHZZK/livecloud HLS URL shape constrain redirects; CHZZK-originated or CHZZK-marked numeric playlist URLs are covered even when Firefox omits page request metadata.",
      "Prewarm marks the CHZZK live tab only; it is a supporting signal, not the sole gate. The runtime must resolve the highest actually available HLS quality from the first eligible playlist request instead of seeding a fixed startup quality.",
    ],
  };

  // src/shared/quality.js
  var QUALITY_LABEL_RE = /^(\d{3,4})p$/i;
  var DEFAULT_QUALITY_CANDIDATES = ["2160p", "1440p", "1080p", "720p", "480p", "360p", "270p", "144p"];
  var PATH_QUALITY_RE = /(?:chunklist_|\/)(\d{3,4}p)(?=\.m3u8(?:[?#]|$)|\/)/i;
  var RESOLUTION_RE = /(?:RESOLUTION=|^)(\d{3,5})x(\d{3,5})(?:[,\s]|$)/i;
  var TEXT_QUALITY_RE = /(?:^|[^0-9])(\d{3,4})\s*p(?:[^0-9]|$)/i;
  var SENSITIVE_PATH_SEGMENT_RE = /(?:hdntl|hmac|policy|signature|token|key|acl|exp|st)(?:=|%3d)/i;
  var HIGH_ENTROPY_PATH_SEGMENT_RE = /(?:[a-z0-9_-]{24,}|[a-f0-9]{16,})/i;
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
  function parseQualityFromUrl(url) {
    if (typeof url !== "string") return null;
    let pathname = url;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url.split("?")[0].split("#")[0];
    }
    const pathQuality = pathname.match(PATH_QUALITY_RE);
    return pathQuality ? normalizeQualityLabel(pathQuality[1]) : normalizeQualityLabel(pathname);
  }
  function redactMediaUrl(url) {
    if (typeof url !== "string" || url === "") return "";
    try {
      const parsed = new URL(url);
      const hadSensitiveTail = parsed.search || parsed.hash;
      parsed.pathname = parsed.pathname
        .split("/")
        .map((segment) => {
          if (!segment) return segment;
          if (/^\d{3,4}p$/i.test(segment)) return segment;
          if (/\.m3u8$/i.test(segment) && !HIGH_ENTROPY_PATH_SEGMENT_RE.test(segment)) return segment;
          if (SENSITIVE_PATH_SEGMENT_RE.test(segment) || HIGH_ENTROPY_PATH_SEGMENT_RE.test(segment)) {
            return "[redacted-path]";
          }
          return segment;
        })
        .join("/");
      parsed.search = "";
      parsed.hash = "";
      return `${parsed.toString()}${hadSensitiveTail ? "?[redacted]" : ""}`;
    } catch {
      return url.replace(/[?#].*$/, "?[redacted]");
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
    let replacedAny = false;
    const replaced = url.replace(
      /(chunklist_|\/)(\d{3,4}p)(?=\.m3u8(?:[?#]|$)|\/)/gi,
      (match, prefix, quality) => {
        const current = qualityNumber(quality);
        if (!current || current >= target) return match;
        replacedAny = true;
        return `${prefix}${normalizedTarget}`;
      },
    );
    return replacedAny ? replaced : null;
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
  var REDIRECT_TAB_ID_RANGE = 1e5;
  var DEFAULT_RESOURCE_TYPES = ["media", "other", "xmlhttprequest"];
  var DEFAULT_REQUEST_METHODS = ["get"];
  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }
  function canonicalDomainFromUrl(value) {
    if (typeof value !== "string" || value === "") return null;
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return null;
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
    return Number.isSafeInteger(tabId) && tabId >= 0 && tabId < REDIRECT_TAB_ID_RANGE;
  }
  function isTrustedRequestDomain(url, policy) {
    const hostname = canonicalDomainFromUrl(url);
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
  function isNumericHlsPlaylistUrl(url) {
    return typeof url === "string" && /\.m3u8(?:[?#]|$)/i.test(url) && Boolean(parseQualityFromUrl(url));
  }
  function isKnownChzzkHlsUrl(url, policy) {
    if (!isNumericHlsPlaylistUrl(url) || !isTrustedRequestDomain(url, policy)) return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      const hostname = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      if (trustedInitiatorDomains(policy).some((domain) => domainMatches(hostname, domain))) return true;
      if (hostname.includes("chzzk")) return true;
      if (pathname === "/chzzk" || pathname.startsWith("/chzzk/") || pathname.includes("/chzzk/"))
        return true;
      if (hostname.includes("livecloud")) return true;
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
  function shouldRecordDiagnostics(details, policy, options = {}) {
    if (!details?.url || !/\.m3u8(?:[?#]|$)/i.test(details.url)) return false;
    if (!isValidRedirectTabId(details.tabId)) return false;
    if (!isTrustedRequestDomain(details.url, policy)) return false;
    return isTrustedChzzkContext(details, policy, options);
  }
  function shouldRedirectRequest(details, policy, options = {}) {
    const tabId = details?.tabId;
    if (!isValidRedirectTabId(tabId)) {
      return { ok: false, reason: "invalid-tab", tabId: tabId ?? null };
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
  var resolvedTargetsByTab = /* @__PURE__ */ new Set();
  var diagnosticsMutationQueue = Promise.resolve();
  async function loadDiagnostics() {
    const stored = await api.storage.local.get(STORAGE_KEY);
    return (
      stored?.[STORAGE_KEY] ??
      createEmptyDiagnostics({ maxSamples: quality_policy_default.maxDiagnosticsSamples })
    );
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
  async function enqueueDiagnosticsMutation(mutator) {
    const operation = diagnosticsMutationQueue.then(() => mutateDiagnostics(mutator));
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
  function isLikelyHlsPlaylist(text) {
    return /^\s*#EXTM3U/m.test(String(text ?? ""));
  }
  async function fetchLooksLikeHlsPlaylist(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), probeTimeoutMs());
    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) return false;
      return isLikelyHlsPlaylist(await response.text());
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
  async function resolveHighestSupportedQuality(details, observedQuality) {
    const observedNumber = qualityNumber(observedQuality);
    if (!observedNumber) return null;
    const candidates = normalizeQualityCandidates(quality_policy_default.qualityCandidates, {
      include: [observedQuality],
      minRedirectQuality: quality_policy_default.minRedirectQuality,
    });
    for (const candidate of candidates) {
      const candidateNumber = qualityNumber(candidate);
      if (!candidateNumber || candidateNumber < observedNumber) continue;
      const candidateUrl = replaceQualityInUrl(details.url, candidate);
      if (!candidateUrl) continue;
      if (candidate === parseQualityFromUrl(details.url) || candidateUrl === details.url) return candidate;
      if (await fetchLooksLikeHlsPlaylist(candidateUrl)) return candidate;
    }
    return observedQuality;
  }
  async function updateRedirectDiagnostics(lastError = null) {
    await enqueueDiagnosticsMutation((diagnostics) => {
      updateRuntimeRedirectDiagnostics(diagnostics, currentRedirectState(lastError));
    });
  }
  async function reportRedirectError(error) {
    await updateRedirectDiagnostics(String(error?.message ?? error));
  }
  async function prewarmLiveTab(tabId) {
    if (!isValidRedirectTabId(tabId)) return;
    const previousSize = activeLiveTabIds.size;
    activeLiveTabIds.add(tabId);
    if (activeLiveTabIds.size !== previousSize) await updateRedirectDiagnostics();
  }
  async function setTabTarget(tabId, targetQuality, { resolved = false } = {}) {
    if (!isValidRedirectTabId(tabId) || !targetQuality) return;
    const previous = activeTargetsByTab.get(tabId);
    activeTargetsByTab.set(tabId, targetQuality);
    if (resolved) resolvedTargetsByTab.add(tabId);
    if (previous !== targetQuality || resolved) await updateRedirectDiagnostics();
  }
  async function removeTabTarget(tabId) {
    if (!isValidRedirectTabId(tabId)) return;
    const hadTarget = activeTargetsByTab.delete(tabId);
    const hadLiveTab = activeLiveTabIds.delete(tabId);
    resolvedTargetsByTab.delete(tabId);
    if (hadTarget || hadLiveTab) await updateRedirectDiagnostics();
  }
  async function clearRuntimeRedirectState() {
    activeLiveTabIds.clear();
    activeTargetsByTab.clear();
    resolvedTargetsByTab.clear();
    await updateRedirectDiagnostics();
  }
  async function recordRequestDiagnostics(details, decision) {
    await enqueueDiagnosticsMutation((current) => {
      recordDiagnosticUrl(current, details.url, { context: details });
      recordDecision(current, decision, details);
    });
  }
  async function resolveAndStoreHighestTarget(details, decision) {
    const targetQuality = await resolveHighestSupportedQuality(details, decision.quality);
    if (targetQuality) await setTabTarget(decision.tabId, targetQuality, { resolved: true });
    return targetQuality;
  }
  async function handleRequest(details) {
    const redirectOptions = { trustedLiveTabIds: activeLiveTabIds };
    const shouldRecord = shouldRecordDiagnostics(details, quality_policy_default, redirectOptions);
    let decision = shouldRedirectRequest(details, quality_policy_default, redirectOptions);
    let redirectUrl = null;
    if (decision.ok) {
      try {
        let targetQuality = activeTargetsByTab.get(decision.tabId);
        if (!targetQuality) {
          targetQuality = await resolveAndStoreHighestTarget(details, decision);
        } else if (!resolvedTargetCoversObserved(decision.tabId, decision.quality)) {
          resolveAndStoreHighestTarget(details, decision).catch((error) => {
            reportRedirectError(error).catch(() => {});
            console.warn("[CHZZK] failed to resolve highest trusted HLS playlist quality", error);
          });
        }
        if (targetQuality) {
          redirectUrl = buildHighestQualityRedirectUrl(details.url, {
            minRedirectQuality: quality_policy_default.minRedirectQuality,
            targetQuality,
          });
          decision = { ...decision, redirectedCurrentRequest: Boolean(redirectUrl), targetQuality };
        }
      } catch (error) {
        await reportRedirectError(error);
        console.warn("[CHZZK] failed to redirect trusted HLS playlist request", error);
      }
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
  api.runtime.onMessage?.addListener((message, sender) => {
    if (message?.type !== "chzzk.live-page-ready") return void 0;
    const tabId = sender?.tab?.id;
    if (!isValidRedirectTabId(tabId)) return void 0;
    prewarmLiveTab(tabId).catch((error) => console.warn("[CHZZK] failed to prewarm live tab", error));
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
    await Promise.all(tabs.map((tab) => prewarmLiveTab(tab?.id)));
  }
  async function resetAndPrewarmRuntimeState() {
    await clearRuntimeRedirectState();
    await prewarmExistingLiveTabs();
  }
  api.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    if (!changeInfo?.url) return;
    if (isChzzkLiveUrl(changeInfo.url, quality_policy_default)) {
      prewarmLiveTab(tabId).catch((error) =>
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
