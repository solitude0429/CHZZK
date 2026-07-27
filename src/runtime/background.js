import policy from "../../policy/quality-policy.json";
import {
  normalizeDiagnostics,
  recordDecision,
  recordDiagnosticUrl,
  recordRuntimeTransition,
  updateRuntimeRedirectDiagnostics,
} from "../shared/diagnostics.js";
import {
  configuredResourceTypes,
  configuredWebRequestUrls,
  hasContradictoryChzzkMetadata,
  hasTrustedChzzkMetadata,
  isChzzkLiveUrl,
  isChzzkSiteUrl,
  isDedicatedChzzkHlsPlaylistUrl,
  isHlsPlaylistUrl,
  isTrustedMasterPlaylistRequest,
  isValidRedirectTabId,
  shouldRecordDiagnostics,
  shouldRedirectRequest,
} from "../shared/request-policy.js";
import {
  buildHighestQualityRedirectUrl,
  highestQualityCandidate,
  playlistFamilyKey,
  qualityNumber,
} from "../shared/quality.js";
import { createPlaylistProbe, networkRequestUrl } from "./playlist-probe.js";
import { createSessionStateStore } from "./session-state-store.js";

const api = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "chzzkDiagnostics";
const WEB_REQUEST_URLS = configuredWebRequestUrls(policy);
const activeLiveTabIds = new Set();
const liveContextByTab = new Map();
const miniPlayerTabIds = new Set();
const pendingTrustValidationByTab = new Map();
const masterResponseObserversById = new Map();
const redirectedRequestsById = new Map();
const tabContextTokenByTab = new Map();
const {
  activeTargetsBySession,
  enforceLimits: enforceSessionStateLimits,
  failedTargetsBySession,
  forgetRedirectedRequests: forgetRedirectedRequestsForSession,
  resolutionBySession,
  sweepExpired: sweepExpiredSessionState,
  touch: touchSessionState,
} = createSessionStateStore({
  maxStates: policy.maxSessionStates,
  maxStatesPerTab: policy.maxSessionStatesPerTab,
  onActiveTargetsChanged: () => scheduleRedirectDiagnostics(),
  redirectedRequestsById,
});
const {
  fetchPlaylistEvidence,
  playlistEvidenceSupportsExpectedQuality,
  probeMaxBytes,
  resolveBestVariantFromEvidence,
  resolveHighestSupportedQuality,
  urlQualityMarkersMatch,
} = createPlaylistProbe({ policy });
const MAX_MARKER_EVIDENCE_TTL_MS = 30_000;
const MAX_REDIRECT_FAILURE_BACKOFF_MS = 30_000;
const MIN_UPGRADE_PROBE_INTERVAL_MS = 30_000;
const MAX_UPGRADE_PROBE_INTERVAL_MS = 10 * 60_000;
const MAX_TRACKED_REDIRECT_REQUESTS = 500;
const MAX_VALIDATED_TARGET_URLS = 16;
const CLIENT_CANCELLED_REQUEST_ERRORS = new Set([
  "NS_BINDING_ABORTED",
  "NS_ERROR_ABORT",
]);
const HIGHEST_CONFIGURED_TARGET_NUMBER = qualityNumber(
  highestQualityCandidate(policy.qualityCandidates, {
    minRedirectQuality: policy.minRedirectQuality,
  }),
);
let diagnosticsMutationQueue = Promise.resolve();
let diagnosticsMutationQueueDepth = 0;
let redirectVerificationSequence = 0;

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
  sweepExpiredSessionState();
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

function blockingProbeBudgetMs() {
  const configured = Number(policy.blockingProbeBudgetMs ?? 50);
  return Number.isFinite(configured) && configured > 0 ? configured : 50;
}

function createBlockingRequestBudget() {
  const timedOut = Symbol("blocking-request-timeout");
  let timeout = null;
  let timeoutPromise = null;
  return {
    clear() {
      if (timeout !== null) clearTimeout(timeout);
    },
    async wait(promise) {
      if (!timeoutPromise) {
        timeoutPromise = new Promise((resolve) => {
          timeout = setTimeout(() => resolve(timedOut), blockingProbeBudgetMs());
        });
      }
      const result = await Promise.race([promise, timeoutPromise]);
      return result === timedOut ? null : result;
    },
  };
}

async function waitWithinBlockingRequestBudget(promise, budget) {
  return budget.wait(promise);
}

function probeResolutionBudgetMs() {
  const configured = Number(policy.probeResolutionBudgetMs ?? 3000);
  return Number.isFinite(configured) && configured > 0 ? configured : 3000;
}

function markerEvidenceTtlMs() {
  const configured = Number(policy.markerEvidenceTtlMs ?? 30_000);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, MAX_MARKER_EVIDENCE_TTL_MS)
    : 30_000;
}

function redirectFailureBackoffMs() {
  const configured = Number(policy.redirectFailureBackoffMs ?? 10_000);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, MAX_REDIRECT_FAILURE_BACKOFF_MS)
    : 10_000;
}

function upgradeProbeIntervalMs() {
  const configured = Number(policy.upgradeProbeIntervalMs ?? 60_000);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(
        Math.max(configured, MIN_UPGRADE_PROBE_INTERVAL_MS),
        MAX_UPGRADE_PROBE_INTERVAL_MS,
      )
    : 60_000;
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

function scheduleRuntimeTransition(transition) {
  enqueueDiagnosticsMutation((diagnostics) => {
    recordRuntimeTransition(diagnostics, transition);
  }).catch((error) =>
    console.warn("[CHZZK] failed to persist runtime transition diagnostics", error),
  );
}

function resolutionDiagnosticSource(resolution) {
  if (resolution?.source === "master-response") return "master-response";
  return resolution?.evidenceKind === "master" ? "master-probe" : "numeric-probe";
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
  if (miniPlayerTabIds.has(details.tabId)) return "trusted-request";
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
    dedicatedHls: isDedicatedChzzkHlsPlaylistUrl(details.url, policy),
    familyKey,
    key: JSON.stringify([tabId, contextKey, familyKey]),
    tabId,
  };
}

function sessionForMasterResolution(session, resolution) {
  if (!session || typeof resolution?.targetFamilyKey !== "string") return session;
  return {
    ...session,
    dedicatedHls: resolution.targetDedicatedHls === true,
    familyKey: resolution.targetFamilyKey,
    key: JSON.stringify([session.tabId, session.contextKey, resolution.targetFamilyKey]),
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
    forgetRedirectedRequestsForSession(session.key);
    scheduleRedirectDiagnostics();
    return null;
  }
  return touchSessionState(state);
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
  touchSessionState(state);
  return new Set(state.targets.keys());
}

