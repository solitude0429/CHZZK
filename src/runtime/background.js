import policy from "../../policy/quality-policy.json";
import {
  createEmptyDiagnostics,
  recordDecision,
  recordDiagnosticUrl,
  updateSessionRuleDiagnostics,
} from "../shared/diagnostics.js";
import {
  buildScopedSessionRule,
  sessionRuleIdForTab,
  shouldBootstrapSessionRule,
  shouldRecordDiagnostics,
} from "../shared/session-rules.js";

const api = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "chzzkDiagnostics";
const activeRulesByTab = new Map();

async function loadDiagnostics() {
  const stored = await api.storage.local.get(STORAGE_KEY);
  return stored?.[STORAGE_KEY] ?? createEmptyDiagnostics({ maxSamples: policy.maxDiagnosticsSamples });
}

async function saveDiagnostics(diagnostics) {
  await api.storage.local.set({ [STORAGE_KEY]: diagnostics });
}

async function mutateDiagnostics(mutator) {
  const diagnostics = await loadDiagnostics();
  mutator(diagnostics);
  await saveDiagnostics(diagnostics);
}

function currentRuleState(lastError = null) {
  return {
    activeRuleIds: [...activeRulesByTab.values()],
    activeTabIds: [...activeRulesByTab.keys()],
    lastError,
  };
}

function ownedRuleIdsFromSessionRules(rules) {
  const baseId = policy.sessionRuleBaseId ?? 100_000;
  return rules
    .map((rule) => rule.id)
    .filter((id) => Number.isSafeInteger(id) && id >= baseId && id < baseId + 100_000);
}

async function clearOwnedSessionRules() {
  if (!api.declarativeNetRequest?.getSessionRules) return;
  const rules = await api.declarativeNetRequest.getSessionRules();
  const removeRuleIds = ownedRuleIdsFromSessionRules(rules ?? []);
  if (removeRuleIds.length > 0) {
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds });
  }
  activeRulesByTab.clear();
  await mutateDiagnostics((diagnostics) => {
    updateSessionRuleDiagnostics(diagnostics, currentRuleState());
  });
}

async function ensureTabSessionRule(tabId) {
  const ruleId = sessionRuleIdForTab(tabId, { baseId: policy.sessionRuleBaseId ?? 100_000 });
  if (activeRulesByTab.get(tabId) === ruleId) return;

  const rule = buildScopedSessionRule({ policy, tabId });
  await api.declarativeNetRequest.updateSessionRules({
    addRules: [rule],
    removeRuleIds: [ruleId],
  });
  activeRulesByTab.set(tabId, ruleId);
  await mutateDiagnostics((diagnostics) => {
    updateSessionRuleDiagnostics(diagnostics, currentRuleState());
  });
}

async function removeTabSessionRule(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId < 0) return;
  const ruleId =
    activeRulesByTab.get(tabId) ??
    sessionRuleIdForTab(tabId, { baseId: policy.sessionRuleBaseId ?? 100_000 });
  activeRulesByTab.delete(tabId);
  try {
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    await mutateDiagnostics((diagnostics) => {
      updateSessionRuleDiagnostics(diagnostics, currentRuleState());
    });
  } catch (error) {
    await mutateDiagnostics((diagnostics) => {
      updateSessionRuleDiagnostics(diagnostics, currentRuleState(String(error?.message ?? error)));
    });
  }
}

async function handleRequest(details) {
  const shouldRecord = shouldRecordDiagnostics(details, policy);
  const decision = shouldBootstrapSessionRule(details, policy);
  if (shouldRecord) {
    await mutateDiagnostics((diagnostics) => {
      recordDiagnosticUrl(diagnostics, details.url, { context: details });
      recordDecision(diagnostics, decision, details);
    });
  }

  if (!decision.ok) return;

  try {
    await ensureTabSessionRule(decision.tabId);
  } catch (error) {
    await mutateDiagnostics((diagnostics) => {
      updateSessionRuleDiagnostics(diagnostics, currentRuleState(String(error?.message ?? error)));
    });
    console.warn("[CHZZK] failed to install session redirect rule", error);
  }
}

api.webRequest.onBeforeRequest.addListener(
  (details) => {
    handleRequest(details).catch((error) =>
      console.warn("[CHZZK] diagnostics/session bootstrap failed", error),
    );
  },
  {
    urls: ["*://*.akamaized.net/*", "*://*.navercdn.com/*", "*://*.pstatic.net/*"],
    types: policy.resourceTypes,
  },
);

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
