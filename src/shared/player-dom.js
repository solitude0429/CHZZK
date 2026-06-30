import { normalizeQualityLabel } from "./quality.js";

export const QUALITY_LIST_SELECTOR = "ul.pzp-setting-quality-pane__list-container";
export const QUALITY_ITEM_SELECTORS = [
  `${QUALITY_LIST_SELECTOR} > li`,
  "li.pzp-ui-setting-quality-item",
  "[class*='setting-quality'] li",
];

export function safeText(element) {
  return element?.innerText?.trim() ?? element?.textContent?.trim() ?? "";
}

export function getQualityItems(documentRef = globalThis.document) {
  if (!documentRef?.querySelectorAll) return [];

  const seen = new Set();
  const items = [];

  for (const selector of QUALITY_ITEM_SELECTORS) {
    for (const element of documentRef.querySelectorAll(selector)) {
      if (seen.has(element)) continue;
      seen.add(element);
      if (normalizeQualityLabel(safeText(element))) items.push(element);
    }
  }

  return items;
}

export function getVisibleQualityLabels(documentRef = globalThis.document) {
  return getQualityItems(documentRef)
    .map((element) => normalizeQualityLabel(safeText(element)))
    .filter(Boolean);
}

export function findQualityItem(documentRef, label) {
  const normalized = normalizeQualityLabel(label);
  if (!normalized) return null;

  return (
    getQualityItems(documentRef).find((element) => normalizeQualityLabel(safeText(element)) === normalized) ??
    null
  );
}

export function findCheckedQualityItem(documentRef = globalThis.document) {
  return (
    documentRef?.querySelector?.("li.pzp-ui-setting-pane-item--checked") ??
    documentRef?.querySelector?.("li[aria-selected='true']") ??
    null
  );
}

export function createBadge(documentRef = globalThis.document, badgeText = "CHZZK") {
  const badgeWrap = documentRef.createElement("div");
  badgeWrap.className = "pzp-ui-track-badge";

  const badge = documentRef.createElement("em");
  badge.className = "pzp-ui-track-badge__badge";
  badge.style.verticalAlign = "super";
  badge.textContent = badgeText;

  badgeWrap.append(badge);
  return badgeWrap;
}

export function setQualityItemDisplay(
  element,
  label,
  { document: documentRef = globalThis.document, badgeText = "CHZZK" } = {},
) {
  if (!element || !label || !documentRef) return false;

  const target =
    element.querySelector("li > div:nth-child(2) > span > div") ?? element.querySelector("span") ?? element;

  const prefix = documentRef.createElement("span");
  prefix.className = "pzp-pc-ui-setting-quality-item__prefix";
  prefix.append(documentRef.createTextNode(`${label}\u00a0`), createBadge(documentRef, badgeText));
  target.replaceChildren(prefix);
  return true;
}

export function updateCurrentQualityText(documentRef, targetQuality, { badgeText = "CHZZK" } = {}) {
  const currentQualityTextElement = documentRef?.querySelector?.(
    "div.pzp-setting-intro-quality > div > div:last-child > span.pzp-ui-setting-home-item__value",
  );
  const checkedQuality = normalizeQualityLabel(safeText(findCheckedQualityItem(documentRef)));
  if (!currentQualityTextElement || checkedQuality !== targetQuality) return false;

  currentQualityTextElement.replaceChildren(
    documentRef.createTextNode(`${targetQuality} `),
    createBadge(documentRef, badgeText),
  );
  return true;
}
