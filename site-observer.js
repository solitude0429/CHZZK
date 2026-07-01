(() => {
  // src/shared/settings.js
  var SETTINGS_KEY = "chzzkSettings";
  var DEFAULT_SETTINGS = Object.freeze({
    telemetry: Object.freeze({
      collectorEnabled: false,
      sendDiagnostics: false,
      sendErrors: false,
      sendStructure: false,
    }),
  });
  function asBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }
  function normalizeSettings(value = {}) {
    const telemetry = value?.telemetry ?? {};
    return {
      telemetry: {
        collectorEnabled: asBoolean(telemetry.collectorEnabled, DEFAULT_SETTINGS.telemetry.collectorEnabled),
        sendDiagnostics: asBoolean(telemetry.sendDiagnostics, DEFAULT_SETTINGS.telemetry.sendDiagnostics),
        sendErrors: asBoolean(telemetry.sendErrors, DEFAULT_SETTINGS.telemetry.sendErrors),
        sendStructure: asBoolean(telemetry.sendStructure, DEFAULT_SETTINGS.telemetry.sendStructure),
      },
    };
  }
  function telemetryEventCategory(eventType) {
    const type = String(eventType ?? "");
    if (type === "session-rule-error" || type.includes("error") || type.includes("unhandledrejection")) {
      return "errors";
    }
    if (type.startsWith("site-")) return "structure";
    if (type === "diagnostics-summary") return "diagnostics";
    return "diagnostics";
  }
  function isTelemetryEventEnabled(settings, eventType) {
    const { telemetry } = normalizeSettings(settings);
    if (!telemetry.collectorEnabled) return false;
    switch (telemetryEventCategory(eventType)) {
      case "errors":
        return telemetry.sendErrors;
      case "structure":
        return telemetry.sendStructure;
      case "diagnostics":
        return telemetry.sendDiagnostics;
      default:
        return false;
    }
  }

  // src/shared/telemetry.js
  var TELEMETRY_SCOPE = "chzzk-live";
  var TELEMETRY_SCHEMA_VERSION = 1;
  var MAX_CLASS_TOKENS = 80;
  var MAX_SELECTOR_SAMPLE = 120;
  var MAX_ERROR_TEXT = 300;
  var MAX_URL_TEXT = 500;
  var CLASS_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_-]{0,48}$/;
  var SENSITIVE_KEY_RE =
    /(?:policy|signature|key-pair-id|expires|token|auth|session|secret|credential|jwt|cookie)/i;
  var SCRIPT_ERROR_RE = /\b(referenceerror|typeerror|syntaxerror|rangeerror|evalerror)\b/i;
  var NETWORK_ERROR_RE = /\b(network|fetch|timeout|http\s*\d{3}|connection|cors|dns)\b/i;
  function extractQuality(value) {
    const match = String(value ?? "").match(/(?:^|[^0-9])(\d{3,4}p)(?:[^0-9]|$)/i);
    return match?.[1]?.toLowerCase() ?? null;
  }
  function extensionFromPath(pathname) {
    const match = pathname.match(/\.([a-z0-9]{2,8})$/i);
    return match?.[1]?.toLowerCase() ?? null;
  }
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
    if (typeof value !== "string") return "";
    const input = value.slice(0, MAX_URL_TEXT);
    try {
      const parsed = new URL(input);
      if (!/^https?:$/.test(parsed.protocol)) return "[redacted-url]";
      const quality = extractQuality(parsed.pathname);
      const extension = extensionFromPath(parsed.pathname);
      const suffix = [quality, extension].filter(Boolean).join(".");
      return `${parsed.protocol}//${parsed.hostname.toLowerCase()}/[redacted-path]${suffix ? `/${suffix}` : ""}`;
    } catch {
      return input.replace(/[?#].*$/, "?[redacted]").replace(/[A-Za-z0-9_-]{24,}/g, "[redacted-token]");
    }
  }
  function sanitizeErrorText(value) {
    if (value == null) return null;
    const text = String(value).slice(0, MAX_ERROR_TEXT);
    if (/^error:[a-z0-9-]{1,80}$/.test(text)) return text;
    if (/https?:\/\/[^\s)]+/i.test(text) && SENSITIVE_KEY_RE.test(text))
      return "error:url-with-sensitive-material";
    if (SENSITIVE_KEY_RE.test(text)) return "error:sensitive-material";
    if (SCRIPT_ERROR_RE.test(text)) {
      const kind = text.match(SCRIPT_ERROR_RE)?.[1]?.toLowerCase().replace("error", "") || "script";
      return `error:script-${kind || "exception"}`;
    }
    if (NETWORK_ERROR_RE.test(text)) return "error:network";
    return text ? "error:page-exception" : null;
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
  var observer = null;
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
    await api.runtime.sendMessage({
      report: makeTelemetryReport({ diagnostics, eventType: reportEventType, structure }),
      scope: TELEMETRY_SCOPE,
      type: "chzzk.telemetry.report",
    });
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
  if (isChzzkLivePageUrl(globalThis.location.href)) {
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
})();
