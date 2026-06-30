(() => {
  // policy/quality-policy.json
  var quality_policy_default = {
    targetQuality: "1080p",
    minRedirectQuality: "100p",
    trustedInitiatorDomains: ["chzzk.naver.com"],
    trustedRequestDomains: ["akamaized.net", "navercdn.com", "pstatic.net"],
    resourceTypes: ["media", "xmlhttprequest"],
    requestMethods: ["get"],
    sessionRuleBaseId: 1e5,
    redirectRulePriority: 1,
    urlQualityPrefixes: ["chunklist_", "/"],
    mediaExtensions: ["m3u8"],
    maxDiagnosticsSamples: 200,
    notes: [
      "targetQuality is the configured CHZZK HLS redirect target, not a guarantee that NAVER currently provides that quality for every live stream.",
      "Runtime redirects are installed as tab-scoped session DNR rules only after a trusted CHZZK live HLS request is observed.",
      "The generated regex matches numeric qualities lower than targetQuality by range, not by enumerating current menu values.",
      "No global static ruleset is shipped; request URL, initiator, method, resource type, and tab scope all constrain redirects.",
    ],
  };

  // src/shared/quality.js
  var QUALITY_LABEL_RE = /^(\d{3,4})p$/i;
  var PATH_QUALITY_RE = /(?:chunklist_|\/)(\d{3,4}p)(?=\.m3u8(?:[?#]|$)|\/)/i;
  var RESOLUTION_RE = /(?:RESOLUTION=|^)(\d{3,5})x(\d{3,5})(?:[,\s]|$)/i;
  var TEXT_QUALITY_RE = /(?:^|[^0-9])(\d{3,4})\s*p(?:[^0-9]|$)/i;
  function normalizeQualityLabel(value) {
    if (typeof value !== "string") return null;
    const resolutionMatch = value.match(RESOLUTION_RE);
    if (resolutionMatch) return `${Number(resolutionMatch[2])}p`;
    const qualityMatch = value.match(TEXT_QUALITY_RE);
    if (!qualityMatch) return null;
    return `${Number(qualityMatch[1])}p`;
  }
  function qualityNumber(label) {
    const normalized = normalizeQualityLabel(label);
    if (!normalized) return null;
    const match = normalized.match(QUALITY_LABEL_RE);
    return match ? Number(match[1]) : null;
  }
  function parseQualityFromUrl(url) {
    if (typeof url !== "string") return null;
    let pathname = url;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url.split("?")[0].split("#")[0];
    }
    const pathQuality = pathname.match(PATH_QUALITY_RE);
    return pathQuality ? normalizeQualityLabel(pathQuality[1]) : normalizeQualityLabel(pathname);
  }
  function redactMediaUrl(url) {
    if (typeof url !== "string" || url === "") return "";
    try {
      const parsed = new URL(url);
      const hadSensitiveTail = parsed.search || parsed.hash;
      parsed.search = "";
      parsed.hash = "";
      return `${parsed.toString()}${hadSensitiveTail ? "?[redacted]" : ""}`;
    } catch {
      return url.replace(/[?#].*$/, "?[redacted]");
    }
  }
  function compactDigitsPattern(width) {
    return width === 1 ? "[0-9]" : `[0-9]{${width}}`;
  }
  function regexForZeroToMax(maxText) {
    if (!/^\d+$/.test(maxText)) throw new Error(`invalid numeric max: ${maxText}`);
    if ([...maxText].every((digit) => digit === "9")) return compactDigitsPattern(maxText.length);
    if (maxText.length === 1) {
      const maxDigit = Number(maxText);
      return maxDigit === 0 ? "0" : `[0-${maxDigit}]`;
    }
    const firstDigit = Number(maxText[0]);
    const rest = maxText.slice(1);
    const parts = [];
    if (firstDigit > 0) parts.push(`[0-${firstDigit - 1}]${compactDigitsPattern(rest.length)}`);
    parts.push(`${firstDigit}${regexForZeroToMax(rest)}`);
    return parts.length === 1 ? parts[0] : `(?:${parts.join("|")})`;
  }
  function regexFromPowerOfTenToMax(maxText) {
    if (!/^\d+$/.test(maxText)) throw new Error(`invalid numeric max: ${maxText}`);
    if ([...maxText].every((digit) => digit === "9")) {
      return maxText.length === 1 ? "[1-9]" : `[1-9]${compactDigitsPattern(maxText.length - 1)}`;
    }
    const firstDigit = Number(maxText[0]);
    const rest = maxText.slice(1);
    const parts = [];
    if (firstDigit > 1) parts.push(`[1-${firstDigit - 1}]${compactDigitsPattern(rest.length)}`);
    parts.push(`${firstDigit}${regexForZeroToMax(rest)}`);
    return parts.length === 1 ? parts[0] : `(?:${parts.join("|")})`;
  }
  function lowerQualityNumberRegex(targetQuality, minQuality = "100p") {
    const target = qualityNumber(targetQuality);
    const min = qualityNumber(minQuality);
    if (!target || !min || min >= target) {
      throw new Error(`invalid quality range: min=${minQuality}, target=${targetQuality}`);
    }
    const parts = [];
    const targetDigits = String(target).length;
    for (let width = String(min).length; width <= targetDigits; width += 1) {
      const start = Math.max(min, 10 ** (width - 1));
      const end = Math.min(target - 1, 10 ** width - 1);
      if (start > end) continue;
      if (start === 10 ** (width - 1) && end === 10 ** width - 1) {
        parts.push(width === 1 ? "[1-9]" : `[1-9]${compactDigitsPattern(width - 1)}`);
        continue;
      }
      if (start === 10 ** (width - 1)) {
        parts.push(regexFromPowerOfTenToMax(String(end)));
        continue;
      }
      throw new Error(`unsupported non-power-of-ten lower bound: ${start}-${end}`);
    }
    return parts.length === 1 ? parts[0] : `(?:${parts.join("|")})`;
  }
  function buildQualityRegexFilter({ targetQuality, minRedirectQuality = "100p" }) {
    const lowerPattern = lowerQualityNumberRegex(targetQuality, minRedirectQuality);
    return `(.*(?:chunklist_|/))(${lowerPattern}p)(.*\\.m3u8.*)`;
  }

  // src/shared/diagnostics.js
  function createEmptyDiagnostics({ maxSamples = 200 } = {}) {
    return {
      decisions: [],
      generatedAt: /* @__PURE__ */ new Date(0).toISOString(),
      maxSamples,
      qualities: {},
      samples: [],
      sessionRules: {
        activeRuleIds: [],
        activeTabIds: [],
        lastError: null,
        updatedAt: /* @__PURE__ */ new Date(0).toISOString(),
      },
      totalHlsRequests: 0,
    };
  }
  function capList(list, maxItems) {
    if (list.length > maxItems) {
      list.splice(0, list.length - maxItems);
    }
  }
  function recordDiagnosticUrl(diagnostics, url, { context = {}, now = /* @__PURE__ */ new Date() } = {}) {
    if (!diagnostics || typeof url !== "string" || !/\.m3u8(?:[?#]|$)/i.test(url)) return false;
    const quality = parseQualityFromUrl(url);
    if (!quality) return false;
    diagnostics.totalHlsRequests = (diagnostics.totalHlsRequests ?? 0) + 1;
    diagnostics.qualities ??= {};
    diagnostics.qualities[quality] = (diagnostics.qualities[quality] ?? 0) + 1;
    diagnostics.samples ??= [];
    diagnostics.samples.push({
      quality,
      seenAt: now.toISOString(),
      tabId: context.tabId ?? null,
      type: context.type ?? null,
      url: redactMediaUrl(url),
    });
    capList(diagnostics.samples, diagnostics.maxSamples ?? 200);
    diagnostics.generatedAt = now.toISOString();
    return true;
  }
  function recordDecision(diagnostics, decision, details = {}, { now = /* @__PURE__ */ new Date() } = {}) {
    if (!diagnostics || !decision) return false;
    diagnostics.decisions ??= [];
    diagnostics.decisions.push({
      ok: Boolean(decision.ok),
      quality: decision.quality ?? null,
      reason: decision.reason ?? "unknown",
      seenAt: now.toISOString(),
      tabId: decision.tabId ?? details.tabId ?? null,
      type: details.type ?? null,
      url: redactMediaUrl(details.url ?? ""),
    });
    capList(diagnostics.decisions, diagnostics.maxSamples ?? 200);
    diagnostics.generatedAt = now.toISOString();
    return true;
  }
  function updateSessionRuleDiagnostics(
    diagnostics,
    { activeRuleIds = [], activeTabIds = [], lastError = null, now = /* @__PURE__ */ new Date() } = {},
  ) {
    if (!diagnostics) return false;
    diagnostics.sessionRules = {
      activeRuleIds: [...activeRuleIds].sort((a, b) => a - b),
      activeTabIds: [...activeTabIds].sort((a, b) => a - b),
      lastError,
      updatedAt: now.toISOString(),
    };
    diagnostics.generatedAt = now.toISOString();
    return true;
  }
  function createDiagnosticsSnapshot(diagnostics) {
    return {
      decisions: [...(diagnostics.decisions ?? [])],
      generatedAt: diagnostics.generatedAt,
      qualities: { ...(diagnostics.qualities ?? {}) },
      samples: [...(diagnostics.samples ?? [])],
      sessionRules: {
        activeRuleIds: [...(diagnostics.sessionRules?.activeRuleIds ?? [])],
        activeTabIds: [...(diagnostics.sessionRules?.activeTabIds ?? [])],
        lastError: diagnostics.sessionRules?.lastError ?? null,
        updatedAt: diagnostics.sessionRules?.updatedAt ?? /* @__PURE__ */ new Date(0).toISOString(),
      },
      totalHlsRequests: diagnostics.totalHlsRequests ?? 0,
    };
  }
  function analyzeDiagnostics(snapshot, { targetQuality = "1080p" } = {}) {
    const qualities = Object.keys(snapshot?.qualities ?? {});
    const highestObservedQuality =
      qualities
        .map((quality) => ({ label: quality, value: qualityNumber(quality) }))
        .filter((entry) => entry.value != null)
        .sort((a, b) => b.value - a.value)[0]?.label ?? null;
    const highestObservedNumber = qualityNumber(highestObservedQuality);
    const targetNumber = qualityNumber(targetQuality);
    const needsPolicyUpdate = Boolean(
      highestObservedNumber && targetNumber && highestObservedNumber > targetNumber,
    );
    return {
      highestObservedQuality,
      needsPolicyUpdate,
      observedQualities: qualities.sort((a, b) => (qualityNumber(a) ?? 0) - (qualityNumber(b) ?? 0)),
      suggestedTargetQuality: needsPolicyUpdate ? highestObservedQuality : targetQuality,
      targetQuality,
    };
  }

  // src/shared/session-rules.js
  var DEFAULT_SESSION_RULE_BASE_ID = 1e5;
  var SESSION_RULE_ID_RANGE = 1e5;
  var DEFAULT_RESOURCE_TYPES = ["media", "xmlhttprequest"];
  var DEFAULT_REQUEST_METHODS = ["get"];
  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }
  function canonicalDomainFromUrl(value) {
    if (typeof value !== "string" || value === "") return null;
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  function domainMatches(hostname, canonicalDomain) {
    return hostname === canonicalDomain || hostname.endsWith(`.${canonicalDomain}`);
  }
  function trustedInitiatorDomains(policy) {
    return asArray(policy.trustedInitiatorDomains).length > 0
      ? asArray(policy.trustedInitiatorDomains)
      : ["chzzk.naver.com"];
  }
  function trustedRequestDomains(policy) {
    return asArray(policy.trustedRequestDomains).length > 0
      ? asArray(policy.trustedRequestDomains)
      : ["akamaized.net", "navercdn.com", "pstatic.net"];
  }
  function resourceTypes(policy) {
    return asArray(policy.resourceTypes).length > 0 ? asArray(policy.resourceTypes) : DEFAULT_RESOURCE_TYPES;
  }
  function requestMethods(policy) {
    return asArray(policy.requestMethods).length > 0
      ? asArray(policy.requestMethods)
      : DEFAULT_REQUEST_METHODS;
  }
  function sessionRuleIdForTab(tabId, { baseId = DEFAULT_SESSION_RULE_BASE_ID } = {}) {
    if (!Number.isSafeInteger(tabId) || tabId < 0 || tabId >= SESSION_RULE_ID_RANGE) {
      throw new Error(`invalid tabId for session DNR rule: ${tabId}`);
    }
    return baseId + tabId;
  }
  function isTrustedRequestDomain(url, policy) {
    const hostname = canonicalDomainFromUrl(url);
    if (!hostname) return false;
    return trustedRequestDomains(policy).some((domain) => domainMatches(hostname, domain));
  }
  function isChzzkLiveUrl(url, policy) {
    if (typeof url !== "string" || url === "") return false;
    try {
      const parsed = new URL(url);
      if (
        !trustedInitiatorDomains(policy).some((domain) =>
          domainMatches(parsed.hostname.toLowerCase(), domain),
        )
      ) {
        return false;
      }
      return parsed.pathname === "/live" || parsed.pathname.startsWith("/live/");
    } catch {
      return false;
    }
  }
  function isTrustedChzzkContext(details, policy) {
    if (!details || details.tabId == null || details.tabId < 0 || details.tabId >= SESSION_RULE_ID_RANGE) {
      return false;
    }
    if (isChzzkLiveUrl(details.documentUrl, policy)) return true;
    if (isChzzkLiveUrl(details.originUrl, policy)) return true;
    const initiatorDomain = canonicalDomainFromUrl(details.initiator);
    const hasTrustedInitiator = Boolean(
      initiatorDomain &&
      trustedInitiatorDomains(policy).some((domain) => domainMatches(initiatorDomain, domain)),
    );
    return Boolean(
      hasTrustedInitiator &&
      [details.documentUrl, details.originUrl].some((url) => isChzzkLiveUrl(url, policy)),
    );
  }
  function shouldRecordDiagnostics(details, policy) {
    if (!details?.url || !/\.m3u8(?:[?#]|$)/i.test(details.url)) return false;
    if (!Number.isSafeInteger(details.tabId) || details.tabId < 0 || details.tabId >= SESSION_RULE_ID_RANGE) {
      return false;
    }
    if (!isTrustedRequestDomain(details.url, policy)) return false;
    return isTrustedChzzkContext(details, policy);
  }
  function shouldBootstrapSessionRule(details, policy) {
    const tabId = details?.tabId;
    if (!Number.isSafeInteger(tabId) || tabId < 0 || tabId >= SESSION_RULE_ID_RANGE) {
      return { ok: false, reason: "invalid-tab", tabId: tabId ?? null };
    }
    const allowedTypes = resourceTypes(policy);
    if (details.type && !allowedTypes.includes(details.type)) {
      return { ok: false, reason: "unsupported-resource-type", tabId };
    }
    const allowedMethods = requestMethods(policy);
    const method = String(details.method ?? "GET").toLowerCase();
    if (!allowedMethods.includes(method)) {
      return { ok: false, reason: "unsupported-request-method", tabId };
    }
    if (!isTrustedRequestDomain(details.url, policy)) {
      return { ok: false, reason: "untrusted-request-domain", tabId };
    }
    if (!isTrustedChzzkContext(details, policy)) {
      return { ok: false, reason: "untrusted-initiator", tabId };
    }
    const quality = parseQualityFromUrl(details.url);
    const current = qualityNumber(quality);
    const target = qualityNumber(policy.targetQuality);
    const min = qualityNumber(policy.minRedirectQuality ?? "100p");
    if (!quality || !current || !target || !min) {
      return { ok: false, reason: "unknown-quality-shape", tabId };
    }
    if (current < min) {
      return { ok: false, quality, reason: "quality-below-minimum", tabId };
    }
    if (current >= target) {
      return { ok: false, quality, reason: "target-or-higher-quality", tabId };
    }
    return { ok: true, quality, reason: "eligible-lower-quality-chzzk-hls", tabId };
  }
  function buildScopedSessionRule({ policy, tabId }) {
    return {
      id: sessionRuleIdForTab(tabId, { baseId: policy.sessionRuleBaseId ?? DEFAULT_SESSION_RULE_BASE_ID }),
      priority: policy.redirectRulePriority ?? 1,
      action: {
        type: "redirect",
        redirect: {
          regexSubstitution: `\\1${policy.targetQuality}\\3`,
        },
      },
      condition: {
        regexFilter: buildQualityRegexFilter({
          minRedirectQuality: policy.minRedirectQuality,
          targetQuality: policy.targetQuality,
        }),
        initiatorDomains: trustedInitiatorDomains(policy),
        isUrlFilterCaseSensitive: false,
        requestDomains: trustedRequestDomains(policy),
        requestMethods: requestMethods(policy),
        resourceTypes: resourceTypes(policy),
        tabIds: [tabId],
      },
    };
  }

  // src/shared/telemetry.js
  var TELEMETRY_ENDPOINT = "https://chzzk-report.alpha-apple.dedyn.io/report";
  var TELEMETRY_SCOPE = "chzzk-live";
  var TELEMETRY_SCHEMA_VERSION = 1;
  var MAX_ERROR_TEXT = 300;
  var MAX_URL_TEXT = 500;
  var SENSITIVE_QUERY_RE = /[?#].*$/;
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
  function isTelemetryReportSafe(report) {
    if (!report || report.schemaVersion !== TELEMETRY_SCHEMA_VERSION) return false;
    if (report.scope !== TELEMETRY_SCOPE) return false;
    if (!/^[a-z0-9_.@-]+$/i.test(String(report.addonId ?? ""))) return false;
    if (!/^[a-z0-9_.:-]+$/i.test(String(report.extensionVersion ?? ""))) return false;
    const serialized = JSON.stringify(report);
    if (serialized.length > 64e3) return false;
    if (/[?&](Policy|Signature|Key-Pair-Id|Expires|token|auth|session)=/i.test(serialized)) return false;
    return true;
  }

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

  // src/runtime/background.js
  var api = globalThis.browser ?? globalThis.chrome;
  var STORAGE_KEY = "chzzkDiagnostics";
  var REPORT_STATE_KEY = "chzzkTelemetryReportState";
  var TELEMETRY_MIN_REPORT_INTERVAL_MS = 5 * 60 * 1e3;
  var REPORT_DEDUPE_TTL_MS = 60 * 60 * 1e3;
  var TELEMETRY_POST_TIMEOUT_MS = 2e3;
  var SESSION_RULE_ID_RANGE2 = 1e5;
  var activeRulesByTab = /* @__PURE__ */ new Map();
  var diagnosticsMutationQueue = Promise.resolve();
  function extensionIdentity() {
    const manifest = api.runtime.getManifest();
    return {
      addonId: manifest.browser_specific_settings?.gecko?.id ?? "chzzk@solitude0429.local",
      extensionVersion: manifest.version,
    };
  }
  async function loadSettings() {
    const stored = await api.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(stored?.[SETTINGS_KEY]);
  }
  async function loadDiagnostics() {
    const stored = await api.storage.local.get(STORAGE_KEY);
    return (
      stored?.[STORAGE_KEY] ??
      createEmptyDiagnostics({ maxSamples: quality_policy_default.maxDiagnosticsSamples })
    );
  }
  async function saveDiagnostics(diagnostics) {
    await api.storage.local.set({ [STORAGE_KEY]: diagnostics });
  }
  async function mutateDiagnostics(mutator) {
    const diagnostics = await loadDiagnostics();
    const result = mutator(diagnostics);
    await saveDiagnostics(diagnostics);
    return { diagnostics, result };
  }
  async function enqueueDiagnosticsMutation(mutator) {
    const operation = diagnosticsMutationQueue.then(() => mutateDiagnostics(mutator));
    diagnosticsMutationQueue = operation.catch((error) => {
      console.warn("[CHZZK] diagnostics mutation failed", error);
    });
    return operation;
  }
  async function loadReportState() {
    const stored = await api.storage.local.get(REPORT_STATE_KEY);
    return stored?.[REPORT_STATE_KEY] ?? { lastSentAt: 0, sentByKey: {} };
  }
  async function saveReportState(state) {
    await api.storage.local.set({ [REPORT_STATE_KEY]: state });
  }
  function pruneReportState(state, now = Date.now()) {
    const sentByKey = {};
    for (const [key, sentAt] of Object.entries(state?.sentByKey ?? {})) {
      const timestamp = Number(sentAt);
      if (Number.isFinite(timestamp) && now - timestamp < REPORT_DEDUPE_TTL_MS) {
        sentByKey[key] = timestamp;
      }
    }
    return {
      lastSentAt: Number(state?.lastSentAt ?? 0) || 0,
      sentByKey,
    };
  }
  function telemetryDedupeKey(report) {
    return stableHash({
      diagnostics: report.diagnostics
        ? {
            decisionsByReason: report.diagnostics.decisionsByReason,
            qualities: report.diagnostics.qualities,
            sessionRules: report.diagnostics.sessionRules,
            totalHlsRequests: report.diagnostics.totalHlsRequests,
          }
        : null,
      eventType: report.eventType,
      structureHash: report.structure?.structureHash ?? null,
    });
  }
  async function postTelemetryReport(report, { force = false } = {}) {
    const enriched = {
      ...report,
      ...extensionIdentity(),
      scope: TELEMETRY_SCOPE,
    };
    if (!isTelemetryReportSafe(enriched)) return false;
    const settings = await loadSettings();
    if (!isTelemetryEventEnabled(settings, enriched.eventType)) return false;
    const now = Date.now();
    const state = pruneReportState(await loadReportState(), now);
    const key = telemetryDedupeKey(enriched);
    const previous = Number(state.sentByKey?.[key] ?? 0);
    if (!force && previous && now - previous < REPORT_DEDUPE_TTL_MS) return false;
    if (!force && now - Number(state.lastSentAt ?? 0) < TELEMETRY_MIN_REPORT_INTERVAL_MS) return false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TELEMETRY_POST_TIMEOUT_MS);
    try {
      const response = await fetch(TELEMETRY_ENDPOINT, {
        body: JSON.stringify(enriched),
        cache: "no-store",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`telemetry report failed: HTTP ${response.status}`);
    } finally {
      clearTimeout(timeoutId);
    }
    state.lastSentAt = now;
    state.sentByKey = { ...(state.sentByKey ?? {}), [key]: now };
    await saveReportState(state);
    return true;
  }
  function diagnosticsReportFromSnapshot(snapshot, eventType) {
    return makeTelemetryReport({
      diagnostics: snapshot,
      eventType,
      ...extensionIdentity(),
    });
  }
  async function maybeReportDiagnostics(snapshot, decision) {
    const analysis = analyzeDiagnostics(snapshot, { targetQuality: quality_policy_default.targetQuality });
    const interesting = Boolean(
      analysis.needsPolicyUpdate ||
      snapshot.sessionRules?.lastError ||
      decision?.reason === "unknown-quality-shape" ||
      decision?.ok,
    );
    if (!interesting) return;
    await postTelemetryReport(diagnosticsReportFromSnapshot(snapshot, "diagnostics-summary")).catch(
      (error) => {
        console.warn("[CHZZK] telemetry report failed", error);
      },
    );
  }
  function currentRuleState(lastError = null) {
    return {
      activeRuleIds: [...activeRulesByTab.values()],
      activeTabIds: [...activeRulesByTab.keys()],
      lastError,
    };
  }
  function ownedRuleIdsFromSessionRules(rules) {
    const baseId = quality_policy_default.sessionRuleBaseId ?? 1e5;
    return rules
      .map((rule) => rule.id)
      .filter((id) => Number.isSafeInteger(id) && id >= baseId && id < baseId + SESSION_RULE_ID_RANGE2);
  }
  async function clearOwnedSessionRules() {
    if (!api.declarativeNetRequest?.getSessionRules) return;
    const rules = await api.declarativeNetRequest.getSessionRules();
    const removeRuleIds = ownedRuleIdsFromSessionRules(rules ?? []);
    if (removeRuleIds.length > 0) {
      await api.declarativeNetRequest.updateSessionRules({ removeRuleIds });
    }
    activeRulesByTab.clear();
    await enqueueDiagnosticsMutation((diagnostics) => {
      updateSessionRuleDiagnostics(diagnostics, currentRuleState());
    });
  }
  async function ensureTabSessionRule(tabId) {
    const ruleId = sessionRuleIdForTab(tabId, { baseId: quality_policy_default.sessionRuleBaseId ?? 1e5 });
    if (activeRulesByTab.get(tabId) === ruleId) return;
    const rule = buildScopedSessionRule({ policy: quality_policy_default, tabId });
    await api.declarativeNetRequest.updateSessionRules({
      addRules: [rule],
      removeRuleIds: [ruleId],
    });
    activeRulesByTab.set(tabId, ruleId);
    await enqueueDiagnosticsMutation((diagnostics) => {
      updateSessionRuleDiagnostics(diagnostics, currentRuleState());
    });
  }
  async function reportSessionRuleError(error) {
    const { diagnostics } = await enqueueDiagnosticsMutation((current) => {
      updateSessionRuleDiagnostics(current, currentRuleState(String(error?.message ?? error)));
    });
    await postTelemetryReport(
      diagnosticsReportFromSnapshot(createDiagnosticsSnapshot(diagnostics), "session-rule-error"),
      { force: true },
    ).catch(() => {});
  }
  async function removeTabSessionRule(tabId) {
    if (!Number.isSafeInteger(tabId) || tabId < 0 || tabId >= SESSION_RULE_ID_RANGE2) return;
    const ruleId =
      activeRulesByTab.get(tabId) ??
      sessionRuleIdForTab(tabId, { baseId: quality_policy_default.sessionRuleBaseId ?? 1e5 });
    activeRulesByTab.delete(tabId);
    try {
      await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
      await enqueueDiagnosticsMutation((diagnostics) => {
        updateSessionRuleDiagnostics(diagnostics, currentRuleState());
      });
    } catch (error) {
      await reportSessionRuleError(error);
    }
  }
  async function recordRequestDiagnostics(details, decision) {
    const { diagnostics } = await enqueueDiagnosticsMutation((current) => {
      recordDiagnosticUrl(current, details.url, { context: details });
      recordDecision(current, decision, details);
    });
    await maybeReportDiagnostics(createDiagnosticsSnapshot(diagnostics), decision);
  }
  async function handleRequest(details) {
    const shouldRecord = shouldRecordDiagnostics(details, quality_policy_default);
    const decision = shouldBootstrapSessionRule(details, quality_policy_default);
    if (decision.ok) {
      try {
        await ensureTabSessionRule(decision.tabId);
      } catch (error) {
        await reportSessionRuleError(error);
        console.warn("[CHZZK] failed to install session redirect rule", error);
      }
    }
    if (shouldRecord) {
      recordRequestDiagnostics(details, decision).catch((error) =>
        console.warn("[CHZZK] diagnostics recording/reporting failed", error),
      );
    }
  }
  api.webRequest.onBeforeRequest.addListener(
    (details) => {
      handleRequest(details).catch((error) =>
        console.warn("[CHZZK] diagnostics/session bootstrap failed", error),
      );
    },
    {
      urls: ["*://*.akamaized.net/*", "*://*.navercdn.com/*", "*://*.pstatic.net/*"],
      types: quality_policy_default.resourceTypes,
    },
  );
  api.runtime.onMessage?.addListener((message, sender) => {
    if (message?.type !== "chzzk.telemetry.report" || message?.scope !== TELEMETRY_SCOPE) return false;
    if (sender?.url && !isChzzkLivePageUrl(sender.url)) return false;
    return postTelemetryReport(message.report, {
      force: String(message.report?.eventType ?? "").includes("error"),
    });
  });
  api.tabs?.onRemoved?.addListener((tabId) => {
    removeTabSessionRule(tabId).catch((error) =>
      console.warn("[CHZZK] failed to remove tab session rule", error),
    );
  });
  api.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    if (!activeRulesByTab.has(tabId)) return;
    const nextUrl = changeInfo?.url;
    if (typeof nextUrl !== "string" || isChzzkLivePageUrl(nextUrl)) return;
    removeTabSessionRule(tabId).catch((error) =>
      console.warn("[CHZZK] failed to remove inactive tab session rule", error),
    );
  });
  api.runtime.onInstalled?.addListener(() => {
    clearOwnedSessionRules().catch((error) => console.warn("[CHZZK] startup cleanup failed", error));
  });
  api.runtime.onStartup?.addListener(() => {
    clearOwnedSessionRules().catch((error) => console.warn("[CHZZK] startup cleanup failed", error));
  });
})();
