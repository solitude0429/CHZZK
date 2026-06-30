import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("background hardening invariants", () => {
  const source = readFileSync(new URL("../../src/runtime/background.js", import.meta.url), "utf8");

  it("installs session rules before recording/reporting diagnostics", () => {
    const installIndex = source.indexOf("await ensureTabSessionRule(decision.tabId)");
    const recordIndex = source.indexOf("recordRequestDiagnostics(details, decision)");
    assert.ok(installIndex > -1, "session rule install call must exist");
    assert.ok(recordIndex > -1, "diagnostic recording call must exist");
    assert.ok(installIndex < recordIndex, "redirect bootstrap should not wait behind telemetry");
  });

  it("gates external telemetry through settings and timeout", () => {
    assert.match(source, /isTelemetryEventEnabled\(settings, enriched\.eventType\)/);
    assert.match(source, /TELEMETRY_POST_TIMEOUT_MS/);
    assert.match(source, /pruneReportState/);
  });
});
