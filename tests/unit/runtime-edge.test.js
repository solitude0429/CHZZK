import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

function plain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function streamBody(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  let delivered = false;
  return {
    getReader() {
      return {
        async cancel() {},
        async read() {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: bytes };
        },
      };
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function loadBackground({
  availableQualities = new Set(),
  clockStartMs = Date.now(),
  fetchImplementation = null,
  tabsGetImplementation = null,
  tabsQueryImplementation = null,
  timerTransform = (delay) => delay,
} = {}) {
  const listeners = {};
  const storage = {};
  const fetches = [];
  const fetchOptions = [];
  const responseFilters = new Map();
  const tabQueries = [];
  let clockMs = clockStartMs;

  class HarnessDate extends Date {
    constructor(...args) {
      super(...(args.length > 0 ? args : [clockMs]));
    }
    static now() {
      return clockMs;
    }
  }

  const context = {
    AbortController,
    Date: HarnessDate,
    TextDecoder,
    TextEncoder,
    URL,
    console,
    fetch: async (url, options = {}) => {
      const stringUrl = String(url);
      fetches.push(stringUrl);
      fetchOptions.push(options);
      if (fetchImplementation) return fetchImplementation(stringUrl, options);
      const ok = [...availableQualities].some((quality) => stringUrl.includes(quality));
      const bodyText = ok ? "#EXTM3U\n#EXT-X-VERSION:3\n" : "not found";
      return {
        body: streamBody(bodyText),
        headers: { get: () => null },
        ok,
        status: ok ? 200 : 404,
        text: async () => bodyText,
        url: stringUrl,
      };
    },
    globalThis: null,
    setTimeout(callback, delay, ...args) {
      return setTimeout(callback, timerTransform(delay), ...args);
    },
    clearTimeout,
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
        async remove(key) {
          delete storage[key];
        },
      },
    },
    tabs: {
      async get(tabId) {
        return tabsGetImplementation ? tabsGetImplementation(tabId) : { id: tabId };
      },
      async query(query) {
        tabQueries.push(query);
        return tabsQueryImplementation ? tabsQueryImplementation(query) : [];
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
        const writes = [];
        const filter = {
          ondata: null,
          onerror: null,
          onstop: null,
          write(data) {
            writes.push(new Uint8Array(data));
          },
          close() {},
          writes,
        };
        responseFilters.set(String(requestId), filter);
        return filter;
      },
      onBeforeRequest: {
        addListener(fn, filter, extraInfoSpec) {
          listeners.onBeforeRequest = fn;
          listeners.filter = filter;
          listeners.extraInfoSpec = extraInfoSpec;
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
  vm.runInContext(readFileSync(new URL("../../background.js", import.meta.url), "utf8"), context, {
    filename: "background.js",
  });
  return {
    advanceClock(ms) {
      clockMs += ms;
    },
    fetches,
    fetchOptions,
    listeners,
    responseFilters,
    storage,
    tabQueries,
  };
}

function request(tabId = 1, requestId = undefined) {
  return {
    documentUrl: "https://chzzk.naver.com/live/channel-a",
    initiator: "https://chzzk.naver.com",
    method: "GET",
    originUrl: undefined,
    requestId,
    tabId,
    type: "xmlhttprequest",
    url: "https://nvelop-livecloud.pstatic.net/chzzk/session/360p/segment/chunklist_480p.m3u8?Policy=low",
  };
}

function response(url, body, { ok = true, status = 200 } = {}) {
  return {
    body: streamBody(body),
    headers: { get: () => null },
    ok,
    status,
    text: async () => body,
    url,
  };
}

async function wait(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function deliver(responseFilters, requestId, body) {
  const filter = responseFilters.get(String(requestId));
  assert.ok(filter);
  if (body) filter.ondata({ data: new TextEncoder().encode(body).buffer });
  filter.onstop();
}

describe("runtime edge hardening", () => {
  it("selects a supported quality after two higher probes exhaust their bounded slices", async () => {
    const { listeners } = await loadBackground({
      fetchImplementation: (url, options) => {
        if (url.includes("2160p") || url.includes("1440p")) {
          return new Promise((resolve) => {
            options.signal.addEventListener("abort", () =>
              resolve(response(url, "", { ok: false, status: 499 })),
            );
          });
        }
        return Promise.resolve(
          url.includes("1080p")
            ? response(url, "#EXTM3U\n#EXT-X-VERSION:3\n")
            : response(url, "", { ok: false, status: 404 }),
        );
      },
      timerTransform(delay) {
        return delay === 3000 ? 100 : delay > 50 ? 5 : delay;
      },
    });

    const result = plain(await listeners.onBeforeRequest(request()));
    assert.match(result.redirectUrl, /1080p/);
  });

  it("filters an invalid top master variant before ranking and retains the exact opaque URI", async () => {
    const masterUrl =
      "https://nvelop-livecloud.pstatic.net/chzzk/session/master.m3u8?Policy=master";
    const opaqueUrl = "https://edge.pstatic.net/chzzk/session/video/main.m3u8?Policy=high";
    const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160\nhttps://untrusted.invalid/chunklist_2160p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n${opaqueUrl}\n`;
    const { listeners } = await loadBackground({
      fetchImplementation: async (url) =>
        url === masterUrl
          ? response(url, master)
          : response(url, "", { ok: false, status: 404 }),
    });

    await listeners.onBeforeRequest({ ...request(2), url: masterUrl });
    await wait();
    const redirected = plain(await listeners.onBeforeRequest(request(2)));
    assert.equal(redirected.redirectUrl, opaqueUrl);
  });

  it("redirects to the exact same-family master URI instead of synthesizing a guessed path", async () => {
    const masterUrl =
      "https://nvelop-livecloud.pstatic.net/chzzk/session/master.m3u8?Policy=master";
    const exactVariant =
      "https://nvelop-livecloud.pstatic.net/chzzk/session/chunklist_1080p_high.m3u8?Policy=variant";
    const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n${exactVariant}\n`;
    const { listeners } = await loadBackground({
      fetchImplementation: async (url) =>
        url === masterUrl ? response(url, master) : response(url, "", { ok: false, status: 404 }),
    });

    await listeners.onBeforeRequest({ ...request(20), url: masterUrl });
    await wait();
    const redirected = plain(await listeners.onBeforeRequest(request(20)));
    assert.equal(redirected.redirectUrl, exactVariant);
    assert.doesNotMatch(redirected.redirectUrl, /\/1080p\/segment\//);
  });

  it("keeps an exact opaque master target after its structurally valid media response", async () => {
    const masterUrl =
      "https://nvelop-livecloud.pstatic.net/chzzk/session/master.m3u8?Policy=master";
    const opaqueUrl = "https://edge.pstatic.net/chzzk/session/video/main.m3u8?Policy=high";
    const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n${opaqueUrl}\n`;
    const { fetches, listeners, responseFilters } = await loadBackground({
      fetchImplementation: async (url) =>
        url === masterUrl ? response(url, master) : response(url, "", { ok: false, status: 404 }),
    });

    await listeners.onBeforeRequest({ ...request(21), url: masterUrl });
    await wait();
    const first = plain(await listeners.onBeforeRequest(request(21, "opaque-valid")));
    assert.equal(first.redirectUrl, opaqueUrl);
    await listeners.onBeforeRequest({ ...request(21, "opaque-valid"), url: opaqueUrl });
    deliver(
      responseFilters,
      "opaque-valid",
      "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n",
    );
    listeners.onCompleted({ requestId: "opaque-valid", statusCode: 200, url: opaqueUrl });
    const fetchCount = fetches.length;

    const second = plain(await listeners.onBeforeRequest(request(21, "opaque-valid-2")));
    assert.equal(second.redirectUrl, opaqueUrl);
    assert.equal(
      fetches.length,
      fetchCount,
      "valid opaque media evidence must retain the cached master target",
    );
  });

  it("redirects to a better same-resolution master rendition", async () => {
    const masterUrl =
      "https://nvelop-livecloud.pstatic.net/chzzk/session/master.m3u8?Policy=master";
    const better1080 =
      "https://nvelop-livecloud.pstatic.net/chzzk/session/chunklist_1080p_60fps.m3u8?Policy=variant";
    const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60.0\n${better1080}\n`;
    const { listeners } = await loadBackground({
      fetchImplementation: async (url) =>
        url === masterUrl ? response(url, master) : response(url, "", { ok: false, status: 404 }),
    });

    await listeners.onBeforeRequest({ ...request(23), url: masterUrl });
    await wait();
    const sameResolutionRequest = {
      ...request(23),
      url: "https://nvelop-livecloud.pstatic.net/chzzk/session/chunklist_1080p_30fps.m3u8?Policy=low",
    };
    const redirected = plain(await listeners.onBeforeRequest(sameResolutionRequest));
    assert.equal(redirected.redirectUrl, better1080);
  });

  it("shares one bounded probe sequence across concurrent requests", async () => {
    const pending = new Map();
    const { fetches, listeners } = await loadBackground({
      fetchImplementation: async (url, options) => {
        if (!pending.has(url)) pending.set(url, deferred());
        options.signal.addEventListener("abort", () => {
          pending.get(url)?.resolve(response(url, "", { ok: false, status: 499 }));
        });
        return pending.get(url).promise;
      },
    });
    const first = listeners.onBeforeRequest(request(24, "shared-1"));
    const second = listeners.onBeforeRequest(request(24, "shared-2"));
    await wait(5);
    assert.equal(
      fetches.length,
      1,
      "concurrent requests must share one resolver and one active probe",
    );
    listeners.onRemoved(24);
    await Promise.all([first, second]);
  });

  it("fails closed when a probe response cannot expose a bounded readable stream", async () => {
    const { listeners } = await loadBackground({
      fetchImplementation: async (url) => ({
        headers: { get: () => null },
        ok: url.includes("2160p"),
        status: url.includes("2160p") ? 200 : 404,
        text: async () => "#EXTM3U\n#EXT-X-VERSION:3\n",
        url,
      }),
    });
    assert.equal(await listeners.onBeforeRequest(request(22)), undefined);
  });

  it("does not accept an EXTM3U-prefixed HTML probe body", async () => {
    const { listeners } = await loadBackground({
      fetchImplementation: async (url) =>
        url.includes("2160p")
          ? response(url, "#EXTM3U\n<html>temporary error</html>\n")
          : response(url, "", { ok: false, status: 404 }),
    });
    assert.equal(await listeners.onBeforeRequest(request(3)), undefined);
  });

  it("backs off only the failed exact master rendition and selects a same-quality alternative", async () => {
    const masterUrl =
      "https://nvelop-livecloud.pstatic.net/chzzk/session/master.m3u8?Policy=master";
    const firstUrl = "https://edge.pstatic.net/chzzk/session/video/first.m3u8?Policy=one";
    const secondUrl = "https://edge.pstatic.net/chzzk/session/video/second.m3u8?Policy=two";
    const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080\n${firstUrl}\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n${secondUrl}\n`;
    const { listeners, responseFilters } = await loadBackground({
      fetchImplementation: async (url) =>
        url === masterUrl
          ? response(url, master)
          : response(url, "", { ok: false, status: 404 }),
    });
    await listeners.onBeforeRequest({ ...request(4), url: masterUrl });
    await wait();
    const first = plain(await listeners.onBeforeRequest(request(4, "failed-first")));
    assert.equal(first.redirectUrl, firstUrl);
    await listeners.onBeforeRequest({ ...request(4, "failed-first"), url: firstUrl });
    deliver(responseFilters, "failed-first", "#EXTM3U\n<html>broken</html>\n");
    listeners.onCompleted({ requestId: "failed-first", statusCode: 200, url: firstUrl });

    await listeners.onBeforeRequest({ ...request(4), url: masterUrl });
    await wait();
    const second = plain(await listeners.onBeforeRequest(request(4, "second")));
    assert.equal(second.redirectUrl, secondUrl);
  });

  it("queries exact and nested /live tabs in one startup query", async () => {
    const liveTab = { id: 5, url: "https://chzzk.naver.com/live" };
    const { listeners, tabQueries } = await loadBackground({
      tabsGetImplementation: async () => liveTab,
      tabsQueryImplementation: async (query) =>
        query.url.includes("https://*.chzzk.naver.com/live") ? [liveTab] : [],
    });
    listeners.onStartup();
    await wait();
    assert.deepEqual(plain(tabQueries), [
      {
        url: ["https://*.chzzk.naver.com/live", "https://*.chzzk.naver.com/live/*"],
      },
    ]);
  });

  it("clears diagnostics through the serialized background message path", async () => {
    const { listeners, storage } = await loadBackground({ availableQualities: new Set(["1080p"]) });
    await listeners.onBeforeRequest(request(6));
    await wait();
    assert.ok(storage.chzzkDiagnostics);
    const result = plain(await listeners.onMessage({ type: "chzzk.clear-diagnostics" }, {}));
    assert.deepEqual(result, { ok: true });
    assert.equal(storage.chzzkDiagnostics, undefined);
  });
});