function earliestFailedHigherTargetRetryAt(session, targetQuality, now) {
  const targetNumber = qualityNumber(targetQuality);
  const state = failedTargetsBySession.get(session.key);
  if (!targetNumber || !(state?.targets instanceof Map)) return null;
  let retryAt = null;
  for (const [quality, expiresAt] of state.targets) {
    if (
      Number.isFinite(expiresAt) &&
      expiresAt > now &&
      (qualityNumber(quality) ?? 0) > targetNumber &&
      (retryAt == null || expiresAt < retryAt)
    ) {
      retryAt = expiresAt;
    }
  }
  return retryAt;
}

function canReuseSessionTarget(previous, targetQuality, now) {
  return Boolean(
    previous?.resolved &&
      previous.targetQuality === targetQuality &&
      (previous.expiresAt == null || previous.expiresAt > now),
  );
}

function setSessionTarget(session, resolution, token) {
  const targetQuality = resolution?.targetQuality;
  if (!targetQuality || tabContextTokenByTab.get(session.tabId) !== token) return false;
  if (!resolutionContextIsCurrent(session.tabId, session.contextKey)) return false;
  if (failedTargetsForSession(session).has(targetQuality)) return false;

  const now = Date.now();
  let previous = activeTargetsBySession.get(session.key);
  if (previous?.expiresAt != null && previous.expiresAt <= now) {
    activeTargetsBySession.delete(session.key);
    forgetRedirectedRequestsForSession(session.key);
    previous = null;
  }
  const previousTargetNumber = qualityNumber(previous?.targetQuality);
  const targetNumber = qualityNumber(targetQuality);
  if (
    previous?.resolved &&
    previous.evidenceKind === "master" &&
    resolution.evidenceKind !== "master" &&
    previousTargetNumber &&
    targetNumber &&
    targetNumber > previousTargetNumber
  ) {
    scheduleRuntimeTransition({
      action: "blocked",
      fromQuality: previous.targetQuality,
      reason: "master-authority",
      source: resolutionDiagnosticSource(resolution),
      toQuality: targetQuality,
    });
    return false;
  }
  if (
    previous?.resolved &&
    previousTargetNumber &&
    targetNumber &&
    targetNumber < previousTargetNumber
  ) {
    scheduleRuntimeTransition({
      action: "blocked",
      fromQuality: previous.targetQuality,
      reason: "lower-quality",
      source: resolutionDiagnosticSource(resolution),
      toQuality: targetQuality,
    });
    return false;
  }
  const reusePrevious = canReuseSessionTarget(previous, targetQuality, now);
  const targetEpoch = reusePrevious ? previous.targetEpoch : {};
  const validatedNetworkUrls =
    reusePrevious && previous.validatedNetworkUrls instanceof Map
      ? new Map(previous.validatedNetworkUrls)
      : new Map();
  if (resolution.validatedNetworkUrl && !validatedNetworkUrls.has(resolution.validatedNetworkUrl)) {
    validatedNetworkUrls.set(resolution.validatedNetworkUrl, 0);
  }
  while (validatedNetworkUrls.size > MAX_VALIDATED_TARGET_URLS) {
    validatedNetworkUrls.delete(validatedNetworkUrls.keys().next().value);
  }
  const evidenceKind =
    reusePrevious &&
    (previous.evidenceKind === "master" || resolution.evidenceKind === "master")
      ? "master"
      : resolution.evidenceKind;
  const canUpgrade =
    evidenceKind !== "master" &&
    targetNumber &&
    HIGHEST_CONFIGURED_TARGET_NUMBER &&
    targetNumber < HIGHEST_CONFIGURED_TARGET_NUMBER;
  const failedHigherRetryAt = canUpgrade
    ? earliestFailedHigherTargetRetryAt(session, targetQuality, now)
    : null;
  const state = touchSessionState({
    ...session,
    evidenceKind,
    expiresAt: evidenceKind === "url-marker" ? now + markerEvidenceTtlMs() : null,
    lastSuccessfulVerificationSequence: reusePrevious
      ? previous.lastSuccessfulVerificationSequence
      : 0,
    nextUpgradeProbeAt: canUpgrade
      ? reusePrevious && Number.isFinite(previous.nextUpgradeProbeAt)
        ? previous.nextUpgradeProbeAt
        : Math.min(now + upgradeProbeIntervalMs(), failedHigherRetryAt ?? Number.POSITIVE_INFINITY)
      : null,
    resolved: true,
    targetEpoch,
    targetQuality,
    validatedNetworkUrls,
  });
  activeTargetsBySession.set(session.key, state);
  enforceSessionStateLimits(session.key);
  if (previous?.targetQuality !== targetQuality || !previous?.resolved) {
    scheduleRuntimeTransition({
      action: "selected",
      fromQuality: previous?.targetQuality ?? null,
      reason:
        previousTargetNumber && targetNumber && targetNumber > previousTargetNumber
          ? "higher-quality"
          : "initial-selection",
      source: resolutionDiagnosticSource(resolution),
      toQuality: targetQuality,
    });
    scheduleRedirectDiagnostics();
  }
  return true;
}

function invalidateSessionResolution(sessionKey) {
  const activeResolution = resolutionBySession.get(sessionKey);
  activeResolution?.controller.abort();
  resolutionBySession.delete(sessionKey);
}

function sessionFromResolutionState(state) {
  return {
    contextKey: state.contextKey,
    dedicatedHls: state.dedicatedHls,
    familyKey: state.familyKey,
    key: state.key,
    tabId: state.tabId,
  };
}

