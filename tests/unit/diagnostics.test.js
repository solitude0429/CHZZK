import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeDiagnostics,
  createDiagnosticsSnapshot,
  createEmptyDiagnostics,
  recordDecision,
  recordDiagnosticUrl,
  updateSessionRuleDiagnostics,
} from "../../src/shared/diagnostics.js";

describe("diagnostics helpers", () => {
  it("records only redacted HLS samples and quality counters", () => {
    const diagnostics = createEmptyDiagnostics({ maxSamples: 2 });
    recordDiagnosticUrl(diagnostics, "https://cdn.test/live/chunklist_360p.m3u8?Policy=example#frag");
    recordDiagnosticUrl(diagnostics, "https://cdn.test/live/720p/chunklist.m3u8?Signature=example");
    recordDiagnosticUrl(diagnostics, "https://cdn.test/live/chunklist_1080p.m3u8?Key=example");

    const snapshot = createDiagnosticsSnapshot(diagnostics);
    assert.deepEqual(snapshot.qualities, { "360p": 1, "720p": 1, "1080p": 1 });
    assert.equal(snapshot.samples.length, 2, "sample list should be capped");
    assert.equal(snapshot.samples[0].url.includes("Signature=example"), false);
    assert.equal(snapshot.samples[1].url.includes("Key=example"), false);
    assert.equal(snapshot.samples[1].url.endsWith("?[redacted]"), true);
  });

  it("analyzes diagnostics and suggests a higher target when a higher NAVER quality appears", () => {
    const diagnostics = createEmptyDiagnostics({ maxSamples: 10 });
    recordDiagnosticUrl(diagnostics, "https://cdn.test/live/chunklist_1080p.m3u8?Policy=example");
    recordDiagnosticUrl(diagnostics, "https://cdn.test/live/chunklist_1440p.m3u8?Policy=example");

    const analysis = analyzeDiagnostics(createDiagnosticsSnapshot(diagnostics), { targetQuality: "1080p" });
    assert.equal(analysis.highestObservedQuality, "1440p");
    assert.equal(analysis.suggestedTargetQuality, "1440p");
    assert.equal(analysis.needsPolicyUpdate, true);
  });

  it("tracks session-rule state and redacted bootstrap decisions", () => {
    const diagnostics = createEmptyDiagnostics({ maxSamples: 2 });
    updateSessionRuleDiagnostics(diagnostics, { activeRuleIds: [100007], activeTabIds: [7] });
    recordDecision(
      diagnostics,
      { ok: true, quality: "720p", reason: "eligible-lower-quality-chzzk-hls", tabId: 7 },
      { type: "media", url: "https://cdn.test/live/chunklist_720p.m3u8?Policy=example" },
    );

    const snapshot = createDiagnosticsSnapshot(diagnostics);
    assert.deepEqual(snapshot.sessionRules.activeRuleIds, [100007]);
    assert.deepEqual(snapshot.sessionRules.activeTabIds, [7]);
    assert.equal(snapshot.decisions.length, 1);
    assert.equal(snapshot.decisions[0].url.includes("Policy=example"), false);
    assert.equal(snapshot.decisions[0].reason, "eligible-lower-quality-chzzk-hls");
  });
});
