import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHZZK_AD_WEB_REQUEST_URLS, chzzkAdRequestDecision } from "../../src/shared/ad-request-policy.js";

function request(url, overrides = {}) {
  return {
    documentUrl: "https://chzzk.naver.com/live/channel-id",
    initiator: "https://chzzk.naver.com",
    method: "GET",
    tabId: 9,
    type: "xmlhttprequest",
    url,
    ...overrides,
  };
}

describe("CHZZK ad request policy", () => {
  it("registers only the current ad-state and detector-bearing detail API routes", () => {
    assert.deepEqual(CHZZK_AD_WEB_REQUEST_URLS, [
      "https://api.chzzk.naver.com/ad-polling/v1/lives/*/ad*",
      "https://api.chzzk.naver.com/service/*/channels/*/live-detail*",
      "https://api.chzzk.naver.com/service/*/videos/*",
      "https://api.chzzk.naver.com/service/v1/lives/*/ads/current*",
      "https://api.chzzk.naver.com/service/v1/seoraksan*",
    ]);
  });

  it("cancels seoraksan, current-ad, and polling requests from CHZZK tabs", () => {
    for (const url of [
      "https://api.chzzk.naver.com/service/v1/seoraksan?pgType=CHZZK_LIVE",
      "https://api.chzzk.naver.com/service/v1/lives/live-id/ads/current",
      "https://api.chzzk.naver.com/ad-polling/v1/lives/live-id/ad?ts=123",
    ]) {
      assert.deepEqual(chzzkAdRequestDecision(request(url)), { cancel: true });
    }
  });

  it("removes only the detector token from live-detail requests", () => {
    const decision = chzzkAdRequestDecision(
      request(
        "https://api.chzzk.naver.com/service/v3/channels/channel-id/live-detail?cu=1&dt=detector&tm=false",
      ),
    );
    assert.equal(
      decision.redirectUrl,
      "https://api.chzzk.naver.com/service/v3/channels/channel-id/live-detail?cu=1&tm=false",
    );
    assert.equal(
      chzzkAdRequestDecision(
        request("https://api.chzzk.naver.com/service/v3/channels/channel-id/live-detail?cu=1&tm=false"),
      ),
      null,
    );
  });

  it("removes only the detector token from video-detail requests", () => {
    const decision = chzzkAdRequestDecision(
      request("https://api.chzzk.naver.com/service/v2/videos/video-id?dt=detector&hl=ko"),
    );
    assert.equal(decision.redirectUrl, "https://api.chzzk.naver.com/service/v2/videos/video-id?hl=ko");
    assert.equal(
      chzzkAdRequestDecision(request("https://api.chzzk.naver.com/service/v2/videos/video-id?hl=ko")),
      null,
    );
  });

  it("fails closed for foreign contexts, methods, types, tabs, hosts, and near-match paths", () => {
    const current = "https://api.chzzk.naver.com/service/v1/lives/live-id/ads/current";
    const cases = [
      request(current, { documentUrl: "https://example.com/", initiator: undefined }),
      request(current, { method: "POST" }),
      request(current, { type: "script" }),
      request(current, { tabId: -1 }),
      request(current.replace("api.chzzk.naver.com", "api.example.com")),
      request(`${current}/unexpected`),
      request(current, { documentUrl: undefined, initiator: undefined }),
      request(current, { documentUrl: "not a URL", initiator: undefined }),
      request("not a URL"),
    ];
    for (const details of cases) assert.equal(chzzkAdRequestDecision(details), null);
  });
});