function startSessionResolution(
  details,
  resolver,
  resolverKind,
  { minimumTargetQuality = null } = {},
) {
  const session = playlistSession(details);
  if (!session) return Promise.resolve(null);
  const token = currentTabContextToken(session.tabId);
  const existing = resolutionBySession.get(session.key);
  if (existing?.token === token) {
    touchSessionState(existing);
    if (resolverKind !== "master" || existing.resolverKind === "master") return existing.promise;
    invalidateSessionResolution(session.key);
  } else {
    existing?.controller.abort();
  }

  const controller = new AbortController();
  const resolutionTimeout = setTimeout(() => controller.abort(), probeResolutionBudgetMs());
  const state = touchSessionState({
    ...session,
    controller,
    minimumTargetQuality,
    promise: null,
    resolverKind,
    token,
  });
  state.promise = Promise.resolve()
    .then(() =>
      resolver({
        signal: controller.signal,
        skipTargetQualities: failedTargetsForSession(sessionFromResolutionState(state)),
      }),
    )
    .then(async (resolution) => {
      if (!resolution?.targetQuality || !resolutionIsCurrent(state)) return null;
      const resolvedTargetNumber = qualityNumber(resolution.targetQuality);
      const minimumTargetNumber = qualityNumber(state.minimumTargetQuality);
      if (
        minimumTargetNumber &&
        (!resolvedTargetNumber || resolvedTargetNumber <= minimumTargetNumber)
      ) {
        return null;
      }
      const resolutionSession =
        state.resolverKind === "master"
          ? sessionForMasterResolution(sessionFromResolutionState(state), resolution)
          : sessionFromResolutionState(state);
      const stored = await setSessionTarget(resolutionSession, resolution, state.token);
      return stored ? resolution.targetQuality : null;
    })
    .catch((error) => {
      if (controller.signal.aborted) return null;
      throw error;
    })
    .finally(() => {
      clearTimeout(resolutionTimeout);
      if (resolutionBySession.get(state.key) === state) resolutionBySession.delete(state.key);
    });
  resolutionBySession.set(session.key, state);
  enforceSessionStateLimits(session.key);
  return state.promise;
}

async function waitForBlockingResolution(promise, budget) {
  return waitWithinBlockingRequestBudget(promise, budget);
}

function startHighestTargetResolution(details, decision, options = {}) {
  return startSessionResolution(
    details,
    ({ signal, skipTargetQualities }) =>
      resolveHighestSupportedQuality(details, decision.quality, { signal, skipTargetQualities }),
    "numeric",
    options,
  );
}

function startMasterTargetResolution(details) {
  return startSessionResolution(
    details,
    async ({ signal }) => {
      const evidence = await fetchPlaylistEvidence(details.url, { signal });
      if (!evidence || signal.aborted) return null;
      const initialResolution = resolveBestVariantFromEvidence(evidence);
      if (!initialResolution) return null;
      const targetSession = sessionForMasterResolution(
        playlistSession(details),
        initialResolution,
      );
      return resolveBestVariantFromEvidence(evidence, {
        skipTargetQualities: failedTargetsForSession(targetSession),
      });
    },
    "master",
  );
}

function forgetMasterResponseObserver(record) {
  if (masterResponseObserversById.get(record.requestId) === record) {
    masterResponseObserversById.delete(record.requestId);
  }
}

function settleMasterResponseObserver(record) {
  if (!record || record.settled) return;
  record.settled = true;
  forgetMasterResponseObserver(record);
}

function attachMasterResponseObserver(details) {
  if (
    typeof api.webRequest.filterResponseData !== "function" ||
    typeof api.webRequest.onHeadersReceived?.addListener !== "function" ||
    typeof api.webRequest.onBeforeRedirect?.addListener !== "function"
  ) {
    return false;
  }
  const requestId = details?.requestId == null ? null : String(details.requestId);
  const session = playlistSession(details);
  const finalNetworkUrl = networkRequestUrl(details?.url);
  if (
    !requestId ||
    requestId.length > 128 ||
    !session ||
    !finalNetworkUrl
  ) {
    return false;
  }

  const existing = masterResponseObserversById.get(requestId);
  if (existing && !existing.settled) {
    const contextMismatch =
      existing.token !== tabContextTokenByTab.get(session.tabId) ||
      existing.session.tabId !== session.tabId ||
      existing.session.contextKey !== session.contextKey;
    const expectedRedirectMismatch =
      existing.expectedRedirectNetworkUrl &&
      existing.expectedRedirectNetworkUrl !== finalNetworkUrl;
    if (contextMismatch || expectedRedirectMismatch) {
      settleMasterResponseObserver(existing);
    } else {
      existing.details = details;
      existing.expectedRedirectNetworkUrl = null;
      existing.finalNetworkUrl = finalNetworkUrl;
      existing.session = session;
      return true;
    }
  }
  if (masterResponseObserversById.size >= MAX_TRACKED_REDIRECT_REQUESTS) return false;

  masterResponseObserversById.set(requestId, {
    details,
    expectedRedirectNetworkUrl: null,
    filterAttached: false,
    finalNetworkUrl,
    requestId,
    session,
    settled: false,
    token: currentTabContextToken(session.tabId),
  });
  return true;
}

function attachMasterResponseFilter(record) {
  let filter;
  try {
    filter = api.webRequest.filterResponseData(record.requestId);
  } catch {
    return false;
  }

  const decoder = new TextDecoder();
  const maxBytes = probeMaxBytes();
  const textChunks = [];
  record.filterAttached = true;
  record.oversized = false;
  record.streamFailed = false;
  record.totalBytes = 0;

  filter.ondata = (event) => {
    try {
      filter.write(event.data);
      const bytes = new Uint8Array(event.data);
      if (!record.oversized) {
        record.totalBytes += bytes.byteLength;
        if (record.totalBytes <= maxBytes) {
          textChunks.push(decoder.decode(bytes, { stream: true }));
        } else {
          record.oversized = true;
          textChunks.length = 0;
        }
      }
    } catch {
      record.streamFailed = true;
      textChunks.length = 0;
    }
  };
  filter.onstop = () => {
    if (record.settled) {
      try {
        filter.close();
      } catch {
        record.streamFailed = true;
      }
      return;
    }
    settleMasterResponseObserver(record);
    try {
      if (
        !record.streamFailed &&
        !record.oversized &&
        record.totalBytes > 0
      ) {
        textChunks.push(decoder.decode());
        let resolution = resolveBestVariantFromEvidence(
          {
            finalUrl: record.finalNetworkUrl,
            text: textChunks.join(""),
          },
        );
        if (resolution) {
          let targetSession = sessionForMasterResolution(record.session, resolution);
          resolution = resolveBestVariantFromEvidence(
            {
              finalUrl: record.finalNetworkUrl,
              text: textChunks.join(""),
            },
            {
              skipTargetQualities: failedTargetsForSession(targetSession),
            },
          );
          if (resolution) {
            targetSession = sessionForMasterResolution(record.session, resolution);
            setSessionTarget(
              targetSession,
              { ...resolution, source: "master-response" },
              record.token,
            );
          }
        }
      }
    } catch (error) {
      reportRedirectError(error).catch(() => {});
      console.warn("[CHZZK] failed to score observed HLS master response", error);
    } finally {
      try {
        filter.close();
      } catch {
        record.streamFailed = true;
      }
    }
  };
  filter.onerror = () => {
    record.streamFailed = true;
    settleMasterResponseObserver(record);
  };
  return true;
}

