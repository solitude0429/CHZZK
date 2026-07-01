import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  configuredRequiredOrigins,
  configuredResourceTypes,
  configuredWebRequestUrls,
  defaultRedirectTargetQuality,
  isTrustedChzzkContext,
  shouldRecordDiagnostics,
  shouldRedirectRequest,
} from "../../src/shared/request-policy.js";

const policy = JSON.parse(readFileSync(new URL("../../policy/quality-policy.json", import.meta.url), "utf8"));

describe("MV2 required-permission CHZZK redirect request policy", () => {
  it("derives required install permissions from CHZZK and trusted HLS domains", () => {
    assert.deepEqual(configuredRequiredOrigins(policy), [
      "https://*.akamaized.net/*",
      "https://*.chzzk.naver.com/live/*",
      "https://*.gscdn.net/*",
      "https://*.navercdn.com/*",
      "https://*.pstatic.net/*",
    ]);
    assert.deepEqual(
      configuredWebRequestUrls(policy),
      configuredRequiredOrigins(policy),
      "webRequest must observe every required origin so real CHZZK/livecloud playlist hosts are not missed",
    );
    assert.deepEqual([...configuredResourceTypes(policy)].sort(), ["media", "other", "xmlhttprequest"]);
  });

  it("defaults to the highest configured quality candidate", () => {
    assert.equal(defaultRedirectTargetQuality(policy), "2160p");
  });

  it("fails closed unless a numeric HLS request comes from a CHZZK live tab", () => {
    const eligible = {
      documentUrl: "https://chzzk.naver.com/live/example-channel",
      initiator: "https://chzzk.naver.com",
      method: "GET",
      requestId: "1",
      tabId: 7,
      type: "media",
      url: "https://example.pstatic.net/live/chunklist_720p.m3u8?Policy=redacted",
    };

    assert.equal(isTrustedChzzkContext(eligible, policy), true);
    assert.deepEqual(shouldRedirectRequest(eligible, policy), {
      ok: true,
      quality: "720p",
      reason: "eligible-chzzk-hls-quality",
      tabId: 7,
    });
    assert.deepEqual(
      shouldRedirectRequest({ ...eligible, url: "https://example.pstatic.net/live/chunklist_1440p.m3u8" }, policy),
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
    assert.equal(shouldRedirectRequest({ ...eligible, documentUrl: "", initiator: "" }, policy).ok, false);
    assert.equal(
      shouldRedirectRequest(
        {
          ...eligible,
          documentUrl: "http://chzzk.naver.com/live/example-channel",
          initiator: "http://chzzk.naver.com",
        },
        policy,
      ).ok,
      false,
      "HTTP CHZZK contexts must not bootstrap redirects",
    );
    assert.equal(shouldRedirectRequest({ ...eligible, tabId: -1 }, policy).ok, false);
    assert.equal(shouldRedirectRequest({ ...eligible, tabId: 100_000 }, policy).ok, false);
    assert.equal(
      shouldRedirectRequest({ ...eligible, url: "https://example.pstatic.net/live/master.m3u8" }, policy).ok,
      false,
    );
  });

  it("trusts a prewarmed CHZZK live tab even when Firefox omits documentUrl on the first HLS request", () => {
    const eligible = {
      documentUrl: undefined,
      initiator: "https://chzzk.naver.com",
      method: "GET",
      originUrl: undefined,
      tabId: 9,
      type: "xmlhttprequest",
      url: "https://livecloud.pstatic.net.live.gscdn.net/live/chunklist_480p.m3u8?Policy=redacted",
    };

    assert.deepEqual(shouldRedirectRequest(eligible, policy, { trustedLiveTabIds: new Set([9]) }), {
      ok: true,
      quality: "480p",
      reason: "eligible-chzzk-hls-quality",
      tabId: 9,
    });
    assert.equal(shouldRecordDiagnostics(eligible, policy, { trustedLiveTabIds: new Set([9]) }), true);
    assert.equal(shouldRedirectRequest(eligible, policy, { trustedLiveTabIds: new Set([10]) }).ok, false);
  });


  it("covers CHZZK-hosted numeric playlist requests when the site serves HLS from its own domain", () => {
    const eligible = {
      documentUrl: undefined,
      initiator: "https://chzzk.naver.com",
      method: "GET",
      originUrl: undefined,
      tabId: 11,
      type: "xmlhttprequest",
      url: "https://vod.chzzk.naver.com/live/chunklist_480p.m3u8?Policy=redacted",
    };

    assert.equal(shouldRecordDiagnostics(eligible, policy, { trustedLiveTabIds: new Set([11]) }), true);
    assert.deepEqual(shouldRedirectRequest(eligible, policy, { trustedLiveTabIds: new Set([11]) }), {
      ok: true,
      quality: "480p",
      reason: "eligible-chzzk-hls-quality",
      tabId: 11,
    });
  });

  it("covers CHZZK livecloud GSCdn playlist requests and Firefox other-typed HLS requests", () => {
    const eligible = {
      documentUrl: "https://chzzk.naver.com/live/example-channel",
      initiator: "https://chzzk.naver.com",
      method: "GET",
      tabId: 8,
      type: "other",
      url: "https://livecloud.pstatic.net.live.gscdn.net/live/chunklist_720p.m3u8?Policy=redacted",
    };

    assert.equal(shouldRecordDiagnostics(eligible, policy), true);
    assert.deepEqual(shouldRedirectRequest(eligible, policy), {
      ok: true,
      quality: "720p",
      reason: "eligible-chzzk-hls-quality",
      tabId: 8,
    });
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
