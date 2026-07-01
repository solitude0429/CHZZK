const api = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "chzzkDiagnostics";
const summary = document.querySelector("#summary");
const payload = document.querySelector("#payload");

function emptyDiagnostics() {
  return {
    decisions: [],
    generatedAt: new Date(0).toISOString(),
    qualities: {},
    samples: [],
    sessionRules: {
      activeRuleIds: [],
      activeTabIds: [],
      lastError: null,
      updatedAt: new Date(0).toISOString(),
    },
    totalHlsRequests: 0,
  };
}

async function loadDiagnostics() {
  const stored = await api.storage.local.get(STORAGE_KEY);
  return stored?.[STORAGE_KEY] ?? emptyDiagnostics();
}

function renderQualitySummary(diagnostics) {
  return Object.entries(diagnostics.qualities ?? {})
    .sort(([a], [b]) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map(([quality, count]) => `${quality}: ${count}`)
    .join("\n");
}

function render(diagnostics) {
  const sessionRules = diagnostics.sessionRules ?? emptyDiagnostics().sessionRules;
  const decisions = diagnostics.decisions ?? [];
  const lastDecision = decisions.at(-1);
  const qualities = renderQualitySummary(diagnostics);
  summary.textContent = [
    `generatedAt: ${diagnostics.generatedAt}`,
    `totalHlsRequests: ${diagnostics.totalHlsRequests ?? 0}`,
    `activeTabIds: ${(sessionRules.activeTabIds ?? []).join(", ") || "none"}`,
    `activeRuleIds: ${(sessionRules.activeRuleIds ?? []).join(", ") || "none"}`,
    `sessionRulesUpdatedAt: ${sessionRules.updatedAt}`,
    `lastSessionRuleError: ${sessionRules.lastError ?? "none"}`,
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