function handleMasterResponseHeaders(details) {
  const requestId = details?.requestId == null ? null : String(details.requestId);
  if (!requestId) return;
  const record = masterResponseObserversById.get(requestId);
  if (!record || record.settled) return;
  const statusCode = Number(details.statusCode);
  const exactSuccessfulResponse =
    networkRequestUrl(details.url) === record.finalNetworkUrl &&
    Number.isSafeInteger(statusCode) &&
    statusCode >= 200 &&
    statusCode <= 299 &&
    statusCode !== 204 &&
    statusCode !== 205;
  if (exactSuccessfulResponse) {
    if (!record.filterAttached && !attachMasterResponseFilter(record)) {
      settleMasterResponseObserver(record);
      startMasterTargetResolution(record.details).catch((error) => {
        reportRedirectError(error).catch(() => {});
        console.warn("[CHZZK] failed to score trusted HLS master playlist", error);
      });
    }
    return;
  }
  if (statusCode === 304) {
    settleMasterResponseObserver(record);
    return;
  }
  if (Number.isSafeInteger(statusCode) && statusCode >= 300 && statusCode <= 399) return;
  settleMasterResponseObserver(record);
}

function handleMasterResponseRedirect(details) {
  const requestId = details?.requestId == null ? null : String(details.requestId);
  if (!requestId) return;
  const record = masterResponseObserversById.get(requestId);
  if (!record || record.settled) return;
  const redirectNetworkUrl = networkRequestUrl(details?.redirectUrl);
  const redirectDetails = {
    ...record.details,
    ...details,
    url: details?.redirectUrl,
  };
  const redirectOptions = {
    miniPlayerTabIds,
    trustedLiveTabIds: activeLiveTabIds,
  };
  if (
    !redirectNetworkUrl ||
    !isTrustedMasterPlaylistRequest(redirectDetails, policy, redirectOptions)
  ) {
    settleMasterResponseObserver(record);
    return;
  }
  record.expectedRedirectNetworkUrl = redirectNetworkUrl;
}

function scheduleUpwardTargetResolution(details, decision, targetState) {
  if (targetState?.evidenceKind === "master") {
    targetState.nextUpgradeProbeAt = null;
    touchSessionState(targetState);
    return;
  }
  const targetNumber = qualityNumber(targetState?.targetQuality);
  if (
    !targetNumber ||
    !HIGHEST_CONFIGURED_TARGET_NUMBER ||
    targetNumber >= HIGHEST_CONFIGURED_TARGET_NUMBER
  ) {
    if (targetState) targetState.nextUpgradeProbeAt = null;
    return;
  }

  const now = Date.now();
  if (!Number.isFinite(targetState.nextUpgradeProbeAt)) {
    targetState.nextUpgradeProbeAt = now + upgradeProbeIntervalMs();
    touchSessionState(targetState);
    return;
  }
  if (targetState.nextUpgradeProbeAt > now) return;

  targetState.nextUpgradeProbeAt = now + upgradeProbeIntervalMs();
  touchSessionState(targetState);
  startHighestTargetResolution(details, decision, {
    minimumTargetQuality: targetState.targetQuality,
  }).catch((error) => {
    reportRedirectError(error).catch(() => {});
    console.warn("[CHZZK] failed to refresh highest trusted HLS playlist quality", error);
  });
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
  for (const [requestId, state] of masterResponseObserversById) {
    if (state.session.tabId === tabId) {
      state.settled = true;
      masterResponseObserversById.delete(requestId);
    }
  }
  if (dropToken) {
    tabContextTokenByTab.delete(tabId);
  } else {
    tabContextTokenByTab.set(tabId, {});
  }
  return hadTarget;
}

function targetHasInFlightResponseVerification(state) {
  for (const record of redirectedRequestsById.values()) {
    if (
      !record.settled &&
      record.key === state.key &&
      record.targetEpoch === state.targetEpoch &&
      record.targetQuality === state.targetQuality &&
      record.responseVerifierAttached === true &&
      !record.bodyVerificationFailed &&
      (record.bodyEvidence === "pending" || record.bodyEvidence === "valid")
    ) {
      return true;
    }
  }
  return false;
}

function targetCanMigrateAcrossContext(state, now) {
  if (!state?.dedicatedHls || !state.resolved) return false;
  if (state.expiresAt != null && state.expiresAt <= now) return false;
  return (
    (state.validatedNetworkUrls instanceof Map && state.validatedNetworkUrls.size > 0) ||
    targetHasInFlightResponseVerification(state)
  );
}

function migrateFailedTargetsAcrossContext(
  tabId,
  destinationContextKey,
  sourceContextKey,
  now,
) {
  const failureGroups = new Map();
  for (const [oldKey, state] of failedTargetsBySession) {
    if (state.tabId !== tabId) continue;
    failedTargetsBySession.delete(oldKey);
    if (
      !state.dedicatedHls ||
      !(state.targets instanceof Map) ||
      (sourceContextKey && state.contextKey !== sourceContextKey)
    ) {
      continue;
    }
    const targets = new Map(
      [...state.targets].filter(([, expiresAt]) => Number.isFinite(expiresAt) && expiresAt > now),
    );
    if (targets.size === 0) continue;
    const key = JSON.stringify([tabId, destinationContextKey, state.familyKey]);
    const group = failureGroups.get(key) ?? [];
    group.push({
      key,
      state: { ...state, contextKey: destinationContextKey, key, targets },
    });
    failureGroups.set(key, group);
  }
  for (const group of failureGroups.values()) {
    // Never combine suppression from multiple source contexts into one destination family.
    if (group.length !== 1) continue;
    const [{ key, state }] = group;
    failedTargetsBySession.set(key, touchSessionState(state));
  }
}

