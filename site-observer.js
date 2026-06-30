(() => {
  // src/shared/telemetry.js
  var TELEMETRY_SCOPE = "chzzk-live";
  var TELEMETRY_SCHEMA_VERSION = 1;
  var MAX_CLASS_TOKENS = 80;
  var MAX_SELECTOR_SAMPLE = 120;
  var MAX_ERROR_TEXT = 300;
  var MAX_URL_TEXT = 500;
  var SENSITIVE_QUERY_RE = /[?#].*$/;
  var CLASS_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_-]{0,48}$/;
  function isChzzkLivePageUrl(value) {
    if (typeof value !== "string" || value === "") return false;
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        parsed.hostname === "chzzk.naver.com" &&
        parsed.pathname.startsWith("/live/")
      );
    } catch {
      return false;
    }
  }
  function routeShapeForChzzkLiveUrl(value) {
    if (!isChzzkLivePageUrl(value)) return null;
    return "/live/[redacted]";
  }
  function stripSensitiveTail(value) {
    return typeof value === "string"
      ? value.slice(0, MAX_URL_TEXT).replace(SENSITIVE_QUERY_RE, "?[redacted]")
      : "";
  }
  function sanitizeErrorText(value) {
    if (value == null) return null;
    return String(value)
      .slice(0, MAX_ERROR_TEXT)
      .replace(/https?:\/\/[^\s)]+/gi, (url) => stripSensitiveTail(url));
  }
  function stableHash(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
  function sanitizeClassToken(value) {
    if (typeof value !== "string") return null;
    const token = value.trim();
    if (!CLASS_TOKEN_RE.test(token)) return null;
    if (/[A-Za-z0-9_-]{24,}/.test(token)) return null;
    return token;
  }
  function summarizeClassTokens(tokens = []) {
    const counts = /* @__PURE__ */ new Map();
    for (const token of tokens) {
      const clean = sanitizeClassToken(token);
      if (!clean) continue;
      counts.set(clean, (counts.get(clean) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_CLASS_TOKENS)
      .map(([token, count]) => ({ token, count }));
  }
  function summarizeDomStructure({ url, nodes = [], tagCounts = {}, featureCounts = {} } = {}) {
    const routeShape = routeShapeForChzzkLiveUrl(url);
    if (!routeShape) return null;
    const classTokens = [];
    const selectorSample = [];
    for (const node of nodes.slice(0, MAX_SELECTOR_SAMPLE)) {
      const tag = String(node?.tag ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "");
      if (!tag) continue;
      const classes = Array.isArray(node?.classes)
        ? node.classes.map(sanitizeClassToken).filter(Boolean).slice(0, 5)
        : [];
      classTokens.push(...classes);
      selectorSample.push(classes.length > 0 ? `${tag}.${classes.join(".")}` : tag);
    }
    const classSummary = summarizeClassTokens(classTokens);
    const structureHash = stableHash({ classSummary, featureCounts, routeShape, selectorSample, tagCounts });
    return {
      classSummary,
      featureCounts: sanitizeNumericMap(featureCounts),
      routeShape,
      selectorSample,
      structureHash,
      tagCounts: sanitizeNumericMap(tagCounts),
    };
  }
  function sanitizeNumericMap(value = {}) {
    const out = {};
    for (const [key, raw] of Object.entries(value ?? {})) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(key)) continue;
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0) continue;
      out[key] = Math.min(Math.trunc(number), 1e5);
    }
    return out;
  }
  function summarizeDiagnosticsForTelemetry(snapshot = {}) {
    const decisionsByReason = {};
    for (const decision of snapshot.decisions ?? []) {
      const reason = String(decision?.reason ?? "unknown").slice(0, 80);
      decisionsByReason[reason] = (decisionsByReason[reason] ?? 0) + 1;
    }
    const samples = (snapshot.samples ?? []).slice(-20).map((sample) => ({
      quality: String(sample?.quality ?? "").slice(0, 16) || null,
      seenAt: sample?.seenAt ?? null,
      type: String(sample?.type ?? "").slice(0, 40) || null,
      url: stripSensitiveTail(sample?.url ?? ""),
    }));
    return {
      decisionsByReason,
      generatedAt: snapshot.generatedAt ?? null,
      qualities: sanitizeNumericMap(snapshot.qualities ?? {}),
      samples,
      sessionRules: {
        activeRuleCount: (snapshot.sessionRules?.activeRuleIds ?? []).length,
        activeTabCount: (snapshot.sessionRules?.activeTabIds ?? []).length,
        lastError: sanitizeErrorText(snapshot.sessionRules?.lastError),
        updatedAt: snapshot.sessionRules?.updatedAt ?? null,
      },
      totalHlsRequests: Math.max(0, Math.trunc(Number(snapshot.totalHlsRequests ?? 0) || 0)),
    };
  }
  function makeTelemetryReport({ addonId, diagnostics, eventType, extensionVersion, structure } = {}) {
    const now = /* @__PURE__ */ new Date().toISOString();
    return {
      addonId: addonId ?? null,
      diagnostics: diagnostics ? summarizeDiagnosticsForTelemetry(diagnostics) : null,
      eventType,
      extensionVersion: extensionVersion ?? null,
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      scope: TELEMETRY_SCOPE,
      sentAt: now,
      structure: structure ?? null,
    };
  }

  // src/runtime/site-observer.js
  var api = globalThis.browser ?? globalThis.chrome;
  var REPORT_DEBOUNCE_MS = 15e3;
  var MUTATION_REPORT_MIN_MS = 10 * 60 * 1e3;
  var MAX_NODES = 220;
  var STRUCTURE_TAGS = [
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
  var FEATURE_SELECTORS = {
    canvas: "canvas",
    chatLikeClass: '[class*="chat" i]',
    hlsScript: 'script[src*="hls" i]',
    iframe: "iframe",
    liveLikeClass: '[class*="live" i]',
    playerLikeClass: '[class*="player" i]',
    qualityLikeClass: '[class*="quality" i]',
    video: "video",
  };
  var lastStructureHash = null;
  var lastMutationReportAt = 0;
  var pendingTimer = null;
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
          seenAt: /* @__PURE__ */ new Date().toISOString(),
          url: globalThis.location.href,
        },
      ],
      generatedAt: /* @__PURE__ */ new Date().toISOString(),
      qualities: {},
      samples: [],
      sessionRules: {
        activeRuleIds: [],
        activeTabIds: [],
        lastError: sanitizeErrorText(errorLike?.stack ?? errorLike?.message ?? errorLike),
        updatedAt: /* @__PURE__ */ new Date().toISOString(),
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
})();
