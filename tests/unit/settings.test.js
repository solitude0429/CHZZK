import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isTelemetryEventEnabled,
  normalizeSettings,
  telemetryEventCategory,
} from "../../src/shared/settings.js";

describe("telemetry settings", () => {
  it("defaults to local-only collector behavior", () => {
    const settings = normalizeSettings();
    assert.equal(settings.telemetry.collectorEnabled, false);
    assert.equal(isTelemetryEventEnabled(settings, "diagnostics-summary"), false);
  });

  it("gates diagnostics, structure, and error reports independently", () => {
    const settings = normalizeSettings({
      telemetry: {
        collectorEnabled: true,
        sendDiagnostics: true,
        sendErrors: false,
        sendStructure: false,
      },
    });

    assert.equal(isTelemetryEventEnabled(settings, "diagnostics-summary"), true);
    assert.equal(isTelemetryEventEnabled(settings, "site-load"), false);
    assert.equal(isTelemetryEventEnabled(settings, "site-error"), false);

    assert.equal(telemetryEventCategory("session-rule-error"), "errors");
    assert.equal(telemetryEventCategory("site-mutation"), "structure");
  });
});
