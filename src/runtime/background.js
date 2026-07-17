import policy from "../../policy/quality-policy.json";
import {
  normalizeDiagnostics,
  recordDecision,
  recordDiagnosticUrl,
  updateRuntimeRedirectDiagnostics,
} from "../shared/diagnostics.js";
import {
  isLikelyHlsPlaylist,
  isUtf8TextWithinByteLimit,
} from "../shared/playlist-evidence.js";
import {
  configuredResourceTypes,
  configuredWebRequestUrls,
  hasContradictoryChzzkMetadata,
  hasTrustedChzzkMetadata,
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
  parseQualitiesFromUrl,
  parseQualityFromUrl,
  playlistFamilyKey,
  qualityNumber,
  replaceQualityInUrl,
} from "../shared/quality.js";

const api = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "chzzkDiagnostics";
const WEB_REQUEST_URLS = configuredWebRequestUrls(policy);
const activeLiveTabIds = new Set();
const activeTargetsBySession = new Map();
const failedTargetsBySession = new Map();
const liveContextByTab = new Map();
const pendingTrustValidationByTab = new Map();
const redirectedRequestsById = new Map();
const resolutionBySession = new Map();
const tabContextTokenByTab = new Map();
const MAX_MARKER_EVIDENCE_TTL_MS = 30_000;
const MAX_REDIRECT_FAILURE_BACKOFF_MS = 30_000;
const MAX_TRACKED_REDIRECT_REQUESTS = 500;
let diagnosticsMutationQueue = Promise.resolve();
let diagnosticsMutationQueueDepth = 0;

async function loadDiagnostics() {
  const stored = await api.storage.local.get(STORAGE_KEY);
  return normalizeDiagnostics(stored?.[STORAGE_KEY], {
    maxSamples: policy.maxDiagnosticsSamples,
  });
}

async function saveDiagnostics(diagnostics) {
  const normalized = normalizeDiagnostics(diagnostics, {
    maxSamples: policy.maxDiagnosticsSamples,
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

function markerEvidenceTtlMs() {
  const configured = Number(policy.markerEvidenceTtlMs ?? 10_000);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, MAX_MARKER_EVIDENCE_TTL_MS)
    : 10_000;
}

function redirectFailureBackoffMs() {
  const configured = Number(policy.redirectFailureBackoffMs ?? 10_000);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, MAX_REDIRECT_FAILURE_BACKOFF_MS)
    : 10_000;
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
    if (hasRejectedPlaylistContentType(response)) return null;
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
        isTrustedRequestDomain(variant.url, policy) &&
        urlQualityMarkersMatch(variant.url, expectedQuality)
      );
    });
  }

  return urlQualityMarkersMatch(evidence.finalUrl, expectedQuality);
}

