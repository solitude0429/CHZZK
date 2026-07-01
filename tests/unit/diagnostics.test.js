import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeDiagnostics,
  createDiagnosticsSnapshot,
  createEmptyDiagnostics,
  recordDecision,
  recordDiagnosticUrl,
  updateRuntimeRedirectDiagnostics,
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

  it("analyzes diagnostics and suggests adding a higher observed candidate", () => {
    const diagnostics = createEmptyDiagnostics({ maxSamples: 10 });
    recordDiagnosticUrl(diagnostics, "https://cdn.test/live/chunklist_1080p.m3u8?Policy=example");
    recordDiagnosticUrl(diagnostics, "https://cdn.test/live/chunklist_1440p.m3u8?Policy=example");

    const analysis = analyzeDiagnostics(createDiagnosticsSnapshot(diagnostics), {
      qualityCandidates: ["1080p", "720p"],
    });
    assert.equal(analysis.highestObservedQuality, "1440p");
    assert.equal(analysis.highestConfiguredQuality, "1080p");
    assert.deepEqual(analysis.suggestedQualityCandidates, ["1440p", "1080p", "720p"]);
    assert.equal(analysis.needsPolicyUpdate, true);
  });

  it("does not suggest a policy update when candidates already cover the observation", () => {
    const diagnostics = createEmptyDiagnostics({ maxSamples: 10 });
    recordDiagnosticUrl(diagnostics, "https://cdn.test/live/chunklist_1440p.m3u8?Policy=example");

    const analysis = analyzeDiagnostics(createDiagnosticsSnapshot(diagnostics), {
      qualityCandidates: ["2160p", "1440p", "1080p"],
    });
    assert.equal(analysis.highestObservedQuality, "1440p");
    assert.equal(analysis.highestConfiguredQuality, "2160p");
    assert.equal(analysis.needsPolicyUpdate, false);
  });

  it("tracks MV2 runtime redirect state and redacted bootstrap decisions", () => {
    const diagnostics = createEmptyDiagnostics({ maxSamples: 2 });
    updateRuntimeRedirectDiagnostics(diagnostics, {
      activeTabIds: [7],
      targetsByTab: { 7: "1440p" },
    });
    recordDecision(
      diagnostics,
      {
        ok: true,
        quality: "720p",
        reason: "eligible-chzzk-hls-quality",
        redirectedCurrentRequest: true,
        tabId: 7,
        targetQuality: "1440p",
      },
      { type: "media", url: "https://cdn.test/live/chunklist_720p.m3u8?Policy=example" },
    );

    const snapshot = createDiagnosticsSnapshot(diagnostics);
    assert.deepEqual(snapshot.runtimeRedirects.activeTabIds, [7]);
    assert.deepEqual(snapshot.runtimeRedirects.targetsByTab, { 7: "1440p" });
    assert.equal(snapshot.decisions.length, 1);
    assert.equal(snapshot.decisions[0].url.includes("Policy=example"), false);
    assert.equal(snapshot.decisions[0].reason, "eligible-chzzk-hls-quality");
    assert.equal(snapshot.decisions[0].targetQuality, "1440p");
    assert.equal(snapshot.decisions[0].redirectedCurrentRequest, true);
  });
});
