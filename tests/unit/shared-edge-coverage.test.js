import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  createEmptyDiagnostics,
  recordDecision,
  recordDiagnosticUrl,
  updateRuntimeRedirectDiagnostics,
} from "../../src/shared/diagnostics.js";
import {
  lowerQualityNumberRegex,
  parseQualitiesFromUrl,
  playlistFamilyKey,
  redactMediaUrl,
  replaceQualityInUrl,
} from "../../src/shared/quality.js";
import {
  configuredRequestMethods,
  configuredResourceTypes,
  hasContradictoryChzzkMetadata,
  hasTrustedChzzkMetadata,
  isChzzkLiveUrl,
  isChzzkSiteUrl,
  isDedicatedChzzkHlsPlaylistUrl,
  isHlsPlaylistUrl,
  isHttpsUrl,
  isTrustedMasterPlaylistRequest,
  isTrustedRequestDomain,
  shouldRecordDiagnostics,
  shouldRedirectRequest,
} from "../../src/shared/request-policy.js";

const policy = JSON.parse(readFileSync(new URL("../../policy/quality-policy.json", import.meta.url), "utf8"));

function eligible(overrides = {}) {
  return {
    documentUrl: "https://chzzk.naver.com/live/example-channel",
    initiator: "https://chzzk.naver.com",
    method: "GET",
    originUrl: undefined,
    tabId: 7,
    type: "xmlhttprequest",
    url: "https://edge.pstatic.net/chzzk/example/chunklist_480p.m3u8?Policy=redacted",
    ...overrides,
  };
}

describe("shared helper defensive branches", () => {
  it("normalizes malformed mutable diagnostics containers before recording", () => {
    const diagnostics = createEmptyDiagnostics({ maxSamples: 2 });
    diagnostics.qualities = [];
    diagnostics.samples = null;
    diagnostics.decisions = null;

    assert.equal(
      recordDiagnosticUrl(diagnostics, eligible().url, {
        context: { tabId: 7, type: "media" },
        now: new Date("2026-01-01T00:00:00.000Z"),
      }),
      true,
    );
    assert.deepEqual(diagnostics.qualities, { "480p": 1 });
    assert.equal(Array.isArray(diagnostics.samples), true);
    assert.equal(recordDiagnosticUrl(diagnostics, "https://example.invalid/not-media", {}), false);
    assert.equal(recordDecision(diagnostics, null), false);
    assert.equal(updateRuntimeRedirectDiagnostics(null), false);
  });

  it("fails closed on malformed URL and numeric-range inputs", () => {
    assert.deepEqual(parseQualitiesFromUrl(null), []);
    assert.deepEqual(parseQualitiesFromUrl("not-a-url/chunklist_720p.m3u8?secret=x"), ["720p"]);
    assert.equal(playlistFamilyKey("not a URL"), null);
    assert.ok(
      playlistFamilyKey("https://edge.pstatic.net/bad%ZZ/720p/chunklist_720p.m3u8"),
      "malformed percent escapes must remain safely opaque",
    );
    assert.equal(redactMediaUrl(""), "");
    assert.equal(redactMediaUrl("ftp://example.test/720p/chunklist.m3u8"), "[redacted-url]");
    assert.equal(replaceQualityInUrl("https://bad host/live/chunklist_480p.m3u8", "1080p"), null);
    assert.throws(() => lowerQualityNumberRegex("100p", "100p"), /invalid quality range/);
    assert.throws(() => lowerQualityNumberRegex("bad", "100p"), /invalid quality range/);
  });

  it("covers malformed URL classifiers and default policy fallbacks", () => {
    const fallbackPolicy = {
      trustedInitiatorDomains: null,
      trustedRequestDomains: null,
      resourceTypes: null,
      requestMethods: null,
    };
    for (const value of [null, "", "not a URL"]) {
      assert.equal(isHttpsUrl(value), false);
      assert.equal(isChzzkLiveUrl(value, policy), false);
      assert.equal(isHlsPlaylistUrl(value), false);
      assert.equal(isChzzkSiteUrl(value, policy), false);
      assert.equal(isTrustedRequestDomain(value, policy), false);
      assert.equal(isDedicatedChzzkHlsPlaylistUrl(value, policy), false);
    }
    assert.deepEqual(configuredResourceTypes(fallbackPolicy), ["media", "other", "xmlhttprequest"]);
    assert.deepEqual(configuredRequestMethods(fallbackPolicy), ["get"]);
    assert.equal(
      isTrustedRequestDomain("https://edge.pstatic.net/live/chunklist_480p.m3u8", fallbackPolicy),
      true,
    );
  });

  it("returns each fail-closed redirect decision for unsupported request shapes", () => {
    assert.equal(
      shouldRedirectRequest(eligible({ type: "script" }), policy).reason,
      "unsupported-resource-type",
    );
    assert.equal(
      shouldRedirectRequest(eligible({ method: "POST" }), policy).reason,
      "unsupported-request-method",
    );
    assert.equal(
      shouldRedirectRequest(eligible({ url: "https://example.invalid/live/chunklist_480p.m3u8" }), policy)
        .reason,
      "untrusted-request-domain",
    );
    assert.equal(
      shouldRedirectRequest(eligible({ documentUrl: "https://example.invalid/watch" }), policy).reason,
      "untrusted-initiator",
    );
    assert.equal(
      shouldRedirectRequest(
        eligible({
          documentUrl: undefined,
          initiator: undefined,
          originUrl: undefined,
          url: "https://edge.pstatic.net/chzzk/example/chunklist_unknown.m3u8",
        }),
        policy,
        { trustedLiveTabIds: new Set([7]) },
      ).reason,
      "unknown-quality-shape",
    );
    assert.equal(
      shouldRedirectRequest(eligible(), { ...policy, minRedirectQuality: "500p" }).reason,
      "quality-below-minimum",
    );
  });

  it("keeps malformed or contradictory metadata out of every trust helper", () => {
    const malformed = eligible({ documentUrl: undefined, initiator: "not a URL" });
    assert.equal(hasContradictoryChzzkMetadata(malformed, policy), true);
    assert.equal(hasTrustedChzzkMetadata(malformed, policy), false);
    assert.equal(shouldRecordDiagnostics(malformed, policy), false);
    assert.equal(
      isTrustedMasterPlaylistRequest(
        eligible({
          documentUrl: undefined,
          initiator: undefined,
          originUrl: undefined,
          url: "https://edge.pstatic.net/chzzk/example/master.m3u8",
        }),
        policy,
      ),
      false,
    );
  });
});
