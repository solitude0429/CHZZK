(() => {
  // src/shared/settings.js
  var SETTINGS_KEY = "chzzkSettings";
  var DEFAULT_SETTINGS = Object.freeze({
    telemetry: Object.freeze({
      collectorEnabled: false,
      sendDiagnostics: false,
      sendErrors: false,
      sendStructure: false,
    }),
  });
  function asBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }
  function normalizeSettings(value = {}) {
    const telemetry = value?.telemetry ?? {};
    return {
      telemetry: {
        collectorEnabled: asBoolean(telemetry.collectorEnabled, DEFAULT_SETTINGS.telemetry.collectorEnabled),
        sendDiagnostics: asBoolean(telemetry.sendDiagnostics, DEFAULT_SETTINGS.telemetry.sendDiagnostics),
        sendErrors: asBoolean(telemetry.sendErrors, DEFAULT_SETTINGS.telemetry.sendErrors),
        sendStructure: asBoolean(telemetry.sendStructure, DEFAULT_SETTINGS.telemetry.sendStructure),
      },
    };
  }

  // src/runtime/diagnostics-page.js
  var api = globalThis.browser ?? globalThis.chrome;
  var STORAGE_KEY = "chzzkDiagnostics";
  var summary = document.querySelector("#summary");
  var payload = document.querySelector("#payload");
  var telemetryEnabled = document.querySelector("#telemetry-enabled");
  var telemetryDiagnostics = document.querySelector("#telemetry-diagnostics");
  var telemetryStructure = document.querySelector("#telemetry-structure");
  var telemetryErrors = document.querySelector("#telemetry-errors");
  var settingsSummary = document.querySelector("#settings-summary");
  function emptyDiagnostics() {
    return {
      decisions: [],
      generatedAt: /* @__PURE__ */ new Date(0).toISOString(),
      qualities: {},
      samples: [],
      sessionRules: {
        activeRuleIds: [],
        activeTabIds: [],
        lastError: null,
        updatedAt: /* @__PURE__ */ new Date(0).toISOString(),
      },
      totalHlsRequests: 0,
    };
  }
  async function loadDiagnostics() {
    const stored = await api.storage.local.get(STORAGE_KEY);
    return stored?.[STORAGE_KEY] ?? emptyDiagnostics();
  }
  async function loadSettings() {
    const stored = await api.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(stored?.[SETTINGS_KEY]);
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
  function renderSettings(settings) {
    const normalized = normalizeSettings(settings);
    telemetryEnabled.checked = normalized.telemetry.collectorEnabled;
    telemetryDiagnostics.checked = normalized.telemetry.sendDiagnostics;
    telemetryStructure.checked = normalized.telemetry.sendStructure;
    telemetryErrors.checked = normalized.telemetry.sendErrors;
    settingsSummary.textContent = [
      `collector: ${normalized.telemetry.collectorEnabled ? "enabled" : "local-only"}`,
      `diagnostics reports: ${normalized.telemetry.sendDiagnostics ? "on" : "off"}`,
      `structure reports: ${normalized.telemetry.sendStructure ? "on" : "off"}`,
      `error reports: ${normalized.telemetry.sendErrors ? "on" : "off"}`,
    ].join("\n");
  }
  function settingsFromForm() {
    return normalizeSettings({
      telemetry: {
        collectorEnabled: telemetryEnabled.checked,
        sendDiagnostics: telemetryDiagnostics.checked,
        sendErrors: telemetryErrors.checked,
        sendStructure: telemetryStructure.checked,
      },
    });
  }
  async function saveSettingsFromForm() {
    const settings = settingsFromForm();
    await api.storage.local.set({ [SETTINGS_KEY]: settings });
    renderSettings(settings);
  }
  async function refresh() {
    const [diagnostics, settings] = await Promise.all([loadDiagnostics(), loadSettings()]);
    render(diagnostics);
    renderSettings(settings);
  }
  document.querySelector("#refresh").addEventListener("click", refresh);
  document.querySelector("#copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(payload.value);
  });
  document.querySelector("#clear").addEventListener("click", async () => {
    await api.storage.local.remove(STORAGE_KEY);
    await refresh();
  });
  document.querySelector("#save-settings").addEventListener("click", saveSettingsFromForm);
  refresh().catch((error) => {
    summary.textContent = String(error?.stack ?? error);
  });
})();
