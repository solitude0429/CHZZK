import policy from "../../policy/quality-policy.json";
import {
  createEmptyDiagnostics,
  recordDecision,
  recordDiagnosticUrl,
  updateRuntimeRedirectDiagnostics,
} from "../shared/diagnostics.js";
import {
  configuredResourceTypes,
  configuredWebRequestUrls,
  isChzzkLiveUrl,
  isTrustedMasterPlaylistRequest,
  isTrustedRequestDomain,
  isValidRedirectTabId,
  shouldRecordDiagnostics,
  shouldRedirectRequest,
} from "../shared/request-policy.js";
import {
  buildHighestQualityRedirectUrl,
  chooseBestHlsVariant,
  normalizeQualityCandidates,
  parseHlsMasterPlaylistVariants,
  parseQualityFromUrl,
  qualityNumber,
  replaceQualityInUrl,
} from "../shared/quality.js";

const api = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "chzzkDiagnostics";
const WEB_REQUEST_URLS = configuredWebRequestUrls(policy);
const activeLiveTabIds = new Set();
const activeTargetsByTab = new Map();
const liveContextByTab = new Map();
const resolutionByTab = new Map();
const resolvedTargetsByTab = new Set();
const tabContextTokenByTab = new Map();
let diagnosticsMutationQueue = Promise.resolve();
let diagnosticsMutationQueueDepth = 0;

function normalizeDiagnostics(value) {
  const empty = createEmptyDiagnostics({ maxSamples: policy.maxDiagnosticsSamples });
  if (!value || typeof value !== "object") return empty;
  const runtimeRedirects = value.runtimeRedirects && typeof value.runtimeRedirects === "object" ? value.runtimeRedirects : {};
  return {
    ...empty,
    ...value,
    decisions: Array.isArray(value.decisions) ? value.decisions : [],
    maxSamples: Number.isSafeInteger(value.maxSamples) && value.maxSamples > 0 ? value.maxSamples : empty.maxSamples,
    qualities: value.qualities && typeof value.qualities === "object" && !Array.isArray(value.qualities) ? value.qualities : {},
    runtimeRedirects: {
      ...empty.runtimeRedirects,
      ...runtimeRedirects,
      activeTabIds: Array.isArray(runtimeRedirects.activeTabIds) ? runtimeRedirects.activeTabIds : [],
      targetsByTab:
        runtimeRedirects.targetsByTab && typeof runtimeRedirects.targetsByTab === "object" && !Array.isArray(runtimeRedirects.targetsByTab)
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
  const configured = Number(policy.maxPendingDiagnosticsMutations ?? 50);
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
  const configured = Number(policy.probeTimeoutMs ?? 1500);
  return Number.isFinite(configured) && configured > 0 ? configured : 1500;
}

function blockingProbeBudgetMs() {
  const configured = Number(policy.blockingProbeBudgetMs ?? 150);
  return Number.isFinite(configured) && configured > 0 ? configured : 150;
}

function probeResolutionBudgetMs() {
  const configured = Number(policy.probeResolutionBudgetMs ?? 3000);
  return Number.isFinite(configured) && configured > 0 ? configured : 3000;
}

function probeMaxBytes() {
  const configured = Number(policy.probeMaxBytes ?? 256_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 256_000;
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
  if (!isTrustedRequestDomain(url, policy)) return null;
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
    if (!isTrustedRequestDomain(finalUrl, policy) || finalUrl !== url) return null;
    const text = await readResponseTextWithLimit(response, probeMaxBytes());
    return isLikelyHlsPlaylist(text) ? { finalUrl, text } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", abortFromParent);
  }
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
        isTrustedRequestDomain(variant.url, policy) &&
        parseQualityFromUrl(variant.url) === expectedQuality
      );
    });
  }

  return parseQualityFromUrl(evidence.finalUrl) === expectedQuality;
}

async function resolveHighestSupportedQuality(details, observedQuality, { signal = null } = {}) {
  const observedNumber = qualityNumber(observedQuality);
  if (!observedNumber) return null;

  const candidates = normalizeQualityCandidates(policy.qualityCandidates, {
    include: [observedQuality],
    minRedirectQuality: policy.minRedirectQuality,
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
    minRedirectQuality: policy.minRedirectQuality,
  });
  const targetQuality = bestVariantTargetQuality(variant);
  if (!variant?.url || !targetQuality || !isTrustedRequestDomain(variant.url, policy)) return null;
  if (parseQualityFromUrl(variant.url) !== targetQuality) return null;
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
  if (!isChzzkLiveUrl(url, policy)) return null;
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
  const timedOut = Symbol("blocking-probe-timeout");
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
  if (!registerRequestContext(details)) return undefined;
  const redirectOptions = { trustedLiveTabIds: activeLiveTabIds };
  const shouldRecord = shouldRecordDiagnostics(details, policy, redirectOptions);
  let decision = shouldRedirectRequest(details, policy, redirectOptions);
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
          minRedirectQuality: policy.minRedirectQuality,
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
  } else if (isTrustedMasterPlaylistRequest(details, policy, redirectOptions)) {
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

  return redirectUrl ? { redirectUrl } : undefined;
}

api.webRequest.onBeforeRequest.addListener(
  (details) =>
    handleRequest(details).catch((error) => {
      console.warn("[CHZZK] diagnostics/redirect handling failed", error);
      return undefined;
    }),
  {
    urls: WEB_REQUEST_URLS,
    types: configuredResourceTypes(policy),
  },
  ["blocking"],
);

async function prewarmMessageTab(tabId) {
  if (!isValidRedirectTabId(tabId) || typeof api.tabs?.get !== "function") return;
  const currentTab = await api.tabs.get(tabId);
  if (currentTab?.id !== tabId || !isChzzkLiveUrl(currentTab.url, policy)) return;
  await prewarmLiveTab(tabId, currentTab.url);
}

api.runtime.onMessage?.addListener((message, sender) => {
  if (message?.type !== "chzzk.live-page-ready") return undefined;
  const tabId = sender?.tab?.id;
  if (!isValidRedirectTabId(tabId)) return undefined;
  // A delayed message can outlive its document. Query the current tab and prewarm only
  // when its authoritative URL is still a CHZZK live page.
  prewarmMessageTab(tabId).catch((error) =>
    console.warn("[CHZZK] failed to validate and prewarm live tab", error),
  );
  return undefined;
});

function liveTabQueryUrls() {
  return (policy.trustedInitiatorDomains?.length ? policy.trustedInitiatorDomains : ["chzzk.naver.com"])
    .map((domain) => `https://*.${domain}/live/*`)
    .sort();
}

async function prewarmExistingLiveTabs() {
  if (typeof api.tabs?.query !== "function") return;
  const tabs = await api.tabs.query({ url: liveTabQueryUrls() });
  await Promise.all(tabs.map((tab) => prewarmLiveTab(tab?.id, tab?.url)));
}

async function resetAndPrewarmRuntimeState() {
  await clearRuntimeRedirectState();
  await prewarmExistingLiveTabs();
}

api.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (!changeInfo?.url) return;
  if (isChzzkLiveUrl(changeInfo.url, policy)) {
    prewarmLiveTab(tabId, changeInfo.url).catch((error) => console.warn("[CHZZK] failed to prewarm live tab from URL update", error));
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
