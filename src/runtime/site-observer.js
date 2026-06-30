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
  if (!isChzzkLivePageUrl(globalThis.location.href)) return;
  const structure = collectStructure();
  if (!structure) return;

  const now = Date.now();
  if (reason === "mutation" && structure.structureHash === lastStructureHash) return;
  if (reason === "mutation" && now - lastMutationReportAt < MUTATION_REPORT_MIN_MS) return;

  lastStructureHash = structure.structureHash;
  if (reason === "mutation") lastMutationReportAt = now;

  await api.runtime.sendMessage({
    report: makeTelemetryReport({ eventType: `site-${reason}`, structure }),
    scope: TELEMETRY_SCOPE,
    type: "chzzk.telemetry.report",
  });
}

function scheduleStructureReport(reason = "mutation") {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    sendStructureReport(reason).catch(() => {});
  }, REPORT_DEBOUNCE_MS);
}

function reportPageError(eventType, errorLike) {
  if (!isChzzkLivePageUrl(globalThis.location.href)) return;
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
  api.runtime
    .sendMessage({
      report: makeTelemetryReport({ diagnostics, eventType: `site-${eventType}`, structure }),
      scope: TELEMETRY_SCOPE,
      type: "chzzk.telemetry.report",
    })
    .catch(() => {});
}

if (isChzzkLivePageUrl(globalThis.location.href)) {
  sendStructureReport("load").catch(() => {});

  const observer = new MutationObserver(() => scheduleStructureReport("mutation"));
  if (document.body) {
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  }

  globalThis.addEventListener("error", (event) => {
    reportPageError("error", event.error ?? event.message);
  });
  globalThis.addEventListener("unhandledrejection", (event) => {
    reportPageError("unhandledrejection", event.reason);
  });
}
