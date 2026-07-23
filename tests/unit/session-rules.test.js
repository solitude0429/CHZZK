import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  configuredRequiredOrigins,
  configuredResourceTypes,
  configuredWebRequestUrls,
  isChzzkSiteUrl,
  isTrustedChzzkContext,
  isTrustedMasterPlaylistRequest,
  shouldRecordDiagnostics,
  shouldRedirectRequest,
} from "../../src/shared/request-policy.js";

const policy = JSON.parse(readFileSync(new URL("../../policy/quality-policy.json", import.meta.url), "utf8"));

describe("MV2 required-permission CHZZK redirect request policy", () => {
  it("recognizes only HTTPS CHZZK site URLs for same-site navigation state", () => {
    assert.equal(isChzzkSiteUrl("https://chzzk.naver.com/lives?keyword=channel", policy), true);
    assert.equal(isChzzkSiteUrl("https://m.chzzk.naver.com/", policy), true);
    assert.equal(isChzzkSiteUrl("http://chzzk.naver.com/lives", policy), false);
    assert.equal(isChzzkSiteUrl("https://chzzk.naver.com.example/lives", policy), false);
    assert.equal(isChzzkSiteUrl("https://example.com/lives", policy), false);
  });

  it("derives required install permissions from CHZZK and trusted HLS domains", () => {
    assert.deepEqual(configuredRequiredOrigins(policy), [
      "https://*.akamaized.net/*",
      "https://*.chzzk.naver.com/*",
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

  it("trusts CHZZK context or the narrowly scoped dedicated-livecloud fallback", () => {
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
    const originOnly = {
      ...eligible,
      documentUrl: undefined,
      originUrl: undefined,
      initiator: "https://chzzk.naver.com",
    };
    const originUrlOnly = {
      ...originOnly,
      initiator: undefined,
      originUrl: "https://chzzk.naver.com",
    };
    for (const request of [originOnly, originUrlOnly]) {
      assert.equal(
        shouldRedirectRequest(request, policy).ok,
        false,
        "origin-only CHZZK metadata must not authorize a generic CDN without live-tab evidence",
      );
      assert.deepEqual(
        shouldRedirectRequest(request, policy, { trustedLiveTabIds: new Set([7]) }),
        {
          ok: true,
          quality: "720p",
          reason: "eligible-chzzk-hls-quality",
          tabId: 7,
        },
        "an authoritatively prewarmed live tab may use a generic trusted CDN",
      );
    }
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
      "the dedicated livecloud host must work without content prewarm or page request metadata",
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
    assert.equal(
      shouldRedirectRequest({ ...eligible, tabId: 100_000 }, policy).ok,
      true,
      "Firefox tab IDs must not be rejected by an undocumented local upper bound",
    );
    assert.equal(shouldRedirectRequest({ ...eligible, tabId: Number.MAX_SAFE_INTEGER }, policy).ok, true);
    assert.equal(
      shouldRedirectRequest({ ...eligible, url: "https://example.pstatic.net/live/master.m3u8" }, policy).ok,
      false,
    );
    assert.deepEqual(
      shouldRedirectRequest(
        {
          ...eligible,
          url: "https://example.pstatic.net/live/720p/segment.ts?next=chunklist_720p.m3u8",
        },
        policy,
      ),
      { ok: false, reason: "non-playlist-path", tabId: 7 },
      "quality markers in non-playlist media paths must never be redirected",
    );
  });

  it("recognizes trusted master playlists without treating numeric playlists as masters", () => {
    const master = {
      documentUrl: undefined,
      initiator: "https://chzzk.naver.com",
      method: "GET",
      originUrl: undefined,
      tabId: 100_001,
      type: "xmlhttprequest",
      url: "https://example.pstatic.net/live/master.m3u8?Policy=redacted",
    };

    assert.equal(
      isTrustedMasterPlaylistRequest(master, policy),
      false,
      "origin-only CHZZK metadata must not authorize a generic master playlist",
    );
    assert.equal(
      isTrustedMasterPlaylistRequest(
        {
          ...master,
          initiator: undefined,
          originUrl: "https://chzzk.naver.com",
        },
        policy,
      ),
      false,
      "originUrl-only CHZZK metadata must retain the same generic master boundary",
    );
    assert.equal(
      isTrustedMasterPlaylistRequest(master, policy, {
        trustedLiveTabIds: new Set([100_001]),
      }),
      true,
      "a prewarmed live tab may authorize a generic master playlist",
    );
    assert.equal(
      isTrustedMasterPlaylistRequest(
        {
          ...master,
          url: "https://nvelop-livecloud.pstatic.net/chzzk/example/master.m3u8?Policy=redacted",
        },
        policy,
      ),
      true,
      "origin-only metadata may still use the dedicated livecloud master fallback",
    );
    assert.equal(
      isTrustedMasterPlaylistRequest(
        { ...master, url: "https://example.pstatic.net/live/chunklist_720p.m3u8?Policy=redacted" },
        policy,
      ),
      false,
    );
    assert.equal(
      isTrustedMasterPlaylistRequest({ ...master, initiator: "https://example.com" }, policy),
      false,
    );
    assert.equal(
      isTrustedMasterPlaylistRequest(
        { ...master, url: "http://example.pstatic.net/live/master.m3u8" },
        policy,
      ),
      false,
    );
    assert.equal(
      isTrustedMasterPlaylistRequest(
        { ...master, url: "https://example.pstatic.net/api/data?next=master.m3u8" },
        policy,
      ),
      false,
      "playlist-looking query parameters must not be classified as HLS requests",
    );
  });

  it("reports contradictory quality markers as a distinct fail-closed decision", () => {
    const request = {
      documentUrl: "https://chzzk.naver.com/live/example-channel",
      initiator: "https://chzzk.naver.com",
      method: "GET",
      originUrl: undefined,
      tabId: 14,
      type: "xmlhttprequest",
      url: "https://edge.pstatic.net/chzzk/session/1080p/segment/chunklist_2160p.m3u8?Policy=redacted",
    };

    assert.deepEqual(shouldRedirectRequest(request, policy), {
      ok: false,
      quality: "1080p",
      reason: "contradictory-quality-markers",
      tabId: 14,
    });
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

  it("lets explicit non-CHZZK document and origin metadata veto stale prewarmed trust", () => {
    const cachedTrust = { trustedLiveTabIds: new Set([9]) };
    const request = {
      documentUrl: undefined,
      initiator: undefined,
      method: "GET",
      originUrl: undefined,
      tabId: 9,
      type: "xmlhttprequest",
      url: "https://example.pstatic.net/live/chunklist_480p.m3u8?Policy=redacted",
    };

    assert.equal(
      shouldRedirectRequest(
        { ...request, documentUrl: "https://unrelated.example/watch" },
        policy,
        cachedTrust,
      ).ok,
      false,
    );
    assert.equal(
      shouldRedirectRequest({ ...request, originUrl: "https://unrelated.example/watch" }, policy, cachedTrust)
        .ok,
      false,
    );
    assert.equal(
      shouldRedirectRequest(
        {
          ...request,
          documentUrl: "https://chzzk.naver.com/live/example-channel",
          originUrl: "https://unrelated.example/watch",
        },
        policy,
        cachedTrust,
      ).ok,
      false,
      "contradictory page metadata must fail closed even when one field is CHZZK live",
    );
    assert.equal(
      isTrustedMasterPlaylistRequest(
        {
          ...request,
          documentUrl: "https://unrelated.example/watch",
          url: "https://example.pstatic.net/live/master.m3u8?Policy=redacted",
        },
        policy,
        cachedTrust,
      ),
      false,
      "master requests must use the same stale-trust veto",
    );
  });

  it("continues same-site CHZZK mini-player playback only on dedicated livecloud hosts", () => {
    const miniPlayer = {
      documentUrl: "https://chzzk.naver.com/lives?keyword=another-channel",
      initiator: "https://chzzk.naver.com",
      method: "GET",
      originUrl: undefined,
      tabId: 15,
      type: "xmlhttprequest",
      url: "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/480p/segment/chunklist_480p.m3u8?Policy=redacted",
    };

    assert.deepEqual(shouldRedirectRequest(miniPlayer, policy), {
      ok: true,
      quality: "480p",
      reason: "eligible-chzzk-hls-quality",
      tabId: 15,
    });
    assert.equal(
      isTrustedMasterPlaylistRequest(
        {
          ...miniPlayer,
          url: "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/master.m3u8?Policy=redacted",
        },
        policy,
      ),
      true,
    );

    const genericCdn = {
      ...miniPlayer,
      url: "https://edge.pstatic.net/chzzk/example/chunklist_480p.m3u8?Policy=redacted",
    };
    assert.equal(shouldRedirectRequest(genericCdn, policy).ok, false);
    assert.equal(
      shouldRedirectRequest(genericCdn, policy, { trustedLiveTabIds: new Set([15]) }).ok,
      false,
      "explicit non-live page evidence must override stale prewarmed live-tab trust",
    );
    assert.equal(
      isTrustedMasterPlaylistRequest(
        {
          ...genericCdn,
          url: "https://edge.pstatic.net/chzzk/example/master.m3u8?Policy=redacted",
        },
        policy,
      ),
      false,
    );
  });

  it("rejects generic-CDN CHZZK path markers without page context", () => {
    const request = {
      documentUrl: undefined,
      initiator: undefined,
      method: "GET",
      originUrl: undefined,
      tabId: 13,
      type: "media",
      url: "https://edge.pstatic.net/chzzk/live/360p/chunklist_480p.m3u8?Policy=redacted",
    };

    assert.equal(shouldRedirectRequest(request, policy).ok, false);
    assert.equal(shouldRecordDiagnostics(request, policy), false);
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
    assert.equal(
      shouldRedirectRequest(
        {
          ...eligible,
          documentUrl: "https://unrelated.example/watch",
          initiator: "https://unrelated.example",
          originUrl: undefined,
        },
        policy,
      ).ok,
      false,
      "the dedicated-host compatibility fallback must never override contradictory metadata",
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
