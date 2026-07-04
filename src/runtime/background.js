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
  isValidRedirectTabId,
  shouldRecordDiagnostics,
  shouldRedirectRequest,
} from "../shared/request-policy.js";
import {
  buildHighestQualityRedirectUrl,
  chooseBestHlsVariant,
  normalizeQualityCandidates,
  parseQualityFromUrl,
  qualityNumber,
  replaceQualityInUrl,
} from "../shared/quality.js";

const api = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "chzzkDiagnostics";
const WEB_REQUEST_URLS = configuredWebRequestUrls(policy);
const activeLiveTabIds = new Set();
const activeTargetsByTab = new Map();
const resolvedTargetsByTab = new Set();
let diagnosticsMutationQueue = Promise.resolve();

async function loadDiagnostics() {
  const stored = await api.storage.local.get(STORAGE_KEY);
  return stored?.[STORAGE_KEY] ?? createEmptyDiagnostics({ maxSamples: policy.maxDiagnosticsSamples });
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
  const configured = Number(policy.probeTimeoutMs ?? 1500);
  return Number.isFinite(configured) && configured > 0 ? configured : 1500;
}

function isLikelyHlsPlaylist(text) {
  return /^\s*#EXTM3U/m.test(String(text ?? ""));
}

async function fetchPlaylistText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), probeTimeoutMs());
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const text = await response.text();
    return isLikelyHlsPlaylist(text) ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLooksLikeHlsPlaylist(url) {
  return Boolean(await fetchPlaylistText(url));
}

async function resolveHighestSupportedQuality(details, observedQuality) {
  const observedNumber = qualityNumber(observedQuality);
  if (!observedNumber) return null;

  const candidates = normalizeQualityCandidates(policy.qualityCandidates, {
    include: [observedQuality],
    minRedirectQuality: policy.minRedirectQuality,
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

function bestVariantTargetQuality(variant) {
  return variant?.quality ?? (variant?.resolution?.height ? `${variant.resolution.height}p` : null);
}

async function resolveAndStoreBestVariantFromMaster(details) {
  const playlistText = await fetchPlaylistText(details.url);
  if (!playlistText) return null;

  const variant = chooseBestHlsVariant(playlistText, details.url, {
    minRedirectQuality: policy.minRedirectQuality,
  });
  const targetQuality = bestVariantTargetQuality(variant);
  if (!variant?.url || !targetQuality) return null;

  await setTabTarget(details.tabId, targetQuality, { resolved: true });
  return variant;
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
  const shouldRecord = shouldRecordDiagnostics(details, policy, redirectOptions);
  let decision = shouldRedirectRequest(details, policy, redirectOptions);
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
      await reportRedirectError(error);
      console.warn("[CHZZK] failed to redirect trusted HLS playlist request", error);
    }
  } else if (shouldRecord && decision.reason === "unknown-quality-shape") {
    try {
      await resolveAndStoreBestVariantFromMaster(details);
    } catch (error) {
      await reportRedirectError(error);
      console.warn("[CHZZK] failed to score trusted HLS master playlist", error);
    }
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

api.runtime.onMessage?.addListener((message, sender) => {
  if (message?.type !== "chzzk.live-page-ready") return undefined;
  const tabId = sender?.tab?.id;
  if (!isValidRedirectTabId(tabId)) return undefined;
  // The sender is the packaged MV2 content script, whose manifest match is limited to
  // https://*.chzzk.naver.com/live/*. Firefox can omit sender URL fields, so requiring
  // them here would drop the prewarm before the first HLS playlist request. Prewarm only
  // trusts the tab context; it must not seed a fixed target quality.
  prewarmLiveTab(tabId).catch((error) => console.warn("[CHZZK] failed to prewarm live tab", error));
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
  await Promise.all(tabs.map((tab) => prewarmLiveTab(tab?.id)));
}

async function resetAndPrewarmRuntimeState() {
  await clearRuntimeRedirectState();
  await prewarmExistingLiveTabs();
}

api.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (!changeInfo?.url) return;
  if (isChzzkLiveUrl(changeInfo.url, policy)) {
    prewarmLiveTab(tabId).catch((error) => console.warn("[CHZZK] failed to prewarm live tab from URL update", error));
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
