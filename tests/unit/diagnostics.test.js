import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeDiagnostics,
  createDiagnosticsSnapshot,
  createEmptyDiagnostics,
  normalizeDiagnostics,
  recordDecision,
  recordDiagnosticUrl,
  recordRuntimeTransition,
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
    recordRuntimeTransition(diagnostics, {
      action: "selected",
      fromQuality: null,
      reason: "initial-selection",
      source: "master-response",
      toQuality: "1440p",
    });

    const snapshot = createDiagnosticsSnapshot(diagnostics);
    assert.deepEqual(snapshot.runtimeRedirects.activeTabCount, 1);
    assert.deepEqual(snapshot.runtimeRedirects.targetQualities, ["1440p"]);
    assert.equal(snapshot.decisions.length, 1);
    assert.equal(snapshot.decisions[0].url.includes("Policy=example"), false);
    assert.equal(snapshot.decisions[0].reason, "eligible-chzzk-hls-quality");
    assert.equal(snapshot.decisions[0].targetQuality, "1440p");
    assert.equal(snapshot.decisions[0].redirectedCurrentRequest, true);
    assert.deepEqual(
      snapshot.runtimeTransitions.map(({ action, fromQuality, reason, source, toQuality }) => ({
        action,
        fromQuality,
        reason,
        source,
        toQuality,
      })),
      [
        {
          action: "selected",
          fromQuality: null,
          reason: "initial-selection",
          source: "master-response",
          toQuality: "1440p",
        },
      ],
    );
  });

  it("normalizes persisted diagnostics to an exact bounded schema and tail-trims arrays", () => {
    const timestamp = "2026-07-15T00:00:00.000Z";
    const validSample = {
      extra: "drop-me",
      quality: "720p",
      seenAt: timestamp,
      tabId: 7,
      type: "media",
      url: "https://stream-identifier.pstatic.net:8443/private/720p/chunklist.m3u8?Policy=synthetic",
    };
    const validDecision = {
      extra: "drop-me",
      ok: false,
      quality: "720p",
      reason: "contradictory-quality-markers",
      redirectedCurrentRequest: false,
      seenAt: timestamp,
      tabId: 7,
      targetQuality: null,
      type: "xmlhttprequest",
      url: validSample.url,
    };
    const normalized = normalizeDiagnostics(
      {
        decisions: [validDecision, validDecision, { ...validDecision, ok: "false" }],
        generatedAt: "not-a-date",
        maxSamples: Number.MAX_SAFE_INTEGER,
        qualities: {
          "720p": -1,
          "1080p": "3",
          "1440p": Number.MAX_SAFE_INTEGER,
          unknown: 4,
        },
        runtimeRedirects: {
          activeTabIds: [-1, 7, 7, Number.MAX_SAFE_INTEGER, "8"],
          extra: "drop-me",
          lastError: "x".repeat(1000),
          targetsByTab: { 7: "1080p", 8: "invalid", bad: "2160p" },
          updatedAt: "not-a-date",
        },
        runtimeTransitions: [
          {
            action: "blocked",
            extra: "drop-me",
            fromQuality: "1440p",
            reason: "lower-quality",
            seenAt: timestamp,
            source: "master-probe",
            toQuality: "720p",
          },
          {
            action: "invented",
            fromQuality: "1440p",
            reason: "secret-bearing arbitrary reason",
            seenAt: timestamp,
            source: "unknown",
            toQuality: "720p",
          },
        ],
        samples: [validSample, validSample, { ...validSample, quality: [] }],
        totalHlsRequests: "7",
        unknownTopLevel: "drop-me",
      },
      { maxSamples: 2 },
    );

    assert.deepEqual(Object.keys(normalized), [
      "decisions",
      "generatedAt",
      "maxSamples",
      "qualities",
      "runtimeRedirects",
      "runtimeTransitions",
      "samples",
      "totalHlsRequests",
    ]);
    assert.equal(normalized.maxSamples, 2);
    assert.equal(normalized.generatedAt, new Date(0).toISOString());
    assert.equal(normalized.totalHlsRequests, 0, "wrongly typed counters reset to zero");
    assert.deepEqual(normalized.qualities, { "1440p": Number.MAX_SAFE_INTEGER });
    assert.equal(normalized.samples.length, 1, "tail trim occurs before invalid records are dropped");
    assert.deepEqual(Object.keys(normalized.samples[0]), ["quality", "seenAt", "type", "url"]);
    assert.equal(normalized.samples[0].url, "https://pstatic.net/[redacted-path]/720p.m3u8?[redacted]");
    assert.equal(normalized.decisions.length, 1);
    assert.deepEqual(Object.keys(normalized.decisions[0]), [
      "ok",
      "quality",
      "reason",
      "redirectedCurrentRequest",
      "seenAt",
      "targetQuality",
      "type",
      "url",
    ]);
    assert.deepEqual(normalized.runtimeRedirects.activeTabCount, 2);
    assert.deepEqual(normalized.runtimeRedirects.targetQualities, ["1080p"]);
    assert.equal(normalized.runtimeRedirects.lastError, "runtime-error");
    assert.deepEqual(Object.keys(normalized.runtimeRedirects), [
      "activeTabCount",
      "lastError",
      "targetQualities",
      "updatedAt",
    ]);
    assert.deepEqual(normalized.runtimeTransitions, [
      {
        action: "blocked",
        fromQuality: "1440p",
        reason: "lower-quality",
        seenAt: timestamp,
        source: "master-probe",
        toQuality: "720p",
      },
    ]);
  });

  it("saturates valid counters and resets corrupt counters before recording", () => {
    const saturated = createEmptyDiagnostics({ maxSamples: 2 });
    saturated.totalHlsRequests = Number.MAX_SAFE_INTEGER;
    saturated.qualities["720p"] = Number.MAX_SAFE_INTEGER;
    recordDiagnosticUrl(saturated, "https://edge.pstatic.net/live/chunklist_720p.m3u8");
    assert.equal(saturated.totalHlsRequests, Number.MAX_SAFE_INTEGER);
    assert.equal(saturated.qualities["720p"], Number.MAX_SAFE_INTEGER);

    const reset = normalizeDiagnostics(
      {
        qualities: { "720p": -5, "1080p": 1.5 },
        totalHlsRequests: Number.POSITIVE_INFINITY,
      },
      { maxSamples: 2 },
    );
    assert.equal(reset.totalHlsRequests, 0);
    assert.deepEqual(reset.qualities, {});
  });

  it("does not retain a full CDN host, port, or signed URL in runtime error diagnostics", () => {
    const normalized = normalizeDiagnostics({
      runtimeRedirects: {
        lastError:
          "fetch failed for https://stream-account-identifier.pstatic.net:8443/private/master.m3u8?Policy=synthetic",
      },
    });

    assert.equal(normalized.runtimeRedirects.lastError, "runtime-error");
    assert.doesNotMatch(JSON.stringify(normalized), /stream-account-identifier|8443|Policy=synthetic/);
  });
});
