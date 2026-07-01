import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildQualityRegexFilter } from "../../src/shared/quality.js";
import {
  buildScopedSessionRule,
  defaultSessionTargetQuality,
  prewarmSessionTargetQuality,
  isTrustedChzzkContext,
  sessionRuleIdForTab,
  shouldBootstrapSessionRule,
  shouldRecordDiagnostics,
} from "../../src/shared/session-rules.js";

const policy = JSON.parse(readFileSync(new URL("../../policy/quality-policy.json", import.meta.url), "utf8"));

describe("session-scoped CHZZK redirect rules", () => {
  it("builds least-privilege DNR rules scoped to a single CHZZK tab and resolved target", () => {
    const targetQuality = "1440p";
    const rule = buildScopedSessionRule({ policy, tabId: 42, targetQuality });

    assert.equal(rule.id, sessionRuleIdForTab(42));
    assert.equal(rule.priority, 1);
    assert.deepEqual(rule.condition.tabIds, [42]);
    assert.deepEqual(rule.condition.initiatorDomains, ["chzzk.naver.com"]);
    assert.deepEqual(rule.condition.requestDomains, ["akamaized.net", "navercdn.com", "pstatic.net"]);
    assert.deepEqual(rule.condition.requestMethods, ["get"]);
    assert.deepEqual([...rule.condition.resourceTypes].sort(), ["media", "xmlhttprequest"]);
    assert.equal(rule.condition.isUrlFilterCaseSensitive, false);
    assert.equal(
      rule.condition.regexFilter,
      buildQualityRegexFilter({
        minRedirectQuality: policy.minRedirectQuality,
        targetQuality,
      }),
    );
    assert.equal(rule.action.type, "redirect");
    assert.equal(rule.action.redirect.regexSubstitution, `\\1${targetQuality}\\3`);
  });

  it("defaults to the highest configured quality candidate", () => {
    assert.equal(defaultSessionTargetQuality(policy), "2160p");
    const rule = buildScopedSessionRule({ policy, tabId: 1 });
    assert.equal(rule.action.redirect.regexSubstitution, "\\12160p\\3");
  });


  it("uses an explicit startup target for first-load prewarm instead of the highest speculative candidate", () => {
    assert.equal(
      prewarmSessionTargetQuality({
        minRedirectQuality: "100p",
        qualityCandidates: ["2160p", "1440p", "1080p", "720p"],
        startupTargetQuality: "1080p",
      }),
      "1080p",
    );
  });

  it("keeps session rule IDs inside the owned cleanup range", () => {
    assert.equal(sessionRuleIdForTab(99_999), 199_999);
    assert.throws(() => sessionRuleIdForTab(100_000), /invalid tabId/);
    assert.throws(() => buildScopedSessionRule({ policy, tabId: 100_000 }), /invalid tabId/);
  });

  it("fails closed unless a numeric HLS request comes from a CHZZK live tab", () => {
    const eligible = {
      documentUrl: "https://chzzk.naver.com/live/example-channel",
      initiator: "https://chzzk.naver.com",
      requestId: "1",
      tabId: 7,
      type: "media",
      url: "https://example.pstatic.net/live/chunklist_720p.m3u8?Policy=redacted",
    };

    assert.equal(isTrustedChzzkContext(eligible, policy), true);
    assert.deepEqual(shouldBootstrapSessionRule(eligible, policy), {
      ok: true,
      quality: "720p",
      reason: "eligible-chzzk-hls-quality",
      tabId: 7,
    });
    assert.deepEqual(
      shouldBootstrapSessionRule(
        { ...eligible, url: "https://example.pstatic.net/live/chunklist_1440p.m3u8" },
        policy,
      ),
      {
        ok: true,
        quality: "1440p",
        reason: "eligible-chzzk-hls-quality",
        tabId: 7,
      },
    );

    assert.equal(
      isTrustedChzzkContext({ ...eligible, documentUrl: "", initiator: "" }, policy),
      false,
      "blank initiator/page context must not be treated as trusted",
    );
    assert.equal(
      shouldBootstrapSessionRule({ ...eligible, documentUrl: "", initiator: "" }, policy).ok,
      false,
    );
    assert.equal(
      shouldBootstrapSessionRule(
        {
          ...eligible,
          documentUrl: "http://chzzk.naver.com/live/example-channel",
          initiator: "http://chzzk.naver.com",
        },
        policy,
      ).ok,
      false,
      "HTTP CHZZK contexts must not bootstrap session redirects",
    );
    assert.equal(shouldBootstrapSessionRule({ ...eligible, tabId: -1 }, policy).ok, false);
    assert.equal(shouldBootstrapSessionRule({ ...eligible, tabId: 100_000 }, policy).ok, false);
    assert.equal(
      shouldBootstrapSessionRule({ ...eligible, url: "https://example.pstatic.net/live/master.m3u8" }, policy)
        .ok,
      false,
    );
  });

  it("does not record diagnostics for unrelated CDN HLS traffic", () => {
    const chzzk = {
      documentUrl: "https://chzzk.naver.com/live/example-channel",
      initiator: "https://chzzk.naver.com",
      tabId: 7,
      type: "media",
      url: "https://example.pstatic.net/live/chunklist_720p.m3u8?Policy=redacted",
    };
    const unrelated = {
      ...chzzk,
      documentUrl: "https://example.com/watch",
      initiator: "https://example.com",
    };

    assert.equal(shouldRecordDiagnostics(chzzk, policy), true);
    assert.equal(shouldRecordDiagnostics(unrelated, policy), false);
  });
});
