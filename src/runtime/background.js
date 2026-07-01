import policy from "../../policy/quality-policy.json";
import {
  createEmptyDiagnostics,
  recordDecision,
  recordDiagnosticUrl,
  updateSessionRuleDiagnostics,
} from "../shared/diagnostics.js";
import {
  buildScopedSessionRule,
  isChzzkLiveUrl,
  prewarmSessionTargetQuality,
  sessionRuleIdForTab,
  shouldBootstrapSessionRule,
  shouldRecordDiagnostics,
} from "../shared/session-rules.js";
import {
  buildHighestQualityRedirectUrl,
  normalizeQualityCandidates,
  parseQualityFromUrl,
  qualityNumber,
  replaceQualityInUrl,
} from "../shared/quality.js";

const api = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "chzzkDiagnostics";
const SESSION_RULE_ID_RANGE = 100_000;
const WEB_REQUEST_URLS = policy.trustedRequestDomains.map((domain) => `https://*.${domain}/*`);
const activeRulesByTab = new Map();
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

function currentRuleState(lastError = null) {
  return {
    activeRuleIds: [...activeRulesByTab.values()],
    activeTabIds: [...activeRulesByTab.keys()],
    lastError,
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

function ownedRuleIdsFromSessionRules(rules) {
  const baseId = policy.sessionRuleBaseId ?? 100_000;
  return rules
    .map((rule) => rule.id)
    .filter((id) => Number.isSafeInteger(id) && id >= baseId && id < baseId + SESSION_RULE_ID_RANGE);
}

async function clearOwnedSessionRules() {
  if (!api.declarativeNetRequest?.getSessionRules) return;
  const rules = await api.declarativeNetRequest.getSessionRules();
  const removeRuleIds = ownedRuleIdsFromSessionRules(rules ?? []);
  if (removeRuleIds.length > 0) {
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds });
  }
  activeRulesByTab.clear();
  activeTargetsByTab.clear();
  resolvedTargetsByTab.clear();
  await enqueueDiagnosticsMutation((diagnostics) => {
    updateSessionRuleDiagnostics(diagnostics, currentRuleState());
  });
}

async function ensureTabSessionRule(tabId, targetQuality, { resolved = false } = {}) {
  const ruleId = sessionRuleIdForTab(tabId, { baseId: policy.sessionRuleBaseId ?? 100_000 });
  if (activeRulesByTab.get(tabId) === ruleId && activeTargetsByTab.get(tabId) === targetQuality) {
    if (resolved) resolvedTargetsByTab.add(tabId);
    return;
  }

  const rule = buildScopedSessionRule({ policy, tabId, targetQuality });
  await api.declarativeNetRequest.updateSessionRules({
    addRules: [rule],
    removeRuleIds: [ruleId],
  });
  activeRulesByTab.set(tabId, ruleId);
  activeTargetsByTab.set(tabId, targetQuality);
  if (resolved) resolvedTargetsByTab.add(tabId);
  await enqueueDiagnosticsMutation((diagnostics) => {
    updateSessionRuleDiagnostics(diagnostics, currentRuleState());
  });
}

async function prewarmTabSessionRule(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || tabId >= SESSION_RULE_ID_RANGE) return false;
  const targetQuality = prewarmSessionTargetQuality(policy);
  if (!targetQuality) return false;
  if (activeTargetCoversObserved(tabId, targetQuality)) return true;
  try {
    await ensureTabSessionRule(tabId, targetQuality);
    return true;
  } catch (error) {
    await reportSessionRuleError(error);
    console.warn("[CHZZK] failed to prewarm tab session rule", error);
    return false;
  }
}

async function reportSessionRuleError(error) {
  await enqueueDiagnosticsMutation((current) => {
    updateSessionRuleDiagnostics(current, currentRuleState(String(error?.message ?? error)));
  });
}

async function removeTabSessionRule(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || tabId >= SESSION_RULE_ID_RANGE) return;
  const ruleId =
    activeRulesByTab.get(tabId) ??
    sessionRuleIdForTab(tabId, { baseId: policy.sessionRuleBaseId ?? 100_000 });
  activeRulesByTab.delete(tabId);
  activeTargetsByTab.delete(tabId);
  resolvedTargetsByTab.delete(tabId);
  try {
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    await enqueueDiagnosticsMutation((diagnostics) => {
      updateSessionRuleDiagnostics(diagnostics, currentRuleState());
    });
  } catch (error) {
    await reportSessionRuleError(error);
  }
}

async function recordRequestDiagnostics(details, decision) {
  await enqueueDiagnosticsMutation((current) => {
    recordDiagnosticUrl(current, details.url, { context: details });
    recordDecision(current, decision, details);
  });
}

async function handleRequest(details) {
  const shouldRecord = shouldRecordDiagnostics(details, policy);
  let decision = shouldBootstrapSessionRule(details, policy);
  let redirectUrl = null;

  if (decision.ok) {
    try {
      const targetQuality = resolvedTargetCoversObserved(decision.tabId, decision.quality)
        ? activeTargetsByTab.get(decision.tabId)
        : await resolveHighestSupportedQuality(details, decision.quality);
      if (targetQuality) {
        redirectUrl = buildHighestQualityRedirectUrl(details.url, {
          minRedirectQuality: policy.minRedirectQuality,
          targetQuality,
        });
        await ensureTabSessionRule(decision.tabId, targetQuality, { resolved: true });
        decision = { ...decision, redirectedCurrentRequest: Boolean(redirectUrl), targetQuality };
      }
    } catch (error) {
      await reportSessionRuleError(error);
      console.warn("[CHZZK] failed to redirect/install session redirect rule", error);
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
      console.warn("[CHZZK] diagnostics/session bootstrap failed", error);
      return undefined;
    }),
  {
    urls: WEB_REQUEST_URLS,
    types: policy.resourceTypes,
  },
  ["blocking"],
);

api.runtime.onMessage?.addListener((message, sender) => {
  if (message?.type !== "chzzk.live-page-ready") return false;
  if (!sender?.url || !isChzzkLiveUrl(sender.url, policy)) return false;
  return prewarmTabSessionRule(sender.tab?.id);
});

api.tabs?.onRemoved?.addListener((tabId) => {
  removeTabSessionRule(tabId).catch((error) =>
    console.warn("[CHZZK] failed to remove tab session rule", error),
  );
});

api.runtime.onInstalled?.addListener(() => {
  clearOwnedSessionRules().catch((error) => console.warn("[CHZZK] startup cleanup failed", error));
});

api.runtime.onStartup?.addListener(() => {
  clearOwnedSessionRules().catch((error) => console.warn("[CHZZK] startup cleanup failed", error));
});
