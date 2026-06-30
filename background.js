(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const LIVE_URL_RE = /^https?:\/\/chzzk\.naver\.com\/live\/[0-9a-z]+/i;
  const LOG_PREFIX = "[CHZZK]";
  const GRID_RULESET_ID = "ruleset_1";
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

  async function setGridRulesetEnabled(enabled) {
    if (!extensionApi?.declarativeNetRequest?.updateEnabledRulesets) {
      warn("declarativeNetRequest API is unavailable; grid bypass redirect cannot be toggled");
      return;
    }

    try {
      await extensionApi.declarativeNetRequest.updateEnabledRulesets({
        disableRulesetIds: enabled ? [] : [GRID_RULESET_ID],
        enableRulesetIds: enabled ? [GRID_RULESET_ID] : [],
      });
      log(`grid bypass redirect ruleset ${enabled ? "enabled" : "disabled"}`);
    } catch (error) {
      warn("failed to update grid bypass redirect ruleset", error);
    }
  }

  async function isWindows() {
    try {
      const platformInfo = await extensionApi.runtime.getPlatformInfo();
      return platformInfo.os === "win";
    } catch (error) {
      warn("failed to read platform info", error);
      return true;
    }
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
      log("injected grid bypass page script", url);
    } catch (error) {
      warn("failed to inject grid bypass page script", error);
    }
  }

  if (!extensionApi?.tabs?.onUpdated) {
    warn("extension API is unavailable");
    return;
  }

  extensionApi.runtime.onStartup?.addListener(async () => {
    await setGridRulesetEnabled(await isWindows());
  });

  extensionApi.runtime.onInstalled?.addListener(async () => {
    await setGridRulesetEnabled(await isWindows());
  });

  extensionApi.tabs.onRemoved?.addListener((tabId) => {
    injectedByTab.delete(tabId);
  });

  extensionApi.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const url = changeInfo.url ?? tab.url;
    if (!isChzzkLiveUrl(url)) return;

    const rulesetEnabled = await isWindows();
    await setGridRulesetEnabled(rulesetEnabled);
    if (!rulesetEnabled) {
      log("grid bypass redirect disabled on non-Windows platform");
    }

    if (changeInfo.status === "complete" || changeInfo.url) {
      await injectScript(tabId, url);
    }
  });
})();