function migrateTabQualityState(
  tabId,
  destinationContextKey,
  { migratePendingResolutions = false, sourceContextKey = null } = {},
) {
  const now = Date.now();
  const transitionToken = {};
  const tabResolutions = [...resolutionBySession.entries()].filter(
    ([, state]) => state.tabId === tabId,
  );
  const tabTargets = [...activeTargetsBySession.entries()].filter(
    ([, state]) => state.tabId === tabId,
  );
  const resolutionGroups = new Map();
  const targetGroups = new Map();
  const preservedTargetByOldKey = new Map();

  for (const [oldKey, state] of tabResolutions) {
    resolutionBySession.delete(oldKey);
    if (
      !migratePendingResolutions ||
      !state.dedicatedHls ||
      state.controller.signal.aborted ||
      (sourceContextKey && state.contextKey !== sourceContextKey)
    ) {
      state.controller.abort();
      continue;
    }
    const key = JSON.stringify([tabId, destinationContextKey, state.familyKey]);
    const group = resolutionGroups.get(key) ?? [];
    group.push({ key, state });
    resolutionGroups.set(key, group);
  }
  for (const group of resolutionGroups.values()) {
    // Never guess between multiple source contexts for one destination family.
    if (group.length !== 1) {
      for (const { state } of group) state.controller.abort();
      continue;
    }
    const [{ key, state }] = group;
    state.contextKey = destinationContextKey;
    state.key = key;
    state.token = transitionToken;
    resolutionBySession.set(key, touchSessionState(state));
  }
  migrateFailedTargetsAcrossContext(tabId, destinationContextKey, sourceContextKey, now);
  for (const [oldKey, state] of tabTargets) {
    activeTargetsBySession.delete(oldKey);
    if (
      (sourceContextKey && state.contextKey !== sourceContextKey) ||
      !targetCanMigrateAcrossContext(state, now)
    ) {
      continue;
    }
    const key = JSON.stringify([tabId, destinationContextKey, state.familyKey]);
    const target = touchSessionState({ ...state, contextKey: destinationContextKey, key });
    const group = targetGroups.get(key) ?? [];
    group.push({ oldKey, target });
    targetGroups.set(key, group);
  }
  for (const group of targetGroups.values()) {
    // Multiple contexts for one family should not normally coexist. If they do,
    // fail open instead of guessing which stream survived the navigation.
    if (group.length !== 1) continue;
    const [{ oldKey, target }] = group;
    activeTargetsBySession.set(target.key, target);
    preservedTargetByOldKey.set(oldKey, target);
  }
  for (const [requestId, record] of redirectedRequestsById) {
    if (record.tabId !== tabId) continue;
    const target = preservedTargetByOldKey.get(record.key);
    if (target?.targetEpoch === record.targetEpoch && target.targetQuality === record.targetQuality) {
      record.contextKey = target.contextKey;
      record.key = target.key;
      continue;
    }
    record.settled = true;
    redirectedRequestsById.delete(requestId);
  }
  for (const record of masterResponseObserversById.values()) {
    if (record.session.tabId === tabId) settleMasterResponseObserver(record);
  }
  tabContextTokenByTab.set(tabId, transitionToken);
  enforceSessionStateLimits();
  return tabTargets.length > 0;
}

function migrateTabQualityStateToMiniPlayer(tabId) {
  return migrateTabQualityState(tabId, "trusted-request", {
    migratePendingResolutions: true,
    sourceContextKey: liveContextByTab.get(tabId) ?? "trusted-request",
  });
}

