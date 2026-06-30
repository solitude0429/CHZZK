import { SOURCE_QUALITY, TARGET_QUALITY, parseQualityFromUrl, redactMediaUrl } from "./shared/quality.js";
import {
  GRID_BYPASS_STORAGE_VALUE,
  QUALITY_LIST_SELECTOR,
  canonicalStoredQualityForItem,
  findCheckedQualityItem,
  findQualityItemByStoredValue,
  findSourceQualityItem,
  renderGridBypassQualityLabel,
  safeText,
  updateCurrentGridBypassQualityText,
} from "./shared/player-dom.js";

const LOG_PREFIX = "[CHZZK]";
const STORAGE_KEY = "chzzk.gridBypass.selectedQuality";
const LIVE_URL_RE = /^https:\/\/chzzk\.naver\.com\/live\/[0-9a-z]+/i;
const MEDIA_PLAYLIST_RE = /\.m3u8(?:[?#]|$)/i;
const DEFAULT_STORED_QUALITY = "360p";
const RESTORE_THROTTLE_MS = 1000;

let qualityListElement = null;
let observerTick = 0;
let performanceScanCursor = 0;
let previousIntroQualityText = "";
let previousRestoreAttempt = 0;
let lastObservedRedirectPair = "";

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

function isLivePage() {
  return LIVE_URL_RE.test(location.href);
}

function recordMediaUrl(url) {
  if (typeof url !== "string" || !MEDIA_PLAYLIST_RE.test(url)) return;

  const quality = parseQualityFromUrl(url);
  if (!quality) return;

  const pairKey = `${quality}:${redactMediaUrl(url)}`;
  if (quality !== SOURCE_QUALITY && quality !== TARGET_QUALITY) return;
  if (pairKey === lastObservedRedirectPair) return;

  lastObservedRedirectPair = pairKey;
  log("observed HLS playlist", {
    quality,
    sampleUrl: redactMediaUrl(url),
  });
}

function scanPerformanceEntries() {
  if (!globalThis.performance?.getEntriesByType) return;

  const entries = performance.getEntriesByType("resource");
  for (let index = performanceScanCursor; index < entries.length; index += 1) {
    recordMediaUrl(entries[index]?.name);
  }
  performanceScanCursor = entries.length;
}

function startMediaDiagnostics() {
  scanPerformanceEntries();

  if (!globalThis.PerformanceObserver) return;
  try {
    const performanceObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordMediaUrl(entry.name);
    });
    performanceObserver.observe({ type: "resource", buffered: true });
  } catch (error) {
    warn("media diagnostics unavailable", error);
  }
}

function renderGridBypassOption() {
  const sourceQualityItem = findSourceQualityItem(document);
  if (!sourceQualityItem) return false;

  return renderGridBypassQualityLabel(sourceQualityItem, { document });
}

function syncIntroQualityText() {
  if (updateCurrentGridBypassQualityText(document)) return;

  const currentQualityTextElement = document.querySelector(
    "div.pzp-setting-intro-quality > div > div:last-child > span.pzp-ui-setting-home-item__value",
  );
  const selectedQualityText = safeText(findCheckedQualityItem(document));
  if (!currentQualityTextElement || !selectedQualityText) return;

  const introText = safeText(currentQualityTextElement);
  if (previousIntroQualityText !== introText) {
    currentQualityTextElement.textContent = selectedQualityText;
    previousIntroQualityText = selectedQualityText;
  }
}

function openQualityMenu() {
  const settingsButton = document.querySelector(
    "button.pzp-setting-button[command='SettingCommands.Toggle']",
  );
  const qualityIntro = document.querySelector("div.pzp-setting-intro-quality");

  settingsButton?.click();
  qualityIntro?.click();
}

function selectStoredQuality(storedQuality) {
  const item = findQualityItemByStoredValue(document, storedQuality);
  if (!item) return false;

  item.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  item.click?.();
  return true;
}

function restoreQuality() {
  const now = Date.now();
  if (now - previousRestoreAttempt < RESTORE_THROTTLE_MS) return;
  previousRestoreAttempt = now;

  const qualityList = document.querySelector(QUALITY_LIST_SELECTOR);
  if (!qualityList) return;

  const storedQuality = localStorage.getItem(STORAGE_KEY) ?? DEFAULT_STORED_QUALITY;
  const currentQuality = canonicalStoredQualityForItem(findCheckedQualityItem(document));
  if (currentQuality === storedQuality) return;

  const videoElement = document.querySelector("video.webplayer-internal-video");
  if (!videoElement || videoElement.readyState < 3) return;

  openQualityMenu();
  renderGridBypassOption();
  if (selectStoredQuality(storedQuality)) {
    renderGridBypassOption();
    syncIntroQualityText();
    log("requested quality", storedQuality === GRID_BYPASS_STORAGE_VALUE ? TARGET_QUALITY : storedQuality);
  }
}

function saveQuality() {
  window.setTimeout(() => {
    const storedQuality = canonicalStoredQualityForItem(findCheckedQualityItem(document));
    if (!storedQuality) return;

    localStorage.setItem(STORAGE_KEY, storedQuality);
  }, 0);
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
    scanPerformanceEntries();
    renderGridBypassOption();
    syncIntroQualityText();
    bindQualityListEvents();
    restoreQuality();
  } catch (error) {
    warn("grid bypass controller failed", error);
  }
}

function scheduleTick() {
  window.clearTimeout(observerTick);
  observerTick = window.setTimeout(tick, 250);
}

if (!globalThis.__CHZZK_GRID_BYPASS_INJECTED__) {
  globalThis.__CHZZK_GRID_BYPASS_INJECTED__ = true;

  log("grid bypass page script injected");
  startMediaDiagnostics();
  const observer = new MutationObserver(scheduleTick);
  observer.observe(document.body, {
    attributeFilter: ["class", "aria-selected"],
    attributes: true,
    childList: true,
    subtree: true,
  });
  scheduleTick();
}
