(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const LIVE_URL_RE = /^https?:\/\/chzzk\.naver\.com\/live\/[0-9a-z]+/i;
  const LOG_PREFIX = "[CHZZK]";
  const injectedByTab = new Map();

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function isChzzkLiveUrl(url) {
    return typeof url === "string" && LIVE_URL_RE.test(url);
  }

  async function injectScript(tabId, url) {
    const previousUrl = injectedByTab.get(tabId);
    if (previousUrl === url) return;

    try {
      await extensionApi.scripting.executeScript({
        files: ["inject.js"],
        target: { tabId },
        world: "MAIN",
      });
      injectedByTab.set(tabId, url);
      log("injected page script", url);
    } catch (error) {
      warn("failed to inject page script", error);
    }
  }

  if (!extensionApi?.tabs?.onUpdated) {
    warn("extension API is unavailable");
    return;
  }

  extensionApi.tabs.onRemoved?.addListener((tabId) => {
    injectedByTab.delete(tabId);
  });

  extensionApi.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const url = changeInfo.url ?? tab.url;
    if (!isChzzkLiveUrl(url)) return;

    if (changeInfo.status === "complete" || changeInfo.url) {
      await injectScript(tabId, url);
    }
  });
})();
