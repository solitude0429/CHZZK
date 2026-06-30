import policy from "../../policy/quality-policy.json";
import {
  analyzeDiagnostics,
  createDiagnosticsSnapshot,
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
import {
  isChzzkLivePageUrl,
  isTelemetryReportSafe,
  makeTelemetryReport,
  stableHash,
  TELEMETRY_ENDPOINT,
  TELEMETRY_SCOPE,
} from "../shared/telemetry.js";
import { isTelemetryEventEnabled, normalizeSettings, SETTINGS_KEY } from "../shared/settings.js";

const api = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "chzzkDiagnostics";
const REPORT_STATE_KEY = "chzzkTelemetryReportState";
const TELEMETRY_MIN_REPORT_INTERVAL_MS = 5 * 60 * 1000;
const REPORT_DEDUPE_TTL_MS = 60 * 60 * 1000;
const TELEMETRY_POST_TIMEOUT_MS = 2000;
const SESSION_RULE_ID_RANGE = 100_000;
const activeRulesByTab = new Map();
let diagnosticsMutationQueue = Promise.resolve();

function extensionIdentity() {
  const manifest = api.runtime.getManifest();
  return {
    addonId: manifest.browser_specific_settings?.gecko?.id ?? "chzzk@solitude0429.local",
    extensionVersion: manifest.version,
  };
}

async function loadSettings() {
  const stored = await api.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored?.[SETTINGS_KEY]);
}

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

async function loadReportState() {
  const stored = await api.storage.local.get(REPORT_STATE_KEY);
  return stored?.[REPORT_STATE_KEY] ?? { lastSentAt: 0, sentByKey: {} };
}

async function saveReportState(state) {
  await api.storage.local.set({ [REPORT_STATE_KEY]: state });
}

function pruneReportState(state, now = Date.now()) {
  const sentByKey = {};
  for (const [key, sentAt] of Object.entries(state?.sentByKey ?? {})) {
    const timestamp = Number(sentAt);
    if (Number.isFinite(timestamp) && now - timestamp < REPORT_DEDUPE_TTL_MS) {
      sentByKey[key] = timestamp;
    }
  }
  return {
    lastSentAt: Number(state?.lastSentAt ?? 0) || 0,
    sentByKey,
  };
}

function telemetryDedupeKey(report) {
  return stableHash({
    diagnostics: report.diagnostics
      ? {
          decisionsByReason: report.diagnostics.decisionsByReason,
          qualities: report.diagnostics.qualities,
          sessionRules: report.diagnostics.sessionRules,
          totalHlsRequests: report.diagnostics.totalHlsRequests,
        }
      : null,
    eventType: report.eventType,
    structureHash: report.structure?.structureHash ?? null,
  });
}

async function postTelemetryReport(report, { force = false } = {}) {
  const enriched = {
    ...report,
    ...extensionIdentity(),
    scope: TELEMETRY_SCOPE,
  };
  if (!isTelemetryReportSafe(enriched)) return false;

  const settings = await loadSettings();
  if (!isTelemetryEventEnabled(settings, enriched.eventType)) return false;

  const now = Date.now();
  const state = pruneReportState(await loadReportState(), now);
  const key = telemetryDedupeKey(enriched);
  const previous = Number(state.sentByKey?.[key] ?? 0);
  if (!force && previous && now - previous < REPORT_DEDUPE_TTL_MS) return false;
  if (!force && now - Number(state.lastSentAt ?? 0) < TELEMETRY_MIN_REPORT_INTERVAL_MS) return false;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEMETRY_POST_TIMEOUT_MS);
  try {
    const response = await fetch(TELEMETRY_ENDPOINT, {
      body: JSON.stringify(enriched),
      cache: "no-store",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`telemetry report failed: HTTP ${response.status}`);
  } finally {
    clearTimeout(timeoutId);
  }

  state.lastSentAt = now;
  state.sentByKey = { ...(state.sentByKey ?? {}), [key]: now };
  await saveReportState(state);
  return true;
}

