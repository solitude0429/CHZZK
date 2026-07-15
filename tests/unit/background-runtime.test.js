import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadBackground({
  availableQualities = new Set(),
  existingLiveTabs = [],
  fetchImplementation = null,
  maxInternalTimerMs = null,
  responsesByUrl = new Map(),
  storageSetImplementation = null,
  tabUrlsById = new Map(),
} = {}) {
  const listeners = {};
  const storage = {};
  const fetches = [];
  const fetchOptions = [];
  const tabQueries = [];
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
    URL,
    clearTimeout,
    console,
    fetch: async (url, options = {}) => {
      const stringUrl = String(url);
      fetches.push(stringUrl);
      fetchOptions.push(options);
      if (fetchImplementation) return fetchImplementation(stringUrl, options);
      if (responsesByUrl.has(stringUrl)) {
        const response = responsesByUrl.get(stringUrl);
        if (response && typeof response === "object") {
          return {
            headers: {
              get(name) {
                const headers = response.headers ?? {};
                if (typeof headers.get === "function") return headers.get(name);
                return headers[String(name).toLowerCase()] ?? headers[name] ?? null;
              },
            },
            ok: response.ok ?? true,
            status: response.status ?? (response.ok === false ? 404 : 200),
            text: async () => response.body ?? response.text ?? "",
            url: response.url ?? stringUrl,
          };
        }
        return {
          headers: { get: () => null },
          ok: true,
          status: 200,
          text: async () => response,
          url: stringUrl,
        };
      }
      const ok = [...availableQualities].some((quality) => stringUrl.includes(quality));
      return {
        headers: { get: () => null },
        ok,
        status: ok ? 200 : 404,
        text: async () => (ok ? "#EXTM3U\n#EXT-X-VERSION:3\n" : "not found"),
        url: stringUrl,
      };
    },
    globalThis: null,
    setTimeout: (callback, delay, ...args) =>
      setTimeout(callback, maxInternalTimerMs == null ? delay : Math.min(delay, maxInternalTimerMs), ...args),
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
          if (storageSetImplementation) await storageSetImplementation(value, storage);
          Object.assign(storage, value);
        },
      },
    },
    tabs: {
      async get(tabId) {
        const existing = existingLiveTabs.find((tab) => tab.id === tabId);
        return existing ?? { id: tabId, url: tabUrlsById.get(tabId) };
      },
      async query(queryInfo) {
        tabQueries.push(queryInfo);
        return existingLiveTabs;
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
      onBeforeRequest: {
        addListener(fn, filter, extraInfoSpec) {
          listeners.onBeforeRequest = fn;
          listeners.filter = filter;
          listeners.extraInfoSpec = extraInfoSpec;
        },
      },
    },
  };

  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../../background.js", import.meta.url), "utf8"), context, {
    filename: "background.js",
  });

  return { fetches, fetchOptions, listeners, storage, tabQueries };
}

async function waitForDiagnosticsQueue(delayMs = 50) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
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

function playlistResponse(url, body = "#EXTM3U\n#EXT-X-VERSION:3\n") {
  return {
    headers: { get: () => null },
    ok: true,
    status: 200,
    text: async () => body,
    url,
  };
}

function firstLowQualityRequest(tabId) {
  return {
    documentUrl: undefined,
    initiator: "https://chzzk.naver.com",
    method: "GET",
    originUrl: undefined,
    tabId,
    type: "xmlhttprequest",
    url: "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/360p/segment/chunklist_480p.m3u8?Policy=redacted",
  };
}

