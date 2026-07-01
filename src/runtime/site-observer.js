import { isTelemetryEventEnabled, SETTINGS_KEY } from "../shared/settings.js";
import {
  isChzzkLivePageUrl,
  makeTelemetryReport,
  sanitizeErrorText,
  summarizeDomStructure,
  TELEMETRY_SCOPE,
} from "../shared/telemetry.js";

const api = globalThis.browser ?? globalThis.chrome;
const REPORT_DEBOUNCE_MS = 15_000;
const MUTATION_REPORT_MIN_MS = 10 * 60 * 1000;
const MAX_NODES = 220;
const STRUCTURE_TAGS = [
  "a",
  "button",
  "canvas",
  "div",
  "iframe",
  "img",
  "li",
  "nav",
  "section",
  "source",
  "span",
  "ul",
  "video",
];
const FEATURE_SELECTORS = {
  canvas: "canvas",
  chatLikeClass: '[class*="chat" i]',
  hlsScript: 'script[src*="hls" i]',
  iframe: "iframe",
  liveLikeClass: '[class*="live" i]',
  playerLikeClass: '[class*="player" i]',
  qualityLikeClass: '[class*="quality" i]',
  video: "video",
};

let lastStructureHash = null;
let lastMutationReportAt = 0;
let pendingTimer = null;
let observer = null;

async function telemetryEnabled(eventType) {
  const stored = await api.storage.local.get(SETTINGS_KEY);
  return isTelemetryEventEnabled(stored?.[SETTINGS_KEY], eventType);
}

function countSelector(selector) {
  try {
    return document.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

function collectNodes() {
  const nodes = [];
  const elements = document.body?.querySelectorAll(STRUCTURE_TAGS.join(",")) ?? [];
  for (const element of elements) {
    if (nodes.length >= MAX_NODES) break;
    nodes.push({
      classes: [...element.classList].slice(0, 12),
      tag: element.tagName.toLowerCase(),
    });
  }
  return nodes;
}

function collectStructure() {
  const tagCounts = Object.fromEntries(
    STRUCTURE_TAGS.map((tag) => [tag, document.getElementsByTagName(tag).length]),
  );
  const featureCounts = Object.fromEntries(
    Object.entries(FEATURE_SELECTORS).map(([name, selector]) => [name, countSelector(selector)]),
  );
  return summarizeDomStructure({
    featureCounts,
    nodes: collectNodes(),
    tagCounts,
    url: globalThis.location.href,
  });
}

async function sendStructureReport(reason) {
  const eventType = `site-${reason}`;
  if (!isChzzkLivePageUrl(globalThis.location.href)) return;
  if (reason === "mutation" && document.visibilityState === "hidden") return;
  if (!(await telemetryEnabled(eventType))) return;

  const structure = collectStructure();
  if (!structure) return;

  const now = Date.now();
  if (reason === "mutation" && structure.structureHash === lastStructureHash) return;
  if (reason === "mutation" && now - lastMutationReportAt < MUTATION_REPORT_MIN_MS) return;

  lastStructureHash = structure.structureHash;
  if (reason === "mutation") lastMutationReportAt = now;

  await api.runtime.sendMessage({
    report: makeTelemetryReport({ eventType, structure }),
    scope: TELEMETRY_SCOPE,
    type: "chzzk.telemetry.report",
  });
}

function scheduleStructureReport(reason = "mutation") {
  if (document.visibilityState === "hidden") return;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    sendStructureReport(reason).catch(() => {});
  }, REPORT_DEBOUNCE_MS);
}

async function reportPageError(eventType, errorLike) {
  const reportEventType = `site-${eventType}`;
  if (!isChzzkLivePageUrl(globalThis.location.href)) return;
  if (!(await telemetryEnabled(reportEventType))) return;

  const structure = collectStructure();
  const diagnostics = {
    decisions: [
      {
        ok: false,
        reason: eventType,
        seenAt: new Date().toISOString(),
        url: globalThis.location.href,
      },
    ],
    generatedAt: new Date().toISOString(),
    qualities: {},
    samples: [],
    sessionRules: {
      activeRuleIds: [],
      activeTabIds: [],
      lastError: sanitizeErrorText(errorLike?.stack ?? errorLike?.message ?? errorLike),
      updatedAt: new Date().toISOString(),
    },
    totalHlsRequests: 0,
  };
  await api.runtime.sendMessage({
    report: makeTelemetryReport({ diagnostics, eventType: reportEventType, structure }),
    scope: TELEMETRY_SCOPE,
    type: "chzzk.telemetry.report",
  });
}

function notifyLivePageReady() {
  return api.runtime
    .sendMessage({ scope: TELEMETRY_SCOPE, type: "chzzk.live-page-ready" })
    .catch(() => {});
}

function observeBody() {
  if (observer || !document.body || document.visibilityState === "hidden") return;
  observer = new MutationObserver(() => scheduleStructureReport("mutation"));
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
    subtree: true,
  });
}

function disconnectObserver() {
  if (!observer) return;
  observer.disconnect();
  observer = null;
}

function handleVisibilityChange() {
  if (document.visibilityState === "hidden") {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    disconnectObserver();
    return;
  }
  observeBody();
  scheduleStructureReport("mutation");
}

let siteObservationStarted = false;

function startSiteObservation() {
  if (siteObservationStarted) return;
  siteObservationStarted = true;

  sendStructureReport("load").catch(() => {});
  observeBody();

  globalThis.addEventListener("visibilitychange", handleVisibilityChange);
  globalThis.addEventListener("error", (event) => {
    reportPageError("error", event.error ?? event.message).catch(() => {});
  });
  globalThis.addEventListener("unhandledrejection", (event) => {
    reportPageError("unhandledrejection", event.reason).catch(() => {});
  });
}

if (isChzzkLivePageUrl(globalThis.location.href)) {
  notifyLivePageReady().catch(() => {});
  if (document.readyState === "loading") {
    globalThis.addEventListener("DOMContentLoaded", startSiteObservation, { once: true });
  } else {
    startSiteObservation();
  }
}
