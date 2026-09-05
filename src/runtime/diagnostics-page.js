import policy from "../../policy/quality-policy.json";
import { normalizeDiagnostics } from "../shared/diagnostics.js";

const api = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "chzzkDiagnostics";
const summary = document.querySelector("#summary");
const payload = document.querySelector("#payload");
const NORMALIZATION_OPTIONS = { maxSamples: policy.maxDiagnosticsSamples };
let renderSequence = 0;

async function loadDiagnostics() {
  const stored = await api.storage.local.get(STORAGE_KEY);
  return normalizeDiagnostics(stored?.[STORAGE_KEY], NORMALIZATION_OPTIONS);
}

function renderQualitySummary(diagnostics) {
  return Object.entries(diagnostics.qualities ?? {})
    .sort(([a], [b]) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map(([quality, count]) => `${quality}: ${count}`)
    .join("\n");
}

function render(value) {
  const diagnostics = normalizeDiagnostics(value, NORMALIZATION_OPTIONS);
  const runtimeRedirects = diagnostics.runtimeRedirects;
  const lastTransition = diagnostics.runtimeTransitions.at(-1);
  const decisions = diagnostics.decisions;
  const lastDecision = decisions.at(-1);
  const qualities = renderQualitySummary(diagnostics);
  summary.textContent = [
    `generatedAt: ${diagnostics.generatedAt}`,
    `totalHlsRequests: ${diagnostics.totalHlsRequests ?? 0}`,
    `activeTabCount: ${runtimeRedirects.activeTabCount}`,
    `targetQualities: ${runtimeRedirects.targetQualities.join(", ") || "none"}`,
    `runtimeRedirectsUpdatedAt: ${runtimeRedirects.updatedAt}`,
    `lastRuntimeRedirectError: ${runtimeRedirects.lastError ?? "none"}`,
    lastTransition
      ? `lastRuntimeTransition: ${lastTransition.action} / ${lastTransition.reason} / ${lastTransition.fromQuality ?? "none"} -> ${lastTransition.toQuality ?? "none"} / ${lastTransition.source}`
      : "lastRuntimeTransition: none",
    lastDecision
      ? `lastDecision: ${lastDecision.ok ? "ok" : "blocked"} / ${lastDecision.reason}`
      : "lastDecision: none",
    "",
    qualities || "qualities: none",
  ].join("\n");
  payload.value = JSON.stringify(diagnostics, null, 2);
}

async function displayDiagnostics(load) {
  const sequence = ++renderSequence;
  try {
    const diagnostics = await load();
    if (sequence === renderSequence) render(diagnostics);
  } catch {
    if (sequence === renderSequence) throw new Error("Diagnostics operation failed");
  }
}

function refresh() {
  return displayDiagnostics(loadDiagnostics);
}

function bindAction(selector, action, failureMessage) {
  document.querySelector(selector).addEventListener("click", () =>
    action().catch(() => {
      summary.textContent = failureMessage;
    }),
  );
}

bindAction("#refresh", refresh, "Unable to load diagnostics. Try again.");
bindAction(
  "#copy",
  () => navigator.clipboard.writeText(payload.value),
  "Unable to copy diagnostics. Try again.",
);
bindAction(
  "#clear",
  () =>
    displayDiagnostics(async () => {
      const result = await api.runtime.sendMessage({ type: "chzzk.clear-diagnostics" });
      if (result?.ok !== true) throw new Error("Diagnostics clear failed");
      return result.diagnostics;
    }),
  "Unable to clear diagnostics. Try again.",
);

refresh().catch(() => {
  summary.textContent = "Unable to load diagnostics. Try again.";
});