function migrateVerifiedContextlessStateToLiveContext(tabId, liveContext) {
  return migrateTabQualityState(tabId, liveContext, { sourceContextKey: "trusted-request" });
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
  // Firefox may retain the original live documentUrl after a same-document
  // pushState into CHZZK's mini-player search/list UI. tabs.onUpdated is
  // authoritative for this mode; accepting that stale URL would repeatedly
  // re-adopt the old live context and discard the migrated target.
  const requestContext = miniPlayerTabIds.has(tabId) ? null : requestLiveContext(details);
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

async function prewarmLiveTab(
  tabId,
  url = null,
  { migrateVerifiedContextless = false } = {},
) {
  if (!isValidRedirectTabId(tabId)) return;
  miniPlayerTabIds.delete(tabId);
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
  const hadTarget = contextChanged
    ? migrateVerifiedContextless && !previousContext && hasUnboundState
      ? migrateVerifiedContextlessStateToLiveContext(tabId, nextContext)
      : dropTabQualityState(tabId)
    : false;
  if (nextContext) liveContextByTab.set(tabId, nextContext);
  const previousSize = activeLiveTabIds.size;
  activeLiveTabIds.add(tabId);
  if (hadTarget || activeLiveTabIds.size !== previousSize) await updateRedirectDiagnostics();
}

async function prewarmCurrentLiveTab(tabId, { migrateVerifiedContextless = false } = {}) {
  if (
    !isValidRedirectTabId(tabId) ||
    miniPlayerTabIds.has(tabId) ||
    typeof api.tabs?.get !== "function"
  ) {
    return;
  }
  const transitionToken = currentTabContextToken(tabId);
  const currentTab = await api.tabs.get(tabId);
  if (
    currentTab?.id !== tabId ||
    tabContextTokenByTab.get(tabId) !== transitionToken ||
    miniPlayerTabIds.has(tabId) ||
    !isChzzkLiveUrl(currentTab.url, policy)
  ) {
    return;
  }
  pendingTrustValidationByTab.delete(tabId);
  await prewarmLiveTab(tabId, currentTab.url, { migrateVerifiedContextless });
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
  const hadMiniPlayer = miniPlayerTabIds.delete(tabId);
  if (hadTarget || hadLiveTab || hadContext || hadMiniPlayer) await updateRedirectDiagnostics();
}

async function preserveSameSiteMiniPlayerState(tabId) {
  if (!isValidRedirectTabId(tabId)) return;
  pendingTrustValidationByTab.delete(tabId);
  const hadTarget = migrateTabQualityStateToMiniPlayer(tabId);
  const hadLiveTab = activeLiveTabIds.delete(tabId);
  const hadContext = liveContextByTab.delete(tabId);
  const addedMiniPlayer = !miniPlayerTabIds.has(tabId);
  miniPlayerTabIds.add(tabId);
  if (hadTarget || hadLiveTab || hadContext || addedMiniPlayer) await updateRedirectDiagnostics();
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
      if (tab?.id === tabId && isChzzkSiteUrl(tab.url, policy)) {
        await preserveSameSiteMiniPlayerState(tabId);
        return false;
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

function forgetRedirectedRequest(record) {
  if (redirectedRequestsById.get(record.requestId) === record) {
    redirectedRequestsById.delete(record.requestId);
  }
}

function settleRedirectedRequest(record) {
  if (record.settled) return;
  const statusCode = record.statusCode;
  if (record.networkFailed) {
    record.settled = true;
    forgetRedirectedRequest(record);
    invalidateRedirectedTarget(record, "network-error");
    return;
  }
  // Body completion can precede webRequest.onCompleted. In particular, a
  // conditional 304 has an empty transfer body but reuses the previously
  // validated cached playlist, so wait for its status before judging emptiness.
  if (!Number.isSafeInteger(statusCode)) return;
  if (statusCode === 304) {
    if (record.bodyEvidence === "pending") return;
    record.settled = true;
    forgetRedirectedRequest(record);
    if (
      record.bodyEvidence === "valid" ||
      (record.bodyEvidence === "empty" && targetPreviouslyValidatedNetworkUrl(record))
    ) {
      renewSuccessfulRedirectTarget(record);
    } else {
      invalidateRedirectedTarget(record, "response-body");
    }
    return;
  }
  const statusFailed =
    statusCode === 204 ||
    statusCode === 205 ||
    (statusCode >= 300 && statusCode <= 399) ||
    (statusCode >= 400 && statusCode <= 599);
  if (statusFailed) {
    record.settled = true;
    forgetRedirectedRequest(record);
    invalidateRedirectedTarget(record, "response-status");
    return;
  }
  if (record.bodyEvidence === "empty" || record.bodyEvidence === "invalid") {
    record.settled = true;
    forgetRedirectedRequest(record);
    invalidateRedirectedTarget(record, "response-body");
    return;
  }
  if (statusCode < 200 || statusCode > 299) return;
  if (record.bodyEvidence === "pending") return;
  record.settled = true;
  forgetRedirectedRequest(record);
  if (record.bodyEvidence === "valid") {
    renewSuccessfulRedirectTarget(record);
  } else {
    invalidateRedirectedTarget(record, "response-body");
  }
}

function attachRedirectBodyVerifier(record) {
  if (typeof api.webRequest.filterResponseData !== "function") return false;
  let filter;
  try {
    filter = api.webRequest.filterResponseData(record.requestId);
  } catch {
    return false;
  }

  record.bodyEvidence = "pending";
  record.bodyVerificationFailed = false;
  record.responseVerifierAttached = false;
  const decoder = new TextDecoder();
  const textChunks = [];
  const maxBytes = probeMaxBytes();
  let totalBytes = 0;
  let oversized = false;
  filter.ondata = (event) => {
    try {
      // The filter owns the response stream once attached. Forward each chunk
      // before doing bounded verification so playback is never held behind parsing.
      filter.write(event.data);
      const bytes = new Uint8Array(event.data);
      if (!oversized) {
        totalBytes += bytes.byteLength;
        if (totalBytes <= maxBytes) {
          textChunks.push(decoder.decode(bytes, { stream: true }));
        } else {
          oversized = true;
          textChunks.length = 0;
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
        textChunks.push(decoder.decode());
        const text = textChunks.join("");
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
  record.responseVerifierAttached = true;
  return true;
}

function attachPendingRedirectBodyVerifier(details) {
  const requestId = details?.requestId == null ? null : String(details.requestId);
  if (!requestId) return false;
  const record = redirectedRequestsById.get(requestId);
  if (
    !record ||
    record.settled ||
    networkRequestUrl(details.url) !== record.redirectNetworkUrl
  ) {
    return false;
  }
  if (record.bodyEvidence === "unavailable") attachRedirectBodyVerifier(record);
  return true;
}

function nextRedirectVerificationSequence() {
  redirectVerificationSequence += 1;
  if (!Number.isSafeInteger(redirectVerificationSequence)) {
    throw new Error("redirect verification sequence exhausted");
  }
  return redirectVerificationSequence;
}

function rememberRedirectedRequest(details, session, targetState, responseUrl) {
  if (details?.requestId == null || !session || !targetState?.targetQuality || !responseUrl) {
    return null;
  }
  const requestId = String(details.requestId);
  const redirectNetworkUrl = networkRequestUrl(responseUrl);
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
    redirectUrl: responseUrl,
    requestId,
    responseVerifierAttached: false,
    sequence: nextRedirectVerificationSequence(),
    settled: false,
    statusCode: null,
    targetEpoch: targetState.targetEpoch,
    targetQuality: targetState.targetQuality,
  };
  redirectedRequestsById.set(requestId, record);
  while (redirectedRequestsById.size > MAX_TRACKED_REDIRECT_REQUESTS) {
    const oldestRequestId = redirectedRequestsById.keys().next().value;
    const oldestRecord = redirectedRequestsById.get(oldestRequestId);
    if (oldestRecord) oldestRecord.settled = true;
    redirectedRequestsById.delete(oldestRequestId);
  }
  return record;
}

function currentTargetMatchesRecord(record) {
  const current = activeTargetsBySession.get(record.key);
  if (current?.targetQuality !== record.targetQuality || current.targetEpoch !== record.targetEpoch) {
    return null;
  }
  return touchSessionState(current);
}

function targetPreviouslyValidatedNetworkUrl(record) {
  const current = currentTargetMatchesRecord(record);
  const validatedSequence = current?.validatedNetworkUrls?.get(record.redirectNetworkUrl);
  return Number.isSafeInteger(validatedSequence) && validatedSequence < record.sequence;
}

function hasNewerPendingVerification(record) {
  for (const pending of redirectedRequestsById.values()) {
    if (
      !pending.settled &&
      pending.key === record.key &&
      pending.targetEpoch === record.targetEpoch &&
      pending.targetQuality === record.targetQuality &&
      pending.sequence > record.sequence
    ) {
      return true;
    }
  }
  return false;
}

function invalidateRedirectedTarget(record, reason = "response-body") {
  const current = currentTargetMatchesRecord(record);
  if (!current) return;
  if (
    current.lastSuccessfulVerificationSequence > record.sequence ||
    hasNewerPendingVerification(record)
  ) {
    return;
  }
  activeTargetsBySession.delete(record.key);
  invalidateSessionResolution(record.key);
  const now = Date.now();
  const failures = failedTargetsBySession.get(record.key) ?? {
    contextKey: record.contextKey,
    dedicatedHls: record.dedicatedHls,
    familyKey: record.familyKey,
    key: record.key,
    tabId: record.tabId,
    targets: new Map(),
  };
  failures.targets.set(record.targetQuality, now + redirectFailureBackoffMs());
  failedTargetsBySession.set(record.key, touchSessionState(failures));
  enforceSessionStateLimits(record.key);
  for (const [requestId, pending] of redirectedRequestsById) {
    if (
      pending.key === record.key &&
      pending.targetEpoch === record.targetEpoch &&
      pending.targetQuality === record.targetQuality &&
      pending.sequence <= record.sequence
    ) {
      pending.settled = true;
      redirectedRequestsById.delete(requestId);
    }
  }
  scheduleRuntimeTransition({
    action: "invalidated",
    fromQuality: record.targetQuality,
    reason,
    source: "redirect-response",
    toQuality: null,
  });
  scheduleRedirectDiagnostics();
}

function renewSuccessfulRedirectTarget(record) {
  const current = currentTargetMatchesRecord(record);
  if (
    !current ||
    !resolutionContextIsCurrent(record.tabId, record.contextKey)
  ) {
    return;
  }
  current.lastSuccessfulVerificationSequence = Math.max(
    current.lastSuccessfulVerificationSequence,
    record.sequence,
  );
  current.validatedNetworkUrls.delete(record.redirectNetworkUrl);
  current.validatedNetworkUrls.set(record.redirectNetworkUrl, record.sequence);
  while (current.validatedNetworkUrls.size > MAX_VALIDATED_TARGET_URLS) {
    current.validatedNetworkUrls.delete(current.validatedNetworkUrls.keys().next().value);
  }
  if (current.evidenceKind === "url-marker") {
    current.expiresAt = Date.now() + markerEvidenceTtlMs();
  }
}

function handleRedirectCompleted(details) {
  const requestId = details?.requestId == null ? null : String(details.requestId);
  if (!requestId) return;
  const masterObserver = masterResponseObserversById.get(requestId);
  if (masterObserver && !masterObserver.filterAttached) {
    settleMasterResponseObserver(masterObserver);
  }
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
  const masterObserver = masterResponseObserversById.get(requestId);
  settleMasterResponseObserver(masterObserver);
  const record = redirectedRequestsById.get(requestId);
  if (!record) return;
  const normalizedError = String(details?.error ?? "").trim().toUpperCase();
  if (CLIENT_CANCELLED_REQUEST_ERRORS.has(normalizedError)) {
    record.settled = true;
    forgetRedirectedRequest(record);
    scheduleRuntimeTransition({
      action: "ignored",
      fromQuality: record.targetQuality,
      reason: "client-cancelled",
      source: "redirect-response",
      toQuality: record.targetQuality,
    });
    return;
  }
  record.networkFailed = true;
  settleRedirectedRequest(record);
}

async function recordRequestDiagnostics(details, decision) {
  await enqueueDiagnosticsMutation((current) => {
    recordDiagnosticUrl(current, details.url, { context: details });
    recordDecision(current, decision, details);
  });
}

function scheduleRequestDiagnostics(details, decision, shouldRecord) {
  if (!shouldRecord) return;
  recordRequestDiagnostics(details, decision).catch((error) =>
    console.warn("[CHZZK] diagnostics recording failed", error),
  );
}

function finalizeEligibleRequest(
  details,
  decision,
  shouldRecord,
  attachedRedirectVerifier,
  session,
  targetState,
) {
  const targetQuality = targetState?.targetQuality ?? null;
  let redirectUrl = null;
  if (targetQuality) {
    redirectUrl = buildHighestQualityRedirectUrl(details.url, {
      minRedirectQuality: policy.minRedirectQuality,
      targetQuality,
    });
    decision = { ...decision, redirectedCurrentRequest: Boolean(redirectUrl), targetQuality };
  }
  if (redirectUrl) {
    rememberRedirectedRequest(details, session, targetState, redirectUrl);
  } else if (
    !attachedRedirectVerifier &&
    targetState?.targetQuality === decision.quality &&
    urlQualityMarkersMatch(details.url, targetState.targetQuality)
  ) {
    const record = rememberRedirectedRequest(details, session, targetState, details.url);
    if (record) attachRedirectBodyVerifier(record);
  }
  scheduleRequestDiagnostics(details, decision, shouldRecord);
  return redirectUrl ? { redirectUrl } : undefined;
}

function resolveTargetForRequest(
  details,
  decision,
  shouldRecord,
  attachedRedirectVerifier,
  session,
  inheritedBudget,
) {
  const blockingBudget = inheritedBudget ?? createBlockingRequestBudget();
  const ownsBudget = inheritedBudget == null;
  let resolution;
  try {
    resolution = startHighestTargetResolution(details, decision);
  } catch (error) {
    if (ownsBudget) blockingBudget.clear();
    scheduleRedirectDiagnostics(String(error?.message ?? error));
    console.warn("[CHZZK] failed to resolve highest trusted HLS playlist quality", error);
    scheduleRequestDiagnostics(details, decision, shouldRecord);
    return undefined;
  }

  const result = waitForBlockingResolution(resolution, blockingBudget)
    .then(() => {
      const targetState = session ? activeTargetForSession(session) : null;
      return finalizeEligibleRequest(
        details,
        decision,
        shouldRecord,
        attachedRedirectVerifier,
        session,
        targetState,
      );
    })
    .catch((error) => {
      scheduleRedirectDiagnostics(String(error?.message ?? error));
      console.warn("[CHZZK] failed to redirect trusted HLS playlist request", error);
      scheduleRequestDiagnostics(details, decision, shouldRecord);
      return undefined;
    });
  return ownsBudget ? result.finally(() => blockingBudget.clear()) : result;
}

function handleTrustedPlaylistRequest(details, attachedRedirectVerifier, inheritedBudget = null) {
  const redirectOptions = { miniPlayerTabIds, trustedLiveTabIds: activeLiveTabIds };
  const shouldRecord = shouldRecordDiagnostics(details, policy, redirectOptions);
  const decision = shouldRedirectRequest(details, policy, redirectOptions);

  if (decision.ok) {
    try {
      const session = playlistSession(details);
      const targetState = session ? activeTargetForSession(session) : null;
      if (!targetState?.targetQuality) {
        return resolveTargetForRequest(
          details,
          decision,
          shouldRecord,
          attachedRedirectVerifier,
          session,
          inheritedBudget,
        );
      }
      if (
        targetState.evidenceKind !== "master" &&
        !resolvedTargetCoversObserved(targetState, decision.quality)
      ) {
        startHighestTargetResolution(details, decision).catch((error) => {
          reportRedirectError(error).catch(() => {});
          console.warn("[CHZZK] failed to resolve highest trusted HLS playlist quality", error);
        });
      } else {
        scheduleUpwardTargetResolution(details, decision, targetState);
      }
      return finalizeEligibleRequest(
        details,
        decision,
        shouldRecord,
        attachedRedirectVerifier,
        session,
        targetState,
      );
    } catch (error) {
      scheduleRedirectDiagnostics(String(error?.message ?? error));
      console.warn("[CHZZK] failed to redirect trusted HLS playlist request", error);
      scheduleRequestDiagnostics(details, decision, shouldRecord);
      return undefined;
    }
  }
  if (isTrustedMasterPlaylistRequest(details, policy, redirectOptions)) {
    if (!attachMasterResponseObserver(details)) {
      startMasterTargetResolution(details).catch((error) => {
        reportRedirectError(error).catch(() => {});
        console.warn("[CHZZK] failed to score trusted HLS master playlist", error);
      });
    }
  }
  scheduleRequestDiagnostics(details, decision, shouldRecord);
  return undefined;
}

function handleRequest(details) {
  if (sweepExpiredSessionState()) scheduleRedirectDiagnostics();
  if (!isHlsPlaylistUrl(details?.url)) return undefined;
  // Firefox keeps requestId stable across redirects and invokes onBeforeRequest
  // again for the target URL. Attach there so the filter sees the HLS response,
  // rather than the bodyless synthetic redirect created by this listener.
  const attachedRedirectVerifier = attachPendingRedirectBodyVerifier(details);
  if (!registerRequestContext(details)) return undefined;
  if (hasTrustedChzzkMetadata(details, policy)) {
    if (!miniPlayerTabIds.has(details.tabId) && isChzzkLiveUrl(details.documentUrl, policy)) {
      pendingTrustValidationByTab.delete(details.tabId);
    }
    return handleTrustedPlaylistRequest(details, attachedRedirectVerifier);
  }

  const validation = pendingTrustValidationByTab.get(details?.tabId);
  if (!validation?.promise) {
    return handleTrustedPlaylistRequest(details, attachedRedirectVerifier);
  }
  const blockingBudget = createBlockingRequestBudget();
  return waitWithinBlockingRequestBudget(validation.promise, blockingBudget)
    .then((trusted) =>
      trusted === true
        ? handleTrustedPlaylistRequest(details, attachedRedirectVerifier, blockingBudget)
        : undefined,
    )
    .finally(() => blockingBudget.clear());
}

function handleRequestSafely(details) {
  try {
    const result = handleRequest(details);
    return typeof result?.then === "function"
      ? result.catch((error) => {
          console.warn("[CHZZK] diagnostics/redirect handling failed", error);
          return undefined;
        })
      : result;
  } catch (error) {
    console.warn("[CHZZK] diagnostics/redirect handling failed", error);
    return undefined;
  }
}

const WEB_REQUEST_FILTER = {
  urls: WEB_REQUEST_URLS,
  types: configuredResourceTypes(policy),
};

api.webRequest.onBeforeRequest.addListener(
  handleRequestSafely,
  WEB_REQUEST_FILTER,
  ["blocking"],
);
api.webRequest.onHeadersReceived?.addListener(
  handleMasterResponseHeaders,
  WEB_REQUEST_FILTER,
  ["blocking"],
);
api.webRequest.onBeforeRedirect?.addListener(handleMasterResponseRedirect, WEB_REQUEST_FILTER);
api.webRequest.onCompleted?.addListener(handleRedirectCompleted, WEB_REQUEST_FILTER);
api.webRequest.onErrorOccurred?.addListener(handleRedirectError, WEB_REQUEST_FILTER);

async function prewarmMessageTab(tabId) {
  await prewarmCurrentLiveTab(tabId, { migrateVerifiedContextless: true });
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
    .flatMap((domain) => [`https://*.${domain}/live`, `https://*.${domain}/live/*`])
    .sort();
}

async function prewarmExistingLiveTabs() {
  if (typeof api.tabs?.query !== "function") return;
  const tabs = await api.tabs.query({ url: liveTabQueryUrls() });
  await Promise.all(
    tabs.map((tab) =>
      prewarmCurrentLiveTab(tab?.id, { migrateVerifiedContextless: true }),
    ),
  );
}

async function refreshAndPrewarmRuntimeState() {
  let prewarmError = null;
  try {
    await prewarmExistingLiveTabs();
  } catch (error) {
    prewarmError = error;
  }
  try {
    // A new background context already starts with empty in-memory maps. Do
    // not clear them from a delayed install/startup event: a playlist request
    // may have established a verified target before that event settles.
    await updateRedirectDiagnostics();
  } catch (error) {
    if (!prewarmError) throw error;
  }
  if (prewarmError) throw prewarmError;
}

api.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo?.status === "loading") {
    if (!changeInfo?.url) {
      clearTabQualityState(tabId).catch((error) =>
        console.warn("[CHZZK] failed to clear tab quality state for document load", error),
      );
      startReloadTrustValidation(tabId)?.catch((error) =>
        console.warn("[CHZZK] failed to validate tab trust after document load", error),
      );
      return;
    }
    miniPlayerTabIds.delete(tabId);
    pendingTrustValidationByTab.delete(tabId);
    if (isChzzkLiveUrl(changeInfo.url, policy)) {
      clearTabQualityState(tabId).catch((error) =>
        console.warn("[CHZZK] failed to clear tab quality state for live document load", error),
      );
      prewarmLiveTab(tabId, changeInfo.url).catch((error) =>
        console.warn("[CHZZK] failed to prewarm live tab from document load", error),
      );
    } else {
      removeTabTrustContext(tabId).catch((error) =>
        console.warn("[CHZZK] failed to clear tab trust context for document load", error),
      );
    }
    return;
  }
  if (!changeInfo?.url) return;
  pendingTrustValidationByTab.delete(tabId);
  if (isChzzkLiveUrl(changeInfo.url, policy)) {
    prewarmLiveTab(tabId, changeInfo.url).catch((error) => console.warn("[CHZZK] failed to prewarm live tab from URL update", error));
    return;
  }
  if (isChzzkSiteUrl(changeInfo.url, policy)) {
    preserveSameSiteMiniPlayerState(tabId).catch((error) =>
      console.warn("[CHZZK] failed to preserve same-site mini-player state", error),
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
  refreshAndPrewarmRuntimeState().catch((error) =>
    console.warn("[CHZZK] startup prewarm failed", error),
  );
});

api.runtime.onStartup?.addListener(() => {
  refreshAndPrewarmRuntimeState().catch((error) =>
    console.warn("[CHZZK] startup prewarm failed", error),
  );
});
