import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

const BACKGROUND_URL = new URL("../../background.js", import.meta.url);
const LIVE_URL = "https://chzzk.naver.com/live/example-channel";
const MINI_URL = "https://chzzk.naver.com/lives?keyword=another-channel";

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function playlistResponse(url, body = "#EXTM3U\n#EXT-X-VERSION:3\n") {
  return {
    headers: { get: () => null },
    ok: true,
    status: 200,
    text: async () => body,
    url,
  };
}

function failedResponse(url) {
  return {
    headers: { get: () => null },
    ok: false,
    status: 404,
    text: async () => "not found",
    url,
  };
}

async function loadBackground() {
  const fetches = [];
  const listeners = {};
  const responseFilters = new Map();
  const storage = {};
  const context = {
    AbortController,
    Boolean,
    Date,
    Map,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    TextDecoder,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    fetch: async (url) => {
      const stringUrl = String(url);
      fetches.push(stringUrl);
      if (stringUrl.includes("/master.m3u8")) {
        return playlistResponse(
          stringUrl,
          [
            "#EXTM3U",
            "#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160,FRAME-RATE=60.0",
            "2160p/segment/chunklist_2160p.m3u8?Policy=master-variant",
            "",
          ].join("\n"),
        );
      }
      if (stringUrl.includes("2160p") || stringUrl.includes("1080p")) {
        return playlistResponse(stringUrl);
      }
      return failedResponse(stringUrl);
    },
    globalThis: null,
    setTimeout,
  };
  context.globalThis = context;
  context.browser = {
    runtime: {
      onInstalled: {
        addListener(fn) {
          listeners.onInstalled = fn;
        },
      },
      onMessage: {
        addListener(fn) {
          listeners.onMessage = fn;
        },
      },
      onStartup: {
        addListener(fn) {
          listeners.onStartup = fn;
        },
      },
    },
    storage: {
      local: {
        async get(key) {
          return typeof key === "string" ? { [key]: storage[key] } : { ...storage };
        },
        async set(value) {
          Object.assign(storage, value);
        },
      },
    },
    tabs: {
      async get(tabId) {
        return { id: tabId, url: LIVE_URL };
      },
      async query() {
        return [];
      },
      onRemoved: {
        addListener(fn) {
          listeners.onRemoved = fn;
        },
      },
      onUpdated: {
        addListener(fn) {
          listeners.onUpdated = fn;
        },
      },
    },
    webRequest: {
      filterResponseData(requestId) {
        const filter = {
          close() {},
          ondata: null,
          onerror: null,
          onstop: null,
          write() {},
        };
        responseFilters.set(String(requestId), filter);
        return filter;
      },
      onBeforeRequest: {
        addListener(fn) {
          listeners.onBeforeRequest = fn;
        },
      },
      onCompleted: {
        addListener(fn) {
          listeners.onCompleted = fn;
        },
      },
      onErrorOccurred: {
        addListener(fn) {
          listeners.onErrorOccurred = fn;
        },
      },
    },
  };

  vm.createContext(context);
  vm.runInContext(readFileSync(BACKGROUND_URL, "utf8"), context, {
    filename: "background.js",
  });
  return { fetches, listeners, responseFilters };
}

function mediaRequest(tabId, requestId, policy) {
  return {
    documentUrl: LIVE_URL,
    initiator: "https://chzzk.naver.com",
    method: "GET",
    originUrl: undefined,
    requestId,
    tabId,
    type: "xmlhttprequest",
    url: `https://nvelop-livecloud.pstatic.net/chzzk/fixture/480p/segment/chunklist_480p.m3u8?Policy=${policy}`,
  };
}

function masterRequest(tabId) {
  return {
    documentUrl: LIVE_URL,
    initiator: "https://chzzk.naver.com",
    method: "GET",
    originUrl: undefined,
    requestId: "master-refresh",
    tabId,
    type: "xmlhttprequest",
    url: "https://nvelop-livecloud.pstatic.net/chzzk/fixture/master.m3u8?Policy=master",
  };
}

function deliverValidPlaylist(responseFilters, requestId) {
  const filter = responseFilters.get(String(requestId));
  assert.ok(filter, `response filter ${requestId} must exist`);
  filter.ondata({
    data: new TextEncoder().encode("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n").buffer,
  });
  filter.onstop();
}

async function settleAsyncRuntimeWork() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("mini-player transition regression coverage", () => {
  it("keeps failed-quality backoff across repeated same-document mini-player routes", async () => {
    const { fetches, listeners } = await loadBackground();
    const tabId = 701;
    listeners.onUpdated(tabId, { url: LIVE_URL });

    const firstRequest = mediaRequest(tabId, "failed-2160", "first");
    const first = plain(await listeners.onBeforeRequest(firstRequest));
    assert.match(first.redirectUrl, /chunklist_2160p\.m3u8/);
    listeners.onErrorOccurred({
      error: "NS_ERROR_NET_RESET",
      requestId: firstRequest.requestId,
      url: first.redirectUrl,
    });

    listeners.onUpdated(tabId, { url: MINI_URL });
    listeners.onUpdated(tabId, { url: `${MINI_URL}&page=2` });
    await settleAsyncRuntimeWork();

    const second = plain(await listeners.onBeforeRequest(mediaRequest(tabId, "after-transition", "second")));
    assert.match(second.redirectUrl, /chunklist_1080p\.m3u8/);
    assert.equal(
      fetches.filter((url) => url.includes("2160p")).length,
      1,
      "the transition must not erase the active failure-suppression window",
    );
  });

  it("preserves verified same-quality evidence across a master refresh", async () => {
    const { fetches, listeners, responseFilters } = await loadBackground();
    const tabId = 702;
    listeners.onUpdated(tabId, { url: LIVE_URL });

    const firstRequest = mediaRequest(tabId, "verified-media", "initial");
    const first = plain(await listeners.onBeforeRequest(firstRequest));
    assert.match(first.redirectUrl, /chunklist_2160p\.m3u8/);
    assert.equal(await listeners.onBeforeRequest({ ...firstRequest, url: first.redirectUrl }), undefined);
    deliverValidPlaylist(responseFilters, firstRequest.requestId);
    listeners.onCompleted({
      requestId: firstRequest.requestId,
      statusCode: 200,
      url: first.redirectUrl,
    });

    assert.equal(listeners.onBeforeRequest(masterRequest(tabId)), undefined);
    await settleAsyncRuntimeWork();
    const fetchCountBeforeTransition = fetches.length;

    listeners.onUpdated(tabId, { url: MINI_URL });
    await settleAsyncRuntimeWork();
    const nextDecision = listeners.onBeforeRequest(
      mediaRequest(tabId, "after-master-transition", "after-master"),
    );

    assert.equal(
      typeof nextDecision?.then,
      "undefined",
      "a same-quality master refresh must not turn a verified redirect into a cold probe",
    );
    assert.match(plain(nextDecision).redirectUrl, /chunklist_2160p\.m3u8/);
    assert.equal(
      fetches.length,
      fetchCountBeforeTransition,
      "the migrated verified target must be reused without another availability scan",
    );
  });
});
