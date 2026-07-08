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
  responsesByUrl = new Map(),
} = {}) {
  const listeners = {};
  const storage = {};
  const fetches = [];
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
    fetch: async (url) => {
      const stringUrl = String(url);
      fetches.push(stringUrl);
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
            text: async () => response.body ?? response.text ?? "",
            url: response.url ?? stringUrl,
          };
        }
        return { headers: { get: () => null }, ok: true, text: async () => response, url: stringUrl };
      }
      const ok = [...availableQualities].some((quality) => stringUrl.includes(quality));
      return {
        headers: { get: () => null },
        ok,
        text: async () => (ok ? "#EXTM3U\n#EXT-X-VERSION:3\n" : "not found"),
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

  return { fetches, listeners, storage, tabQueries };
}

async function waitForDiagnosticsQueue() {
  await new Promise((resolve) => setTimeout(resolve, 50));
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
