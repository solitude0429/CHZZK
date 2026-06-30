(() => {
  "use strict";

  const LOG_PREFIX = "[CHZZK]";
  const STORAGE_KEY = "chzzk.selectedQualityText";
  const SOURCE_LABEL = "480p";
  const DISPLAY_LABEL = "1080p";
  const BADGE_TEXT = "CHZZK";
  const LIVE_URL_RE = /^https:\/\/chzzk\.naver\.com\/live\/[0-9a-z]+/i;
  const QUALITY_LIST_SELECTOR = "ul.pzp-setting-quality-pane__list-container";
  const QUALITY_ITEM_SELECTORS = [
    `${QUALITY_LIST_SELECTOR} > li`,
    "li.pzp-ui-setting-quality-item",
    "[class*='setting-quality'] li",
  ];

  let qualityListElement = null;
  let observerTick = 0;

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function isLivePage() {
    return LIVE_URL_RE.test(location.href);
  }

  function safeText(element) {
    return element?.innerText?.trim() ?? "";
  }

  function getQualityItems() {
    const seen = new Set();
    const items = [];

    for (const selector of QUALITY_ITEM_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);
        if (safeText(element)) items.push(element);
      }
    }

    return items;
  }

  function findQualityItem(label) {
    return getQualityItems().find((element) => safeText(element).includes(label)) ?? null;
  }

  function findCheckedQualityItem() {
    return (
      document.querySelector("li.pzp-ui-setting-pane-item--checked") ??
      document.querySelector("li[aria-selected='true']") ??
      null
    );
  }

  function createBadge() {
    const badgeWrap = document.createElement("div");
    badgeWrap.className = "pzp-ui-track-badge";

    const badge = document.createElement("em");
    badge.className = "pzp-ui-track-badge__badge";
    badge.style.verticalAlign = "super";
    badge.textContent = BADGE_TEXT;

    badgeWrap.append(badge);
    return badgeWrap;
  }

  function setQualityItemDisplay(element) {
    if (!element) return false;

    const target =
      element.querySelector("li > div:nth-child(2) > span > div") ?? element.querySelector("span") ?? element;

    const prefix = document.createElement("span");
    prefix.className = "pzp-pc-ui-setting-quality-item__prefix";
    prefix.append(document.createTextNode(`${DISPLAY_LABEL}\u00a0`), createBadge());
    target.replaceChildren(prefix);
    return true;
  }

  function updateCurrentQualityText() {
    const currentQualityTextElement = document.querySelector(
      "div.pzp-setting-intro-quality > div > div:last-child > span.pzp-ui-setting-home-item__value",
    );
    const checkedQuality = findCheckedQualityItem();
    if (!currentQualityTextElement || !checkedQuality) return;

    if (safeText(checkedQuality).includes(BADGE_TEXT) || safeText(checkedQuality).includes(SOURCE_LABEL)) {
      currentQualityTextElement.replaceChildren(document.createTextNode(`${DISPLAY_LABEL} `), createBadge());
    }
  }

  function updateQualityText() {
    const sourceQualityItem = findQualityItem(SOURCE_LABEL);
    if (!sourceQualityItem) return false;

    const changed = setQualityItemDisplay(sourceQualityItem);
    updateCurrentQualityText();
    return changed;
  }

  function openQualityMenu() {
    const settingsButton = document.querySelector(
      "button.pzp-setting-button[command='SettingCommands.Toggle']",
    );
    const qualityIntro = document.querySelector("div.pzp-setting-intro-quality");

    settingsButton?.click();
    qualityIntro?.click();
  }

  function selectQuality(label) {
    const item = findQualityItem(label);
    if (!item) return false;

    item.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    item.click?.();
    return true;
  }

  function restoreQuality() {
    const qualityItems = getQualityItems();
    if (qualityItems.length === 0) return;

    const selectedQuality = localStorage.getItem(STORAGE_KEY) || SOURCE_LABEL;
    const currentQuality = findCheckedQualityItem();
    if (safeText(currentQuality).includes(selectedQuality) || safeText(currentQuality).includes(BADGE_TEXT))
      return;

    const videoElement = document.querySelector("video.webplayer-internal-video");
    if (!videoElement || videoElement.readyState < 2) return;

    openQualityMenu();
    if (selectQuality(selectedQuality)) {
      updateQualityText();
      log("requested quality", selectedQuality === SOURCE_LABEL ? DISPLAY_LABEL : selectedQuality);
    }
  }

  function saveQuality() {
    const checkedQuality = findCheckedQualityItem();
    const text = safeText(checkedQuality);
    if (!text) return;

    localStorage.setItem(STORAGE_KEY, text.includes(BADGE_TEXT) ? SOURCE_LABEL : text);
  }

  function bindQualityListEvents() {
    const list = document.querySelector(QUALITY_LIST_SELECTOR);
    if (!list || list === qualityListElement) return;

    qualityListElement?.removeEventListener("click", saveQuality);
    qualityListElement?.removeEventListener("keydown", saveQuality);
    qualityListElement = list;
    qualityListElement.addEventListener("click", saveQuality);
    qualityListElement.addEventListener("keydown", saveQuality);
  }

  function tick() {
    if (document.readyState !== "complete" || !isLivePage()) return;

    try {
      updateQualityText();
      bindQualityListEvents();
      restoreQuality();
    } catch (error) {
      warn("quality controller failed", error);
    }
  }

  function scheduleTick() {
    window.clearTimeout(observerTick);
    observerTick = window.setTimeout(tick, 250);
  }

  if (globalThis.__CHZZK_EXTENSION_INJECTED__) return;
  globalThis.__CHZZK_EXTENSION_INJECTED__ = true;

  log("page script injected");
  const observer = new MutationObserver(scheduleTick);
  observer.observe(document.body, {
    attributeFilter: ["class", "aria-selected"],
    attributes: true,
    childList: true,
    subtree: true,
  });
  scheduleTick();
})();
