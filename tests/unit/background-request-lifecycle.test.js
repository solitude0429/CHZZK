import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

const BACKGROUND_URL = new URL("../../background.js", import.meta.url);

function playlistResponse(url, body = "#EXTM3U\n#EXT-X-VERSION:3\n") {
  return {
    headers: { get: () => null },
    ok: true,
    status: 200,
    text: async () => body,
    url,
  };
}

async function loadBackground() {
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
      const ok = stringUrl.includes("2160p") || stringUrl.includes("1080p");
      return ok
        ? playlistResponse(stringUrl)
        : {
            headers: { get: () => null },
            ok: false,
            status: 404,
            text: async () => "not found",
            url: stringUrl,
          };
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
        return { id: tabId, url: "https://chzzk.naver.com/live/example-channel" };
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

  const source = readFileSync(BACKGROUND_URL, "utf8");
  const closureEnd = source.lastIndexOf("})();");
  assert.notEqual(closureEnd, -1, "generated background bundle must end with an IIFE");
  const instrumented = `${source.slice(0, closureEnd)}
  globalThis.__chzzkRedirectRecords = () =>
    [...redirectedRequestsById.values()].map(({ bodyEvidence, requestId, sequence, settled }) => ({
      bodyEvidence,
      requestId,
      sequence,
      settled,
    }));
${source.slice(closureEnd)}`;

  vm.createContext(context);
  vm.runInContext(instrumented, context, { filename: "background.js" });
  return {
    listeners,
    records: () => context.__chzzkRedirectRecords(),
    responseFilters,
  };
}

function request(requestId, policy) {
  return {
    documentUrl: "https://chzzk.naver.com/live/example-channel",
    initiator: "https://chzzk.naver.com",
    method: "GET",
    originUrl: undefined,
    requestId,
    tabId: 1,
    type: "xmlhttprequest",
    url: `https://edge.pstatic.net/chzzk/family/chunklist_480p.m3u8?Policy=${policy}`,
  };
}

async function startOverlappingRedirects(runtime) {
  const older = request("older", "one");
  const newer = request("newer", "two");
  const olderRedirect = await runtime.listeners.onBeforeRequest(older);
  const newerRedirect = await runtime.listeners.onBeforeRequest(newer);
  assert.match(olderRedirect.redirectUrl, /chunklist_2160p/);
  assert.match(newerRedirect.redirectUrl, /chunklist_2160p/);
  await runtime.listeners.onBeforeRequest({ ...older, url: olderRedirect.redirectUrl });
  await runtime.listeners.onBeforeRequest({ ...newer, url: newerRedirect.redirectUrl });
  return { olderRedirect };
}

function assertOnlyNewerPending(records) {
  assert.deepEqual(JSON.parse(JSON.stringify(records)), [
    {
      bodyEvidence: "pending",
      requestId: "newer",
      sequence: 2,
      settled: false,
    },
  ]);
}

describe("redirect response-verification lifecycle", () => {
  it("forgets an older invalid response while a newer verification remains pending", async () => {
    const runtime = await loadBackground();
    const { olderRedirect } = await startOverlappingRedirects(runtime);
    const filter = runtime.responseFilters.get("older");
    filter.ondata({ data: new TextEncoder().encode("<!doctype html>").buffer });
    filter.onstop();
    runtime.listeners.onCompleted({
      requestId: "older",
      statusCode: 200,
      url: olderRedirect.redirectUrl,
    });

    assertOnlyNewerPending(runtime.records());
  });

  it("forgets an older network failure while a newer verification remains pending", async () => {
    const runtime = await loadBackground();
    await startOverlappingRedirects(runtime);
    runtime.listeners.onErrorOccurred({
      error: "NS_ERROR_NET_RESET",
      requestId: "older",
    });

    assertOnlyNewerPending(runtime.records());
  });
});
