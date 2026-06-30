export const SETTINGS_KEY = "chzzkSettings";

export const DEFAULT_SETTINGS = Object.freeze({
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

export function normalizeSettings(value = {}) {
  const telemetry = value?.telemetry ?? {};
  return {
    telemetry: {
      collectorEnabled: asBoolean(
        telemetry.collectorEnabled,
        DEFAULT_SETTINGS.telemetry.collectorEnabled,
      ),
      sendDiagnostics: asBoolean(
        telemetry.sendDiagnostics,
        DEFAULT_SETTINGS.telemetry.sendDiagnostics,
      ),
      sendErrors: asBoolean(telemetry.sendErrors, DEFAULT_SETTINGS.telemetry.sendErrors),
      sendStructure: asBoolean(
        telemetry.sendStructure,
        DEFAULT_SETTINGS.telemetry.sendStructure,
      ),
    },
  };
}

export function telemetryEventCategory(eventType) {
  const type = String(eventType ?? "");
  if (
    type === "session-rule-error" ||
    type.includes("error") ||
    type.includes("unhandledrejection")
  ) {
    return "errors";
  }
  if (type.startsWith("site-")) return "structure";
  if (type === "diagnostics-summary") return "diagnostics";
  return "diagnostics";
}

export function isTelemetryEventEnabled(settings, eventType) {
  const { telemetry } = normalizeSettings(settings);
  if (!telemetry.collectorEnabled) return false;

  switch (telemetryEventCategory(eventType)) {
    case "errors":
      return telemetry.sendErrors;
    case "structure":
      return telemetry.sendStructure;
    case "diagnostics":
      return telemetry.sendDiagnostics;
    default:
      return false;
  }
}
