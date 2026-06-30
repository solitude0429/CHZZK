import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isTelemetryReportSafe,
  makeTelemetryReport,
  routeShapeForChzzkLiveUrl,
  sanitizeErrorText,
  summarizeDiagnosticsForTelemetry,
  summarizeDomStructure,
} from "../../src/shared/telemetry.js";

describe("CHZZK telemetry sanitization", () => {
  it("accepts only CHZZK live routes and redacts live identifiers", () => {
    assert.equal(routeShapeForChzzkLiveUrl("https://chzzk.naver.com/live/channel-123"), "/live/[redacted]");
    assert.equal(routeShapeForChzzkLiveUrl("https://example.com/live/channel-123"), null);
    assert.equal(routeShapeForChzzkLiveUrl("https://chzzk.naver.com/video/123"), null);
  });

  it("summarizes DOM structure without text content, query strings, or long entropy tokens", () => {
    const summary = summarizeDomStructure({
      featureCounts: { video: 1, chatLikeClass: 2 },
      nodes: [
        { tag: "div", classes: ["live_area", "abc123abc123abc123abc123abc123"] },
        { tag: "button", classes: ["quality_button"] },
      ],
      tagCounts: { button: 1, div: 2, video: 1 },
      url: "https://chzzk.naver.com/live/channel-123?session=secret",
    });

    assert.equal(summary.routeShape, "/live/[redacted]");
    assert.equal(typeof summary.structureHash, "string");
    assert.equal(JSON.stringify(summary).includes("channel-123"), false);
    assert.equal(JSON.stringify(summary).includes("secret"), false);
    assert.equal(JSON.stringify(summary).includes("abc123abc123"), false);
    assert.ok(summary.classSummary.some((entry) => entry.token === "quality_button"));
  });

  it("summarizes diagnostics without signed CDN query values", () => {
    const summary = summarizeDiagnosticsForTelemetry({
      decisions: [{ reason: "unknown-quality-shape" }, { reason: "unknown-quality-shape" }],
      generatedAt: "2026-01-01T00:00:00.000Z",
      qualities: { "720p": 2 },
      samples: [
        {
          quality: "720p",
          seenAt: "2026-01-01T00:00:00.000Z",
          type: "media",
          url: "https://cdn.example/live/chunklist_720p.m3u8?Policy=secret&Signature=secret",
        },
      ],
      sessionRules: { activeRuleIds: [100001], activeTabIds: [1], lastError: "boom" },
      totalHlsRequests: 2,
    });

    assert.deepEqual(summary.decisionsByReason, { "unknown-quality-shape": 2 });
    assert.equal(summary.samples[0].url.includes("Policy=secret"), false);
    assert.equal(summary.sessionRules.activeRuleCount, 1);
  });

  it("rejects unsafe reports and sanitizes error URLs", () => {
    const safe = makeTelemetryReport({
      addonId: "chzzk@solitude0429.local",
      eventType: "diagnostics-summary",
      extensionVersion: "0.0.5",
      structure: summarizeDomStructure({ url: "https://chzzk.naver.com/live/a" }),
    });
    assert.equal(isTelemetryReportSafe(safe), true);
    assert.equal(
      sanitizeErrorText("failed https://example.test/path?token=secret"),
      "failed https://example.test/path?[redacted]",
    );
    assert.equal(
      isTelemetryReportSafe({ ...safe, diagnostics: { samples: [{ url: "https://x/?Policy=secret" }] } }),
      false,
    );
  });
});