function diagnosticsReportFromSnapshot(snapshot, eventType) {
  return makeTelemetryReport({
    diagnostics: snapshot,
    eventType,
    ...extensionIdentity(),
  });
}

async function maybeReportDiagnostics(snapshot, decision) {
  const analysis = analyzeDiagnostics(snapshot, { targetQuality: policy.targetQuality });
  const interesting = Boolean(
    analysis.needsPolicyUpdate ||
      snapshot.sessionRules?.lastError ||
      decision?.reason === "unknown-quality-shape" ||
      decision?.ok,
  );
  if (!interesting) return;
  await postTelemetryReport(diagnosticsReportFromSnapshot(snapshot, "diagnostics-summary")).catch((error) => {
    console.warn("[CHZZK] telemetry report failed", error);
  });
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
  await enqueueDiagnosticsMutation((diagnostics) => {
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
  await enqueueDiagnosticsMutation((diagnostics) => {
    updateSessionRuleDiagnostics(diagnostics, currentRuleState());
  });
}

async function reportSessionRuleError(error) {
  const { diagnostics } = await enqueueDiagnosticsMutation((current) => {
    updateSessionRuleDiagnostics(current, currentRuleState(String(error?.message ?? error)));
  });
  await postTelemetryReport(
    diagnosticsReportFromSnapshot(createDiagnosticsSnapshot(diagnostics), "session-rule-error"),
    { force: true },
  ).catch(() => {});
}

async function removeTabSessionRule(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || tabId >= SESSION_RULE_ID_RANGE) return;
  const ruleId =
    activeRulesByTab.get(tabId) ??
    sessionRuleIdForTab(tabId, { baseId: policy.sessionRuleBaseId ?? 100_000 });
  activeRulesByTab.delete(tabId);
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
  const { diagnostics } = await enqueueDiagnosticsMutation((current) => {
    recordDiagnosticUrl(current, details.url, { context: details });
    recordDecision(current, decision, details);
  });
  await maybeReportDiagnostics(createDiagnosticsSnapshot(diagnostics), decision);
}

async function handleRequest(details) {
  const shouldRecord = shouldRecordDiagnostics(details, policy);
  const decision = shouldBootstrapSessionRule(details, policy);

  if (decision.ok) {
    try {
      await ensureTabSessionRule(decision.tabId);
    } catch (error) {
      await reportSessionRuleError(error);
      console.warn("[CHZZK] failed to install session redirect rule", error);
    }
  }

  if (shouldRecord) {
    recordRequestDiagnostics(details, decision).catch((error) =>
      console.warn("[CHZZK] diagnostics recording/reporting failed", error),
    );
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

api.runtime.onMessage?.addListener((message, sender) => {
  if (message?.type !== "chzzk.telemetry.report" || message?.scope !== TELEMETRY_SCOPE) return false;
  if (sender?.url && !isChzzkLivePageUrl(sender.url)) return false;
  return postTelemetryReport(message.report, {
    force: String(message.report?.eventType ?? "").includes("error"),
  });
});

api.tabs?.onRemoved?.addListener((tabId) => {
  removeTabSessionRule(tabId).catch((error) =>
    console.warn("[CHZZK] failed to remove tab session rule", error),
  );
});

api.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (!activeRulesByTab.has(tabId)) return;
  const nextUrl = changeInfo?.url;
  if (typeof nextUrl !== "string" || isChzzkLivePageUrl(nextUrl)) return;
  removeTabSessionRule(tabId).catch((error) =>
    console.warn("[CHZZK] failed to remove inactive tab session rule", error),
  );
});

api.runtime.onInstalled?.addListener(() => {
  clearOwnedSessionRules().catch((error) => console.warn("[CHZZK] startup cleanup failed", error));
});

api.runtime.onStartup?.addListener(() => {
  clearOwnedSessionRules().catch((error) => console.warn("[CHZZK] startup cleanup failed", error));
});
