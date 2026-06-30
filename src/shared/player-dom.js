import { SOURCE_QUALITY, TARGET_QUALITY, normalizeQualityLabel } from "./quality.js";

export { SOURCE_QUALITY };
export const GRID_BYPASS_DISPLAY_QUALITY = TARGET_QUALITY;
export const GRID_BYPASS_BADGE_TEXT = "with CHZZK GRID™";
export const GRID_BYPASS_STORAGE_VALUE = SOURCE_QUALITY;
export const QUALITY_LIST_SELECTOR = "ul.pzp-setting-quality-pane__list-container";
export const QUALITY_ITEM_SELECTOR = `${QUALITY_LIST_SELECTOR} > li`;
const GRID_BYPASS_SOURCE_ATTRIBUTE = "data-chzzk-grid-bypass-source";

export function safeText(element) {
  return element?.innerText?.trim() ?? element?.textContent?.trim() ?? "";
}

export function isGridBypassItem(element) {
  if (!element) return false;
  return (
    element.getAttribute?.(GRID_BYPASS_SOURCE_ATTRIBUTE) === SOURCE_QUALITY ||
    safeText(element).includes(GRID_BYPASS_BADGE_TEXT)
  );
}

export function findQualityItems(documentRef = globalThis.document) {
  return [...(documentRef?.querySelectorAll?.(QUALITY_ITEM_SELECTOR) ?? [])];
}

export function findSourceQualityItem(documentRef = globalThis.document) {
  return (
    findQualityItems(documentRef).find(
      (element) => isGridBypassItem(element) || normalizeQualityLabel(safeText(element)) === SOURCE_QUALITY,
    ) ?? null
  );
}

export function findCheckedQualityItem(documentRef = globalThis.document) {
  return (
    documentRef?.querySelector?.(`${QUALITY_ITEM_SELECTOR}.pzp-ui-setting-pane-item--checked`) ??
    documentRef?.querySelector?.(`${QUALITY_ITEM_SELECTOR}[aria-selected='true']`) ??
    documentRef?.querySelector?.("li.pzp-ui-setting-pane-item--checked") ??
    documentRef?.querySelector?.("li[aria-selected='true']") ??
    null
  );
}

export function createGridBypassBadge(documentRef = globalThis.document) {
  const badgeWrap = documentRef.createElement("div");
  badgeWrap.className = "pzp-ui-track-badge";

  const badge = documentRef.createElement("em");
  badge.className = "pzp-ui-track-badge__badge";
  badge.style.verticalAlign = "super";
  badge.textContent = GRID_BYPASS_BADGE_TEXT;

  badgeWrap.append(badge);
  return badgeWrap;
}

export function renderGridBypassQualityLabel(element, { document: documentRef = globalThis.document } = {}) {
  if (!element || !documentRef) return false;

  const target =
    element.querySelector("li > div:nth-child(2) > span > div") ?? element.querySelector("span") ?? element;

  const prefix = documentRef.createElement("span");
  prefix.className = "pzp-pc-ui-setting-quality-item__prefix";
  prefix.append(
    documentRef.createTextNode(`${GRID_BYPASS_DISPLAY_QUALITY}\u00a0`),
    createGridBypassBadge(documentRef),
  );
  target.replaceChildren(prefix);
  element.setAttribute(GRID_BYPASS_SOURCE_ATTRIBUTE, SOURCE_QUALITY);
  return true;
}

export function updateCurrentGridBypassQualityText(documentRef = globalThis.document) {
  const currentQualityTextElement = documentRef?.querySelector?.(
    "div.pzp-setting-intro-quality > div > div:last-child > span.pzp-ui-setting-home-item__value",
  );
  const selectedQuality = findCheckedQualityItem(documentRef);
  if (!currentQualityTextElement || !isGridBypassItem(selectedQuality)) return false;

  currentQualityTextElement.replaceChildren(
    documentRef.createTextNode(`${GRID_BYPASS_DISPLAY_QUALITY} `),
    createGridBypassBadge(documentRef),
  );
  return true;
}

export function canonicalStoredQualityForItem(element) {
  if (!element) return null;
  if (isGridBypassItem(element)) return GRID_BYPASS_STORAGE_VALUE;
  return normalizeQualityLabel(safeText(element));
}

export function findQualityItemByStoredValue(documentRef, storedQuality) {
  const normalizedStoredQuality = normalizeQualityLabel(storedQuality);
  if (!normalizedStoredQuality) return null;

  if (normalizedStoredQuality === GRID_BYPASS_STORAGE_VALUE) {
    return findSourceQualityItem(documentRef);
  }

  return (
    findQualityItems(documentRef).find(
      (element) => normalizeQualityLabel(safeText(element)) === normalizedStoredQuality,
    ) ?? null
  );
}
