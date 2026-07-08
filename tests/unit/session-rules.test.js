import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  configuredRequiredOrigins,
  configuredResourceTypes,
  configuredWebRequestUrls,
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

  it("trusts CHZZK live context, CHZZK initiator, or known CHZZK/livecloud HLS URL shapes", () => {
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
      shouldRedirectRequest(
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
      "blank initiator/page context must not trust a generic CDN playlist shape",
    );
    assert.equal(shouldRedirectRequest({ ...eligible, documentUrl: "", initiator: "" }, policy).ok, false);
    assert.deepEqual(
      shouldRedirectRequest(
        {
          ...eligible,
          documentUrl: undefined,
          originUrl: undefined,
          initiator: "https://chzzk.naver.com",
        },
        policy,
      ),
      {
        ok: true,
        quality: "720p",
        reason: "eligible-chzzk-hls-quality",
        tabId: 7,
      },
      "CHZZK initiator alone must be enough for the first HLS request when Firefox omits page URLs",
    );
    assert.deepEqual(
      shouldRedirectRequest(
        {
          ...eligible,
          documentUrl: undefined,
          initiator: undefined,
          originUrl: undefined,
          url: "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/360p/segment/chunklist_480p.m3u8?Policy=redacted",
        },
        policy,
      ),
      {
        ok: true,
        quality: "360p",
        reason: "eligible-chzzk-hls-quality",
        tabId: 7,
      },
      "CHZZK-marked HLS URLs must redirect without content-script prewarm or page request metadata",
    );
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
      initiator: undefined,
      method: "GET",
      originUrl: undefined,
      tabId: 9,
      type: "xmlhttprequest",
      url: "https://example.pstatic.net/live/chunklist_480p.m3u8?Policy=redacted",
    };

    assert.deepEqual(shouldRedirectRequest(eligible, policy, { trustedLiveTabIds: new Set([9]) }), {
      ok: true,
      quality: "480p",
      reason: "eligible-chzzk-hls-quality",
      tabId: 9,
    });
    assert.equal(shouldRecordDiagnostics(eligible, policy, { trustedLiveTabIds: new Set([9]) }), true);
    assert.equal(shouldRedirectRequest(eligible, policy, { trustedLiveTabIds: new Set([10]) }).ok, false);

    assert.deepEqual(
      shouldRedirectRequest(
        { ...eligible, url: "http://example.pstatic.net/live/chunklist_480p.m3u8?Policy=redacted" },
        policy,
        { trustedLiveTabIds: new Set([9]) },
      ),
      { ok: false, reason: "non-https-request-url", tabId: 9 },
      "request URL protocol must be checked inside the policy, not only by manifest filters",
    );
    assert.equal(
      shouldRecordDiagnostics(
        { ...eligible, url: "http://example.pstatic.net/live/chunklist_480p.m3u8?Policy=redacted" },
        policy,
        { trustedLiveTabIds: new Set([9]) },
      ),
      false,
    );
  });

  it("does not trust generic livecloud-looking CDN HLS outside CHZZK request context", () => {
    const request = {
      documentUrl: undefined,
      initiator: undefined,
      method: "GET",
      originUrl: undefined,
      tabId: 12,
      type: "media",
      url: "https://example-livecloud.pstatic.net/live/chunklist_720p.m3u8?Policy=redacted",
    };

    assert.equal(shouldRedirectRequest(request, policy).ok, false);
    assert.equal(shouldRecordDiagnostics(request, policy), false);
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
    assert.deepEqual(
      shouldRedirectRequest(
        {
          ...eligible,
          documentUrl: undefined,
          initiator: undefined,
          originUrl: undefined,
        },
        policy,
      ),
      {
        ok: true,
        quality: "720p",
        reason: "eligible-chzzk-hls-quality",
        tabId: 8,
      },
      "known CHZZK livecloud playlist host must not depend on content-script or tab prewarm timing",
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
