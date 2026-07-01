import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadBackground({ availableQualities = new Set() } = {}) {
  const listeners = {};
  const storage = {};
  const fetches = [];
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
      fetches.push(String(url));
      const ok = [...availableQualities].some((quality) => String(url).includes(quality));
      return { ok, text: async () => (ok ? "#EXTM3U\n#EXT-X-VERSION:3\n" : "not found") };
    },
    globalThis: null,
    setTimeout,
  };
  context.globalThis = context;
  context.browser = {
    runtime: {
      onInstalled: { addListener(fn) { listeners.onInstalled = fn; } },
      onMessage: { addListener(fn) { listeners.onMessage = fn; } },
      onStartup: { addListener(fn) { listeners.onStartup = fn; } },
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
      onRemoved: { addListener(fn) { listeners.onRemoved = fn; } },
      onUpdated: { addListener(fn) { listeners.onUpdated = fn; } },
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

  return { fetches, listeners, storage };
}

async function waitForDiagnosticsQueue() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("background runtime quality resolution", () => {
  it("does not hard-code a startup quality and redirects the first request to the highest supported candidate", async () => {
    const { fetches, listeners, storage } = await loadBackground({ availableQualities: new Set(["1440p", "1080p"]) });

    listeners.onMessage({ type: "chzzk.live-page-ready" }, { tab: { id: 42 } });
    await waitForDiagnosticsQueue();

    assert.deepEqual(
      plain(storage.chzzkDiagnostics.runtimeRedirects.targetsByTab),
      {},
      "prewarm must trust the tab but must not seed a fixed 1080p target",
    );

    const requestUrl =
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/360p/segment/chunklist_480p.m3u8?Policy=redacted";
    const redirect = plain(
      await listeners.onBeforeRequest({
        documentUrl: undefined,
        initiator: "https://chzzk.naver.com",
        method: "GET",
        originUrl: undefined,
        tabId: 42,
        type: "xmlhttprequest",
        url: requestUrl,
      }),
    );

    assert.equal(
      redirect.redirectUrl,
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/1440p/segment/chunklist_1440p.m3u8?Policy=redacted",
    );
    assert.equal(fetches.some((url) => url.includes("2160p")), true, "must probe above 1440 before selecting it");
    assert.equal(fetches.some((url) => url.includes("1440p")), true, "must prove the selected highest quality exists");

    await waitForDiagnosticsQueue();
    const diagnostics = plain(storage.chzzkDiagnostics);
    assert.deepEqual(diagnostics.runtimeRedirects.targetsByTab, { 42: "1440p" });
    assert.equal(diagnostics.decisions.at(-1).targetQuality, "1440p");
    assert.equal(diagnostics.decisions.at(-1).redirectedCurrentRequest, true);
  });
});
