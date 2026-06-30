import {
  chooseHighestQuality,
  choosePreferredVisibleQuality,
  normalizeQualityLabel,
  parseQualityFromUrl,
  qualityRank,
  redactMediaUrl,
} from "./shared/quality.js";
import {
  QUALITY_LIST_SELECTOR,
  findCheckedQualityItem,
  findQualityItem,
  getVisibleQualityLabels,
  safeText,
  setQualityItemDisplay,
  updateCurrentQualityText,
} from "./shared/player-dom.js";

const LOG_PREFIX = "[CHZZK]";
const STORAGE_KEY = "chzzk.selectedQualityText";
const BADGE_TEXT = "CHZZK";
const LIVE_URL_RE = /^https:\/\/chzzk\.naver\.com\/live\/[0-9a-z]+/i;
const MEDIA_PLAYLIST_RE = /\.m3u8(?:[?#]|$)/i;

let qualityListElement = null;
let observerTick = 0;
let performanceScanCursor = 0;
let lastQualityDiagnostic = "";
const observedQualities = new Set();

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

  observedQualities.add(quality);
  const highestQuality = chooseHighestQuality([...observedQualities]);
  const diagnosticKey = `${highestQuality}:${[...observedQualities].sort().join(",")}`;
  if (diagnosticKey === lastQualityDiagnostic) return;

  lastQualityDiagnostic = diagnosticKey;
  log("observed HLS qualities", {
    highestQuality,
    qualities: [...observedQualities].sort((a, b) => qualityRank(a) - qualityRank(b)),
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

function updateQualityText() {
  const targetQuality = choosePreferredVisibleQuality(
    getVisibleQualityLabels(document),
    localStorage.getItem(STORAGE_KEY),
  );
  if (!targetQuality) return false;

  const targetQualityItem = findQualityItem(document, targetQuality);
  if (!targetQualityItem) return false;

  const changed = setQualityItemDisplay(targetQualityItem, targetQuality, {
    badgeText: BADGE_TEXT,
    document,
  });
  updateCurrentQualityText(document, targetQuality, { badgeText: BADGE_TEXT });
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
  const item = findQualityItem(document, label);
  if (!item) return false;

  item.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  item.click?.();
  return true;
}

function restoreQuality() {
  const targetQuality = choosePreferredVisibleQuality(
    getVisibleQualityLabels(document),
    localStorage.getItem(STORAGE_KEY),
  );
  if (!targetQuality) return;

  const currentQuality = normalizeQualityLabel(safeText(findCheckedQualityItem(document)));
  if (currentQuality === targetQuality) return;

  const videoElement = document.querySelector("video.webplayer-internal-video");
  if (!videoElement || videoElement.readyState < 2) return;

  openQualityMenu();
  if (selectQuality(targetQuality)) {
    updateQualityText();
    log("requested quality", targetQuality);
  }
}

function saveQuality() {
  window.setTimeout(() => {
    const selectedQuality = normalizeQualityLabel(safeText(findCheckedQualityItem(document)));
    if (!selectedQuality) return;

    localStorage.setItem(STORAGE_KEY, selectedQuality);
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

if (!globalThis.__CHZZK_EXTENSION_INJECTED__) {
  globalThis.__CHZZK_EXTENSION_INJECTED__ = true;

  log("page script injected");
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
