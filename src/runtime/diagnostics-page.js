import policy from "../../policy/quality-policy.json";
import { normalizeDiagnostics } from "../shared/diagnostics.js";

const api = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "chzzkDiagnostics";
const summary = document.querySelector("#summary");
const payload = document.querySelector("#payload");
const status = document.querySelector("#status");
const refreshButton = document.querySelector("#refresh");
const copyButton = document.querySelector("#copy");
const clearButton = document.querySelector("#clear");
const NORMALIZATION_OPTIONS = { maxSamples: policy.maxDiagnosticsSamples };

function setStatus(message, { error = false } = {}) {
  if (!status) return;
  status.textContent = message;
  status.dataset.state = error ? "error" : "ok";
}

async function loadDiagnostics() {
  const stored = await api.storage.local.get(STORAGE_KEY);
  return normalizeDiagnostics(stored?.[STORAGE_KEY], NORMALIZATION_OPTIONS);
}

function renderQualitySummary(diagnostics) {
  return Object.entries(diagnostics.qualities ?? {})
    .sort(([left], [right]) => Number.parseInt(left, 10) - Number.parseInt(right, 10))
    .map(([quality, count]) => `${quality}: ${count}`)
    .join("\n");
}

function renderTargetSummary(runtimeRedirects) {
  const targets = Object.entries(runtimeRedirects.targetsByTab ?? {})
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([tabId, target]) => `${tabId}:${target}`);
  return targets.join(", ") || "none";
}

function render(value) {
  const diagnostics = normalizeDiagnostics(value, NORMALIZATION_OPTIONS);
  const runtimeRedirects = diagnostics.runtimeRedirects;
  const decisions = diagnostics.decisions;
  const lastDecision = decisions.at(-1);
  const qualities = renderQualitySummary(diagnostics);
  summary.textContent = [
    `generatedAt: ${diagnostics.generatedAt}`,
    `totalHlsRequests: ${diagnostics.totalHlsRequests ?? 0}`,
    `activeTabIds: ${(runtimeRedirects.activeTabIds ?? []).join(", ") || "none"}`,
    `targetsByTab: ${renderTargetSummary(runtimeRedirects)}`,
    `runtimeRedirectsUpdatedAt: ${runtimeRedirects.updatedAt}`,
    `lastRuntimeRedirectError: ${runtimeRedirects.lastError ?? "none"}`,
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

async function runAction(action, successMessage) {
  try {
    await action();
    setStatus(successMessage);
  } catch (error) {
    const message = String(error?.message ?? error);
    setStatus(message, { error: true });
    summary.textContent = `오류: ${message}`;
  }
}

refreshButton?.addEventListener("click", () =>
  runAction(refresh, "진단 정보를 새로고침했습니다."),
);
copyButton?.addEventListener("click", () =>
  runAction(async () => navigator.clipboard.writeText(payload.value), "JSON을 복사했습니다."),
);
clearButton?.addEventListener("click", () =>
  runAction(async () => {
    if (typeof api.runtime?.sendMessage === "function") {
      const response = await api.runtime.sendMessage({ type: "chzzk.clear-diagnostics" });
      if (response?.ok !== true) throw new Error("진단 로그 삭제를 확인하지 못했습니다.");
    } else {
      await api.storage.local.remove(STORAGE_KEY);
    }
    await refresh();
  }, "진단 로그를 삭제했습니다."),
);

refresh().catch((error) => {
  const message = String(error?.stack ?? error);
  summary.textContent = message;
  setStatus(message, { error: true });
});
