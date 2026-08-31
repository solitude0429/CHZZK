import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createChzzkAdResponseController,
  rewriteChzzkAdResponseBytes,
  sanitizeChzzkAdResponse,
} from "../../src/runtime/ad-response-controller.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function currentMidrollFixture() {
  return {
    requestId: "0123456789abcdef0123456789abcdef",
    head: {
      version: "0.0.1",
      description: "Naver SSP Waterfall List",
    },
    eventTracking: {
      ackImpressions: [{ url: "https://tivan.naver.com/sc2/1/" }],
      activeViewImpressions: [{ url: "https://tivan.naver.com/sc2/2/" }],
      clicks: [{ url: "https://tivan.naver.com/sc2/3/" }],
      completions: [{ url: "https://tivan.naver.com/sc2/4/" }],
      attached: [{ url: "https://tivan.naver.com/sc2/10/" }],
      renderedImpressions: [{ url: "https://tivan.naver.com/sc2/11/" }],
      viewableImpressions: [{ url: "https://tivan.naver.com/sc2/12/" }],
      loadErrors: [{ url: "https://tivan.naver.com/sc2/91/" }],
      startErrors: [{ url: "https://tivan.naver.com/sc2/92/" }],
      lazyRenderMediaFailed: [{ url: "https://tivan.naver.com/sc2/93/" }],
      mute: [{ url: "https://tivan.naver.com/sc2/5/" }],
      close: [{ url: "https://tivan.naver.com/sc2/6/" }],
    },
    adUnit: "w_live_chzzk_naver_va_mid",
    randomNumber: 96,
    adDivId: "midAdPlayerWrapper",
    videoSkipMin: 5,
    videoSkipAfter: 5,
    ads: [
      {
        encrypted: "redacted",
        connectionType: "redacted",
        adProviderType: "redacted",
        adProviderName: "NDP Video",
        layoutType: "redacted",
        creativeType: "VIDEO",
        renderType: "GV",
        eventTracking: {},
        adInfo: {},
        vastSkippable: true,
        vastMaxRedirect: 4,
      },
      {
        encrypted: "redacted",
        connectionType: "redacted",
        adProviderName: "GFP",
        layoutType: "redacted",
        creativeType: "VIDEO",
        renderType: "EMPTY",
        eventTracking: {},
        adInfo: {},
      },
    ],
  };
}

function decodeJson(bytes) {
  return JSON.parse(decoder.decode(bytes));
}