describe("background runtime quality resolution", () => {
  it("does not hard-code a startup quality and redirects the first request to the highest supported candidate", async () => {
    const { fetches, listeners, storage } = await loadBackground({
      availableQualities: new Set(["1440p", "1080p"]),
      tabUrlsById: new Map([[42, "https://chzzk.naver.com/live/example-channel"]]),
    });

    listeners.onMessage({ type: "chzzk.live-page-ready" }, { tab: { id: 42 } });
    await waitForDiagnosticsQueue();

    assert.deepEqual(
      plain(storage.chzzkDiagnostics.runtimeRedirects.targetsByTab),
      {},
      "prewarm must trust the tab but must not seed a fixed 1080p target",
    );

    const redirect = plain(await listeners.onBeforeRequest(firstLowQualityRequest(42)));

    assert.equal(
      redirect.redirectUrl,
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/1440p/segment/chunklist_1440p.m3u8?Policy=redacted",
    );
    assert.equal(
      fetches.some((url) => url.includes("2160p")),
      true,
      "must probe above 1440 before selecting it",
    );
    assert.equal(
      fetches.some((url) => url.includes("1440p")),
      true,
      "must prove the selected highest quality exists",
    );

    await waitForDiagnosticsQueue();
    const diagnostics = plain(storage.chzzkDiagnostics);
    assert.deepEqual(diagnostics.runtimeRedirects.targetsByTab, { 42: "1440p" });
    assert.equal(diagnostics.decisions.at(-1).targetQuality, "1440p");
    assert.equal(diagnostics.decisions.at(-1).redirectedCurrentRequest, true);
  });

  it("shares one in-flight probe set and fails open within the blocking latency budget", async () => {
    const pendingFetch = deferred();
    const { fetches, listeners } = await loadBackground({
      fetchImplementation: async () => pendingFetch.promise,
    });
    const request = firstLowQualityRequest(420);
    const requests = Promise.all([listeners.onBeforeRequest(request), listeners.onBeforeRequest(request)]);
    requests.catch(() => {});

    const outcome = await Promise.race([
      requests.then((values) => ({ kind: "returned", values })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 500)),
    ]);

    assert.equal(
      outcome.kind,
      "returned",
      "blocking webRequest must fail open before the latency budget expires",
    );
    assert.equal(
      outcome.values.every((value) => value === undefined),
      true,
    );
    assert.equal(fetches.length, 1, "concurrent requests for one tab/context must share one probe set");
  });

  it("aborts the whole background resolution after a bounded total budget", async () => {
    const { fetches, listeners } = await loadBackground({
      fetchImplementation: async (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      maxInternalTimerMs: 20,
    });

    await listeners.onBeforeRequest(firstLowQualityRequest(424));
    await waitForDiagnosticsQueue(100);

    assert.equal(fetches.length, 1, "a total resolution timeout must stop the serial candidate loop");
  });

  it("rejects a candidate when the final playlist quality does not match the requested quality", async () => {
    const mismatched1440 =
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/1440p/segment/chunklist_1440p.m3u8?Policy=redacted";
    const { listeners } = await loadBackground({
      availableQualities: new Set(["1080p"]),
      responsesByUrl: new Map([
        [
          mismatched1440,
          {
            body: "#EXTM3U\n#EXT-X-VERSION:3\n",
            url: "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/1080p/segment/chunklist_1080p.m3u8?Policy=redacted",
          },
        ],
      ]),
    });

    const redirect = plain(await listeners.onBeforeRequest(firstLowQualityRequest(421)));

    assert.equal(
      redirect.redirectUrl,
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/1080p/segment/chunklist_1080p.m3u8?Policy=redacted",
    );
  });

  it("rejects a quality-marked candidate URL whose body is a lower-quality master playlist", async () => {
    const requested2160 =
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/2160p/segment/chunklist_2160p.m3u8?Policy=redacted";
    const lowerQualityMaster = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360
chunklist_360p.m3u8?Policy=redacted
`;
    const { listeners } = await loadBackground({
      responsesByUrl: new Map([[requested2160, lowerQualityMaster]]),
    });

    const redirect = await listeners.onBeforeRequest(firstLowQualityRequest(426));
    assert.equal(redirect, undefined, "candidate master evidence must contain the requested quality");
  });

  it("rejects master evidence whose pathname contains conflicting quality markers", async () => {
    const requested2160 =
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/2160p/segment/chunklist_2160p.m3u8?Policy=redacted";
    const conflictingMaster = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160
https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/2160p/segment/chunklist_360p.m3u8?Policy=redacted
`;
    const { listeners } = await loadBackground({
      responsesByUrl: new Map([[requested2160, conflictingMaster]]),
    });

    const redirect = await listeners.onBeforeRequest(firstLowQualityRequest(427));
    assert.equal(redirect, undefined, "every meaningful pathname quality marker must agree");
  });

  it("does not restore a stale target after navigating to another live channel", async () => {
    const pendingFetch = deferred();
    const { fetches, listeners, storage } = await loadBackground({
      fetchImplementation: async () => pendingFetch.promise,
    });

    listeners.onUpdated(422, { url: "https://chzzk.naver.com/live/channel-a" });
    const request = listeners.onBeforeRequest(firstLowQualityRequest(422));
    await waitForDiagnosticsQueue(10);
    listeners.onUpdated(422, { url: "https://chzzk.naver.com/live/channel-b" });
    await waitForDiagnosticsQueue(10);
    pendingFetch.resolve(playlistResponse(fetches[0]));
    await request;
    await waitForDiagnosticsQueue();

    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.targetsByTab), {});
  });

  it("does not restore a stale target when the first request records context before tabs.onUpdated", async () => {
    const pendingFetch = deferred();
    const { fetches, listeners, storage } = await loadBackground({
      fetchImplementation: async () => pendingFetch.promise,
    });
    const request = listeners.onBeforeRequest({
      ...firstLowQualityRequest(425),
      documentUrl: "https://chzzk.naver.com/live/channel-a",
    });
    await waitForDiagnosticsQueue(10);
    listeners.onUpdated(425, { url: "https://chzzk.naver.com/live/channel-b" });
    await waitForDiagnosticsQueue(10);
    pendingFetch.resolve(playlistResponse(fetches[0]));
    await request;
    await waitForDiagnosticsQueue();

    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.targetsByTab), {});
  });

  it("invalidates cached state when request metadata proves a different live context", async () => {
    const pendingFetch = deferred();
    let initialResolution = true;
    let pendingUrl = null;
    const { listeners, storage } = await loadBackground({
      fetchImplementation: async (url) => {
        if (!initialResolution) {
          pendingUrl = url;
          return pendingFetch.promise;
        }
        if (url.includes("2160p")) return new Response("not found", { status: 404 });
        return playlistResponse(url);
      },
      maxInternalTimerMs: 50,
    });

    const initial = plain(
      await listeners.onBeforeRequest({
        ...firstLowQualityRequest(426),
        documentUrl: "https://chzzk.naver.com/live/channel-a",
      }),
    );
    assert.match(initial.redirectUrl, /1440p/);
    initialResolution = false;

    const mismatch = await listeners.onBeforeRequest({
      ...firstLowQualityRequest(426),
      documentUrl: "https://chzzk.naver.com/live/channel-b",
    });
    assert.equal(mismatch, undefined);
    await waitForDiagnosticsQueue();
    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.targetsByTab), {});

    const metadataPoor = await listeners.onBeforeRequest({
      ...firstLowQualityRequest(426),
      documentUrl: undefined,
      initiator: undefined,
      originUrl: undefined,
    });
    assert.equal(metadataPoor, undefined);
    pendingFetch.resolve(playlistResponse(pendingUrl));
    await waitForDiagnosticsQueue(60);
  });

  it("invalidates contextless first-request work when a concrete live context is adopted", async () => {
    const pendingFetch = deferred();
    const { fetches, listeners, storage } = await loadBackground({
      fetchImplementation: async () => pendingFetch.promise,
    });

    const initialRequest = listeners.onBeforeRequest({
      ...firstLowQualityRequest(427),
      documentUrl: undefined,
      initiator: undefined,
      originUrl: undefined,
    });
    await initialRequest;
    listeners.onUpdated(427, { url: "https://chzzk.naver.com/live/channel-b" });
    await waitForDiagnosticsQueue(10);
    pendingFetch.resolve(playlistResponse(fetches[0]));
    await waitForDiagnosticsQueue();

    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.targetsByTab), {});
  });

  it("does not restore state for a closed tab when a pending probe completes", async () => {
    const pendingFetch = deferred();
    const { fetches, listeners, storage } = await loadBackground({
      fetchImplementation: async () => pendingFetch.promise,
    });

    listeners.onUpdated(423, { url: "https://chzzk.naver.com/live/channel-a" });
    const request = listeners.onBeforeRequest(firstLowQualityRequest(423));
    await waitForDiagnosticsQueue(10);
    listeners.onRemoved(423);
    await waitForDiagnosticsQueue(10);
    pendingFetch.resolve(playlistResponse(fetches[0]));
    await request;
    await waitForDiagnosticsQueue();

    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.targetsByTab), {});
    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.activeTabIds), []);
  });

  it("redirects the first request without content-script prewarm when Firefox only provides the CHZZK initiator", async () => {
    const { listeners } = await loadBackground({ availableQualities: new Set(["1080p"]) });

    const redirect = plain(await listeners.onBeforeRequest(firstLowQualityRequest(91)));
    assert.equal(
      redirect.redirectUrl,
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/1080p/segment/chunklist_1080p.m3u8?Policy=redacted",
    );
  });

  it("redirects CHZZK/livecloud playlist URLs even when Firefox omits both page URL and initiator", async () => {
    const { listeners } = await loadBackground({ availableQualities: new Set(["1080p"]) });

    const redirect = plain(
      await listeners.onBeforeRequest({
        ...firstLowQualityRequest(92),
        initiator: undefined,
        url: "https://livecloud.pstatic.net.live.gscdn.net/live/chunklist_480p.m3u8?Policy=redacted",
      }),
    );
    assert.equal(
      redirect.redirectUrl,
      "https://livecloud.pstatic.net.live.gscdn.net/live/chunklist_1080p.m3u8?Policy=redacted",
    );
  });

  it("does not let a delayed content-script message restore trust after non-live navigation", async () => {
    const tabUrlsById = new Map([[512, "https://www.example.com/"]]);
    const { listeners, storage } = await loadBackground({
      availableQualities: new Set(["1080p"]),
      tabUrlsById,
    });

    listeners.onUpdated(512, { url: "https://chzzk.naver.com/live/channel-a" });
    listeners.onUpdated(512, { url: "https://www.example.com/" });
    await waitForDiagnosticsQueue();
    listeners.onMessage({ type: "chzzk.live-page-ready" }, { tab: { id: 512 } });
    await waitForDiagnosticsQueue();

    const redirect = await listeners.onBeforeRequest({
      ...firstLowQualityRequest(512),
      documentUrl: undefined,
      initiator: undefined,
      originUrl: undefined,
      url: "https://example.pstatic.net/video/chunklist_480p.m3u8?Policy=redacted",
    });
    assert.equal(redirect, undefined);
    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.activeTabIds), []);
  });

  it("prewarms a live tab from tabs.onUpdated before the first HLS request when content-script timing loses the race", async () => {
    const { listeners, storage } = await loadBackground({ availableQualities: new Set(["1080p"]) });

    listeners.onUpdated(77, { url: "https://chzzk.naver.com/live/example-channel" });
    await waitForDiagnosticsQueue();

    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.activeTabIds), [77]);

    const redirect = plain(await listeners.onBeforeRequest(firstLowQualityRequest(77)));
    assert.equal(
      redirect.redirectUrl,
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/1080p/segment/chunklist_1080p.m3u8?Policy=redacted",
    );
  });

  it("prewarms already-open live tabs after extension install/startup so update does not require a manual refresh", async () => {
    const { listeners, storage, tabQueries } = await loadBackground({
      availableQualities: new Set(["1080p"]),
      existingLiveTabs: [{ id: 88, url: "https://chzzk.naver.com/live/example-channel" }],
    });

    listeners.onInstalled();
    await waitForDiagnosticsQueue();

    assert.deepEqual(plain(tabQueries), [{ url: ["https://*.chzzk.naver.com/live/*"] }]);
    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.activeTabIds), [88]);

    const redirect = plain(await listeners.onBeforeRequest(firstLowQualityRequest(88)));
    assert.equal(
      redirect.redirectUrl,
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/1080p/segment/chunklist_1080p.m3u8?Policy=redacted",
    );
  });

  it("prewarms already-open live tabs even when startup diagnostics storage fails", async () => {
    const { listeners, tabQueries } = await loadBackground({
      availableQualities: new Set(["1080p"]),
      existingLiveTabs: [{ id: 89, url: "https://chzzk.naver.com/live/example-channel" }],
      storageSetImplementation: async () => {
        throw new Error("synthetic startup storage failure");
      },
    });

    listeners.onStartup();
    await waitForDiagnosticsQueue();

    assert.deepEqual(plain(tabQueries), [{ url: ["https://*.chzzk.naver.com/live/*"] }]);
    const redirect = plain(
      await listeners.onBeforeRequest({
        ...firstLowQualityRequest(89),
        documentUrl: undefined,
        initiator: undefined,
        originUrl: undefined,
        url: "https://example.pstatic.net/video/chunklist_480p.m3u8?Policy=redacted",
      }),
    );
    assert.match(redirect.redirectUrl, /chunklist_1080p\.m3u8/);
  });

  it("uses master-playlist scoring to choose the target quality while preserving live playlist URL shape", async () => {
    const masterUrl =
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/master.m3u8?Policy=redacted";
    const masterPlaylist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8384000,RESOLUTION=1920x1080,FRAME-RATE=60.00
chunklist_1080p.m3u8?Policy=redacted
#EXT-X-STREAM-INF:BANDWIDTH=9500000,RESOLUTION=1280x720,FRAME-RATE=60.00
chunklist_720p_highbitrate.m3u8?Policy=redacted
`;
    const { listeners, storage } = await loadBackground({
      responsesByUrl: new Map([[masterUrl, masterPlaylist]]),
      tabUrlsById: new Map([[43, "https://chzzk.naver.com/live/example-channel"]]),
    });

    listeners.onMessage({ type: "chzzk.live-page-ready" }, { tab: { id: 43 } });
    await waitForDiagnosticsQueue();

    const masterRedirect = await listeners.onBeforeRequest({
      documentUrl: undefined,
      initiator: "https://chzzk.naver.com",
      method: "GET",
      originUrl: undefined,
      tabId: 43,
      type: "xmlhttprequest",
      url: masterUrl,
    });
    assert.equal(
      masterRedirect,
      undefined,
      "master playlist requests are fetched for scoring but not redirected",
    );

    const liveUpdateAtTargetQuality = await listeners.onBeforeRequest({
      ...firstLowQualityRequest(43),
      url: "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/1080p/segment/chunklist_1080p.m3u8?_HLS_msn=42&Policy=redacted",
    });
    assert.equal(
      liveUpdateAtTargetQuality,
      undefined,
      "do not redirect same-quality live playlist refreshes to a stale exact master URL",
    );

    const redirect = plain(await listeners.onBeforeRequest(firstLowQualityRequest(43)));
    assert.equal(
      redirect.redirectUrl,
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/1080p/segment/chunklist_1080p.m3u8?Policy=redacted",
    );

    await waitForDiagnosticsQueue();
    const diagnostics = plain(storage.chzzkDiagnostics);
    assert.deepEqual(diagnostics.runtimeRedirects.targetsByTab, { 43: "1080p" });
    assert.equal(diagnostics.decisions.at(-1).targetQuality, "1080p");
    assert.equal(diagnostics.decisions.at(-1).redirectedCurrentRequest, true);
  });

  it("lets newer master-playlist evidence supersede an older numeric probe", async () => {
    const pendingNumeric = deferred();
    const masterUrl = "https://example.pstatic.net/chzzk/live/master.m3u8?Policy=redacted";
    const masterPlaylist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8384000,RESOLUTION=1920x1080,FRAME-RATE=60.00
chunklist_1080p.m3u8?Policy=redacted
`;
    const { fetches, listeners, storage } = await loadBackground({
      fetchImplementation: async (url) =>
        url === masterUrl ? playlistResponse(url, masterPlaylist) : pendingNumeric.promise,
    });
    const contextUrl = "https://chzzk.naver.com/live/channel-a";
    const numericRequest = listeners.onBeforeRequest({
      ...firstLowQualityRequest(513),
      documentUrl: contextUrl,
    });
    await waitForDiagnosticsQueue(10);

    const masterRedirect = await listeners.onBeforeRequest({
      documentUrl: contextUrl,
      initiator: "https://chzzk.naver.com",
      method: "GET",
      originUrl: undefined,
      tabId: 513,
      type: "xmlhttprequest",
      url: masterUrl,
    });
    assert.equal(masterRedirect, undefined);
    await waitForDiagnosticsQueue(20);
    pendingNumeric.resolve(playlistResponse(fetches[0]));
    await numericRequest;
    await waitForDiagnosticsQueue();

    assert.equal(fetches.includes(masterUrl), true);
    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.targetsByTab), { 513: "1080p" });
  });

  it("clears cached target quality when the same tab navigates to another CHZZK live channel", async () => {
    const { listeners, storage } = await loadBackground({ availableQualities: new Set(["1440p", "1080p"]) });

    listeners.onUpdated(7, { url: "https://chzzk.naver.com/live/channel-a" });
    await waitForDiagnosticsQueue();
    await listeners.onBeforeRequest(firstLowQualityRequest(7));
    await waitForDiagnosticsQueue();
    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.targetsByTab), { 7: "1440p" });

    listeners.onUpdated(7, { url: "https://chzzk.naver.com/live/channel-b" });
    await waitForDiagnosticsQueue();

    assert.deepEqual(
      plain(storage.chzzkDiagnostics.runtimeRedirects.targetsByTab),
      {},
      "live-to-live navigation must drop stale per-tab target quality",
    );
  });

  it("clears cached target quality when the same tab reloads the same CHZZK live URL", async () => {
    const availableQualities = new Set(["2160p"]);
    const tabUrl = "https://chzzk.naver.com/live/channel-a";
    const { fetches, listeners, storage } = await loadBackground({
      availableQualities,
      tabUrlsById: new Map([[8, tabUrl]]),
    });

    listeners.onUpdated(8, { url: tabUrl });
    await waitForDiagnosticsQueue();
    const firstRedirect = plain(await listeners.onBeforeRequest(firstLowQualityRequest(8)));
    assert.match(firstRedirect.redirectUrl, /2160p/);
    const fetchCountBeforeReload = fetches.length;

    availableQualities.clear();
    availableQualities.add("1080p");
    listeners.onUpdated(8, { status: "loading" });
    await waitForDiagnosticsQueue();
    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.targetsByTab), {});

    listeners.onMessage({ type: "chzzk.live-page-ready" }, { tab: { id: 8 } });
    await waitForDiagnosticsQueue();
    const secondRedirect = plain(await listeners.onBeforeRequest(firstLowQualityRequest(8)));

    assert.match(secondRedirect.redirectUrl, /1080p/);
    assert.equal(fetches.length > fetchCountBeforeReload, true, "same-URL reload must start a new probe set");
  });

  it("does not trust oversized playlist probe responses when selecting a target quality", async () => {
    const oversized1440 =
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/1440p/segment/chunklist_1440p.m3u8?Policy=redacted";
    const { listeners } = await loadBackground({
      responsesByUrl: new Map([
        [
          oversized1440,
          {
            body: `#EXTM3U\n${"#".repeat(300_000)}`,
            headers: { "content-length": "300001" },
          },
        ],
      ]),
    });

    const redirect = await listeners.onBeforeRequest(firstLowQualityRequest(66));

    assert.equal(redirect, undefined, "oversized probe bodies must not seed a redirect target");
  });

  it("does not trust playlist probes that finally resolve outside trusted HLS domains", async () => {
    const redirected1080 =
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/1080p/segment/chunklist_1080p.m3u8?Policy=redacted";
    const { listeners } = await loadBackground({
      responsesByUrl: new Map([
        [
          redirected1080,
          {
            body: "#EXTM3U\n#EXT-X-VERSION:3\n",
            url: "https://untrusted.example.invalid/chunklist_1080p.m3u8",
          },
        ],
      ]),
    });

    const redirect = await listeners.onBeforeRequest(firstLowQualityRequest(67));

    assert.equal(redirect, undefined, "cross-origin final probe URLs must fail closed");
  });

  it("fails closed on candidate redirects because Firefox cannot inspect manual redirect hops", async () => {
    const requested2160 =
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/2160p/segment/chunklist_2160p.m3u8?Policy=redacted";
    const redirected2160 =
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/redirected/2160p/chunklist_2160p.m3u8";
    const { fetchOptions, fetches, listeners } = await loadBackground({
      responsesByUrl: new Map([
        [
          requested2160,
          {
            headers: { location: redirected2160 },
            ok: false,
            status: 302,
          },
        ],
        [redirected2160, { body: "#EXTM3U\n#EXT-X-VERSION:3\n" }],
      ]),
    });

    const redirect = await listeners.onBeforeRequest(firstLowQualityRequest(670));

    assert.equal(redirect, undefined);
    assert.equal(fetches[0], requested2160);
    assert.equal(fetches.includes(redirected2160), false);
    assert.equal(
      fetchOptions.every((options) => options.redirect === "error"),
      true,
    );
  });

  it("never waits outside the blocking budget when diagnostics storage fails and error reporting stalls", async () => {
    const stalledWrite = deferred();
    let writes = 0;
    const { listeners } = await loadBackground({
      availableQualities: new Set(["1080p"]),
      storageSetImplementation: async () => {
        writes += 1;
        if (writes === 1) throw new Error("synthetic storage failure");
        await stalledWrite.promise;
      },
    });

    const outcome = await Promise.race([
      listeners.onBeforeRequest(firstLowQualityRequest(672)).then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    stalledWrite.resolve();

    assert.equal(
      outcome,
      "returned",
      "diagnostics and error reporting must never extend the blocking deadline",
    );
  });

  it("normalizes corrupt stored diagnostics before mutating runtime state", async () => {
    const { listeners, storage } = await loadBackground({ availableQualities: new Set(["1080p"]) });
    storage.chzzkDiagnostics = {
      decisions: "corrupt",
      qualities: null,
      runtimeRedirects: null,
      samples: "corrupt",
    };

    const redirect = plain(await listeners.onBeforeRequest(firstLowQualityRequest(68)));
    await waitForDiagnosticsQueue();

    assert.equal(redirect.redirectUrl.includes("1080p"), true);
    assert.equal(Array.isArray(storage.chzzkDiagnostics.decisions), true);
    assert.equal(Array.isArray(storage.chzzkDiagnostics.samples), true);
    assert.equal(typeof storage.chzzkDiagnostics.qualities, "object");
    assert.equal(typeof storage.chzzkDiagnostics.runtimeRedirects, "object");
  });
});