async function resolveHighestSupportedQuality(
  details,
  observedQuality,
  { signal = null, skipTargetQualities = new Set() } = {},
) {
  const observedNumber = qualityNumber(observedQuality);
  if (!observedNumber) return null;

  const candidates = normalizeQualityCandidates(policy.qualityCandidates, {
    include: [observedQuality],
    minRedirectQuality: policy.minRedirectQuality,
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

  return signal?.aborted
    ? null
    : { evidenceKind: "url-marker", targetQuality: observedQuality };
}

function bestVariantTargetQuality(variant) {
  return variant?.quality ?? (variant?.resolution?.height ? `${variant.resolution.height}p` : null);
}

async function resolveBestVariantFromMaster(
  details,
  { signal = null, skipTargetQualities = new Set() } = {},
) {
  const evidence = await fetchPlaylistEvidence(details.url, { signal });
  if (!evidence || signal?.aborted) return null;

  const variant = chooseBestHlsVariant(evidence.text, evidence.finalUrl, {
    excludedQualities: [...skipTargetQualities],
    minRedirectQuality: policy.minRedirectQuality,
  });
  const targetQuality = bestVariantTargetQuality(variant);
  if (!variant?.url || !targetQuality || !isTrustedRequestDomain(variant.url, policy)) return null;
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
  if (!state) return new Set();
  const now = Date.now();
  for (const [quality, expiresAt] of state.targets) {
    if (expiresAt <= now) state.targets.delete(quality);
  }
  if (state.targets.size === 0) {
    failedTargetsBySession.delete(session.key);
    return new Set();
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
    expiresAt:
      resolution.evidenceKind === "url-marker" ? Date.now() + markerEvidenceTtlMs() : null,
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
    if (state.tabId === tabId) redirectedRequestsById.delete(requestId);
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
  if (hasContradictoryChzzkMetadata(details, policy)) {
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
      if (tab?.id === tabId && isChzzkLiveUrl(tab.url, policy)) {
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
  const timedOut = Symbol("tab-trust-validation-timeout");
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

function rememberRedirectedRequest(details, session, targetQuality) {
  if (details?.requestId == null || !session || !targetQuality) return;
  const requestId = String(details.requestId);
  if (requestId === "" || requestId.length > 128) return;
  redirectedRequestsById.delete(requestId);
  redirectedRequestsById.set(requestId, { ...session, targetQuality });
  while (redirectedRequestsById.size > MAX_TRACKED_REDIRECT_REQUESTS) {
    redirectedRequestsById.delete(redirectedRequestsById.keys().next().value);
  }
}

function invalidateRedirectedTarget(record) {
  const current = activeTargetsBySession.get(record.key);
  if (current?.targetQuality === record.targetQuality) activeTargetsBySession.delete(record.key);
  invalidateSessionResolution(record.key);
  const failures = failedTargetsBySession.get(record.key) ?? {
    ...record,
    targets: new Map(),
  };
  failures.targets.set(record.targetQuality, Date.now() + redirectFailureBackoffMs());
  failedTargetsBySession.set(record.key, failures);
  for (const [requestId, pending] of redirectedRequestsById) {
    if (pending.key === record.key && pending.targetQuality === record.targetQuality) {
      redirectedRequestsById.delete(requestId);
    }
  }
  scheduleRedirectDiagnostics();
}

function handleRedirectCompleted(details) {
  const requestId = details?.requestId == null ? null : String(details.requestId);
  if (!requestId) return;
  const record = redirectedRequestsById.get(requestId);
  if (!record) return;
  redirectedRequestsById.delete(requestId);
  const statusCode = Number(details.statusCode);
  if (Number.isSafeInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
    invalidateRedirectedTarget(record);
  }
}

function handleRedirectError(details) {
  const requestId = details?.requestId == null ? null : String(details.requestId);
  if (!requestId) return;
  const record = redirectedRequestsById.get(requestId);
  if (!record) return;
  redirectedRequestsById.delete(requestId);
  invalidateRedirectedTarget(record);
}

async function recordRequestDiagnostics(details, decision) {
  await enqueueDiagnosticsMutation((current) => {
    recordDiagnosticUrl(current, details.url, { context: details });
    recordDecision(current, decision, details);
  });
}

async function handleRequest(details) {
  if (!registerRequestContext(details)) return undefined;
  if (hasTrustedChzzkMetadata(details, policy)) {
    if (isChzzkLiveUrl(details.documentUrl, policy)) {
      pendingTrustValidationByTab.delete(details.tabId);
    }
  } else if (!(await awaitPendingTrustValidation(details?.tabId))) {
    return undefined;
  }
  const redirectOptions = { trustedLiveTabIds: activeLiveTabIds };
  const shouldRecord = shouldRecordDiagnostics(details, policy, redirectOptions);
  let decision = shouldRedirectRequest(details, policy, redirectOptions);
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
          minRedirectQuality: policy.minRedirectQuality,
          targetQuality,
        });
      }
      if (targetQuality) {
        decision = { ...decision, redirectedCurrentRequest: Boolean(redirectUrl), targetQuality };
      }
      if (redirectUrl) rememberRedirectedRequest(details, session, targetQuality);
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

const WEB_REQUEST_FILTER = {
  urls: WEB_REQUEST_URLS,
  types: configuredResourceTypes(policy),
};

api.webRequest.onBeforeRequest.addListener(
  (details) =>
    handleRequest(details).catch((error) => {
      console.warn("[CHZZK] diagnostics/redirect handling failed", error);
      return undefined;
    }),
  WEB_REQUEST_FILTER,
  ["blocking"],
);
api.webRequest.onCompleted?.addListener(handleRedirectCompleted, WEB_REQUEST_FILTER);
api.webRequest.onErrorOccurred?.addListener(handleRedirectError, WEB_REQUEST_FILTER);

async function prewarmMessageTab(tabId) {
  if (!isValidRedirectTabId(tabId) || typeof api.tabs?.get !== "function") return;
  const currentTab = await api.tabs.get(tabId);
  if (currentTab?.id !== tabId || !isChzzkLiveUrl(currentTab.url, policy)) return;
  pendingTrustValidationByTab.delete(tabId);
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
  if (isChzzkLiveUrl(changeInfo.url, policy)) {
    prewarmLiveTab(tabId, changeInfo.url).catch((error) => console.warn("[CHZZK] failed to prewarm live tab from URL update", error));
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