describe("CHZZK ad response controller", () => {
  it("empties the current tivan-based midroll waterfall while preserving its context", () => {
    const source = currentMidrollFixture();
    const sanitized = sanitizeChzzkAdResponse(source);

    assert.deepEqual(sanitized.ads, []);
    assert.equal(sanitized.adUnit, "w_live_chzzk_naver_va_mid");
    assert.equal(sanitized.adDivId, "midAdPlayerWrapper");
    assert.equal(sanitized.randomNumber, 96);
    assert.equal(sanitized.eventTracking, source.eventTracking);
    assert.equal(sanitized.head, source.head);

    const eventUnit = currentMidrollFixture();
    eventUnit.adUnit = `event_${eventUnit.adUnit}`;
    assert.deepEqual(sanitizeChzzkAdResponse(eventUnit).ads, []);

    const vodUnit = currentMidrollFixture();
    vodUnit.adUnit = "w_chzzk_naver_va";
    assert.deepEqual(sanitizeChzzkAdResponse(vodUnit).ads, []);

    const vodMidUnit = currentMidrollFixture();
    vodMidUnit.adUnit = "w_chzzk_naver_va_mid";
    assert.deepEqual(sanitizeChzzkAdResponse(vodMidUnit).ads, []);
  });

  it("replaces a populated GFP schedule with the player-compatible empty shell", () => {
    const source = {
      head: { version: "0.0.1", description: "GFP Video Ad Schedule" },
      requestId: "vas-redacted",
      videoAdScheduleId: "LIVE_CHZZK_NDP_SCH",
      adBreaks: [
        {
          id: "MID-1",
          startDelay: 120,
          preFetch: 30,
          adUnitId: "w_live_chzzk_naver_va_mid",
          adSources: [{ id: "MID-1-1", withRemindAd: 0 }],
        },
      ],
    };

    const sanitized = sanitizeChzzkAdResponse(source);
    assert.deepEqual(sanitized, {
      ...source,
      adBreaks: [{ id: "", startDelay: 0, preFetch: 0, adUnitId: "", adSources: [] }],
    });
    assert.equal(sanitizeChzzkAdResponse(sanitized), null);

    const eventSource = {
      ...source,
      videoAdScheduleId: "LIVE_CHZZK_NDP_SCH_EVENT",
      adBreaks: source.adBreaks.map((adBreak) => ({
        ...adBreak,
        adUnitId: `event_${adBreak.adUnitId}`,
      })),
    };
    assert.deepEqual(sanitizeChzzkAdResponse(eventSource).adBreaks[0].adSources, []);
  });

  it("replaces the exact current VOD pre- and mid-roll schedule with the empty shell", () => {
    const source = {
      head: { version: "0.0.1", description: "GFP Video Ad Schedule" },
      requestId: "vod-schedule-redacted",
      videoAdScheduleId: "CHZZK_NDP_SCH",
      adBreaks: ["pre", "mid"].map((roll, index) => ({
        id: `synthetic-${roll}-roll`,
        startDelay: index * 60,
        preFetch: 5,
        adUnitId: roll === "mid" ? "w_chzzk_naver_va_mid" : "w_chzzk_naver_va",
        adSources: [{ id: `synthetic-${roll}-source` }],
      })),
      passthrough: { videoId: "synthetic-video" },
    };

    const sanitized = sanitizeChzzkAdResponse(source);
    assert.deepEqual(sanitized, {
      ...source,
      adBreaks: [{ id: "", startDelay: 0, preFetch: 0, adUnitId: "", adSources: [] }],
    });
    assert.equal(sanitized.passthrough, source.passthrough);
    assert.equal(sanitizeChzzkAdResponse(sanitized), null);
  });

  it("fails open for ordinary JSON, binary data, empty ads, and lookalike objects", () => {
    assert.equal(sanitizeChzzkAdResponse({ head: { description: "ordinary" }, ads: [1] }), null);
    assert.equal(
      sanitizeChzzkAdResponse({
        head: { description: "Naver SSP Waterfall List" },
        ads: [],
      }),
      null,
    );
    assert.equal(rewriteChzzkAdResponseBytes(new Uint8Array([0, 1, 2, 3])), null);
    assert.equal(rewriteChzzkAdResponseBytes(encoder.encode('{"value":1}')), null);

    const lookalike = currentMidrollFixture();
    lookalike.adUnit = "w_other_naver_va_mid";
    assert.equal(sanitizeChzzkAdResponse(lookalike), null);

    const wrongVersion = currentMidrollFixture();
    wrongVersion.head = { ...wrongVersion.head, version: "0.0.2" };
    assert.equal(sanitizeChzzkAdResponse(wrongVersion), null);

    const wrongSchedule = {
      requestId: "redacted",
      head: { version: "0.0.1", description: "GFP Video Ad Schedule" },
      videoAdScheduleId: "OTHER_NAVER_SCHEDULE",
      adBreaks: [{ adUnitId: "w_live_chzzk_naver_va_mid", adSources: [{}] }],
    };
    assert.equal(sanitizeChzzkAdResponse(wrongSchedule), null);

    const emptyVodSchedule = {
      ...wrongSchedule,
      videoAdScheduleId: "CHZZK_NDP_SCH",
      adBreaks: [{ adUnitId: "w_chzzk_naver_va", adSources: [] }],
    };
    assert.equal(sanitizeChzzkAdResponse(emptyVodSchedule), null);

    const malformedVodSchedule = {
      ...emptyVodSchedule,
      adBreaks: [{ adUnitId: "", adSources: [{}] }],
    };
    assert.equal(sanitizeChzzkAdResponse(malformedVodSchedule), null);

    const vodScheduleWithLiveUnit = {
      ...emptyVodSchedule,
      adBreaks: [{ adUnitId: "w_live_chzzk_naver_va_mid", adSources: [{}] }],
    };
    assert.equal(sanitizeChzzkAdResponse(vodScheduleWithLiveUnit), null);

    const liveScheduleWithVodUnit = {
      ...emptyVodSchedule,
      videoAdScheduleId: "LIVE_CHZZK_NDP_SCH",
      adBreaks: [{ adUnitId: "w_chzzk_naver_va", adSources: [{}] }],
    };
    assert.equal(sanitizeChzzkAdResponse(liveScheduleWithVodUnit), null);

    const unobservedVodPostUnit = {
      ...emptyVodSchedule,
      adBreaks: [{ adUnitId: "w_chzzk_naver_va_post", adSources: [{}] }],
    };
    assert.equal(sanitizeChzzkAdResponse(unobservedVodPostUnit), null);

    const unobservedVodPostWaterfall = currentMidrollFixture();
    unobservedVodPostWaterfall.adUnit = "w_chzzk_naver_va_post";
    assert.equal(sanitizeChzzkAdResponse(unobservedVodPostWaterfall), null);

    const populatedVodBreak = {
      adUnitId: "w_chzzk_naver_va",
      adSources: [{}],
    };
    const invalidMixedVodBreaks = [
      { adUnitId: "w_chzzk_naver_va_post", adSources: [{}] },
      { adUnitId: "w_live_chzzk_naver_va_mid", adSources: [{}] },
      { adUnitId: "w_chzzk_naver_va_mid", adSources: [] },
      null,
      { adUnitId: "w_chzzk_naver_va_mid", adSources: [null] },
    ];
    for (const invalidBreak of invalidMixedVodBreaks) {
      assert.equal(
        sanitizeChzzkAdResponse({
          ...emptyVodSchedule,
          adBreaks: [populatedVodBreak, invalidBreak],
        }),
        null,
      );
    }
  });

  it("rewrites a BOM-prefixed current response without requiring the retired siape trackers", () => {
    const text = `\ufeff  ${JSON.stringify(currentMidrollFixture())}`;
    const rewritten = rewriteChzzkAdResponseBytes(encoder.encode(text));
    const parsed = decodeJson(rewritten);

    assert.deepEqual(parsed.ads, []);
    assert.equal(parsed.eventTracking.ackImpressions[0].url, "https://tivan.naver.com/sc2/1/");
    assert.equal(parsed.randomNumber, 96);
  });

  it("installs once, preserves typed-array subclass construction, and restores cleanly", () => {
    const appended = [];
    const documentRef = {
      createElement(tagName) {
        return {
          attributes: new Map(),
          removed: false,
          setAttribute(name, value) {
            this.attributes.set(name, value);
          },
          remove() {
            this.removed = true;
          },
          tagName,
          textContent: "",
        };
      },
      head: {
        append(node) {
          appended.push(node);
        },
      },
    };
    const globalRef = {
      JSON,
      Proxy,
      Reflect,
      TextDecoder,
      TextEncoder,
      Uint8Array,
    };
    const original = globalRef.Uint8Array;
    const controller = createChzzkAdResponseController({ documentRef, globalRef });

    controller.start();
    const installed = globalRef.Uint8Array;
    controller.start();
    assert.equal(globalRef.Uint8Array, installed);
    assert.notEqual(installed, original);
    assert.equal(appended.length, 1);
    assert.match(appended[0].textContent, /ad_blocking_info_layer/);
    assert.match(appended[0].textContent, /#live_rs_banner/);
    assert.match(appended[0].textContent, /#vod_rs_banner/);
    assert.match(
      appended[0].textContent,
      /\.webplayer-internal-core-ad-ui,[\s\S]*display:\s*none\s*!important/,
    );

    class ChildBytes extends globalRef.Uint8Array {}
    const rewritten = new ChildBytes(encoder.encode(JSON.stringify(currentMidrollFixture())));
    assert.ok(rewritten instanceof ChildBytes);
    assert.deepEqual(decodeJson(rewritten).ads, []);

    const ordinary = new globalRef.Uint8Array([1, 2, 3]);
    assert.deepEqual([...ordinary], [1, 2, 3]);

    controller.stop();
    assert.equal(globalRef.Uint8Array, original);
    assert.equal(appended[0].removed, true);
  });

  it("does not overwrite a later page-owned constructor during cleanup", () => {
    const globalRef = { JSON, Proxy, Reflect, TextDecoder, TextEncoder, Uint8Array };
    const controller = createChzzkAdResponseController({ documentRef: null, globalRef });
    controller.start();
    function PageOwnedUint8Array() {}
    globalRef.Uint8Array = PageOwnedUint8Array;
    controller.stop();
    assert.equal(globalRef.Uint8Array, PageOwnedUint8Array);
  });
});
