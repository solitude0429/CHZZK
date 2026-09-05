import {
  highestQualityCandidate,
  normalizeQualityCandidates,
  normalizeQualityLabel,
  parseQualityFromUrl,
  qualityNumber,
  redactMediaUrl,
} from "./quality.js";

const EPOCH_ISO = new Date(0).toISOString();
const HARD_MAX_DIAGNOSTIC_SAMPLES = 1000;
const MAX_DIAGNOSTIC_QUALITY_KEYS = 64;
const MAX_DIAGNOSTIC_REASON_LENGTH = 64;
const MAX_DIAGNOSTIC_TYPE_LENGTH = 32;
const MAX_DIAGNOSTIC_URL_INPUT_LENGTH = 4096;
const RUNTIME_TRANSITION_ACTIONS = new Set(["blocked", "ignored", "invalidated", "selected"]);
const RUNTIME_TRANSITION_REASONS = new Set([
  "client-cancelled",
  "higher-quality",
  "initial-selection",
  "lower-quality",
  "master-authority",
  "network-error",
  "response-body",
  "response-status",
]);
const RUNTIME_TRANSITION_SOURCES = new Set([
  "master-probe",
  "master-response",
  "numeric-probe",
  "redirect-response",
]);

function normalizedMaxSamples(value, fallback = 200) {
  const normalizedFallback =
    Number.isSafeInteger(fallback) && fallback > 0
      ? Math.min(fallback, HARD_MAX_DIAGNOSTIC_SAMPLES)
      : 200;
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, normalizedFallback)
    : normalizedFallback;
}

function normalizedCounter(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function incrementCounter(value) {
  const normalized = normalizedCounter(value);
  return normalized >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : normalized + 1;
}

function normalizedQuality(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^\d{3,4}p$/i.test(value)) return undefined;
  return normalizeQualityLabel(value) ?? undefined;
}

function normalizedIsoTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return EPOCH_ISO;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : EPOCH_ISO;
}

function normalizedTabId(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizedType(value) {
  if (value === null) return null;
  return typeof value === "string" && value.length <= MAX_DIAGNOSTIC_TYPE_LENGTH
    ? value
    : undefined;
}

function normalizedDiagnosticUrl(value) {
  if (typeof value !== "string" || value.length > MAX_DIAGNOSTIC_URL_INPUT_LENGTH) return undefined;
  return redactMediaUrl(value);
}

function normalizedRuntimeError(value) {
  return typeof value === "string" && value.length > 0 ? "runtime-error" : null;
}

function normalizeSample(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const quality = normalizedQuality(value.quality);
  const type = normalizedType(value.type);
  const url = normalizedDiagnosticUrl(value.url);
  if (!quality || type === undefined || url === undefined) return null;
  const seenAt = normalizedIsoTimestamp(value.seenAt);
  if (seenAt === EPOCH_ISO && value.seenAt !== EPOCH_ISO) return null;
  return { quality, seenAt, type, url };
}

function normalizeDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const quality = normalizedQuality(value.quality, { nullable: true });
  const targetQuality = normalizedQuality(value.targetQuality, { nullable: true });
  const type = normalizedType(value.type);
  const url = normalizedDiagnosticUrl(value.url);
  const seenAt = normalizedIsoTimestamp(value.seenAt);
  if (
    typeof value.ok !== "boolean" ||
    typeof value.redirectedCurrentRequest !== "boolean" ||
    quality === undefined ||
    targetQuality === undefined ||
    type === undefined ||
    url === undefined ||
    seenAt === EPOCH_ISO && value.seenAt !== EPOCH_ISO ||
    typeof value.reason !== "string" ||
    value.reason.length === 0 ||
    value.reason.length > MAX_DIAGNOSTIC_REASON_LENGTH
  ) {
    return null;
  }
  return {
    ok: value.ok,
    quality,
    reason: value.reason,
    redirectedCurrentRequest: value.redirectedCurrentRequest,
    seenAt,
    targetQuality,
    type,
    url,
  };
}

function normalizeRuntimeTransition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fromQuality = normalizedQuality(value.fromQuality, { nullable: true });
  const toQuality = normalizedQuality(value.toQuality, { nullable: true });
  const seenAt = normalizedIsoTimestamp(value.seenAt);
  if (
    !RUNTIME_TRANSITION_ACTIONS.has(value.action) ||
    fromQuality === undefined ||
    toQuality === undefined ||
    !RUNTIME_TRANSITION_REASONS.has(value.reason) ||
    seenAt === EPOCH_ISO && value.seenAt !== EPOCH_ISO ||
    !RUNTIME_TRANSITION_SOURCES.has(value.source)
  ) {
    return null;
  }
  return {
    action: value.action,
    fromQuality,
    reason: value.reason,
    seenAt,
    source: value.source,
    toQuality,
  };
}

function normalizeQualityCounters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const counters = {};
  for (const [rawQuality, rawCount] of Object.entries(value)) {
    if (Object.keys(counters).length >= MAX_DIAGNOSTIC_QUALITY_KEYS) break;
    const quality = normalizedQuality(rawQuality);
    if (!quality || normalizedCounter(rawCount) !== rawCount) continue;
    counters[quality] = rawCount;
  }
  return counters;
}

function normalizeActiveTabIds(value, maxSamples) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tabId) => normalizedTabId(tabId) !== undefined))]
    .sort((left, right) => left - right)
    .slice(-maxSamples);
}

function normalizeTargetsByTab(value, maxSamples) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([tabId, quality]) => {
        const parsedTabId = Number(tabId);
        return String(parsedTabId) === tabId && normalizedTabId(parsedTabId) !== undefined && normalizedQuality(quality);
      })
      .sort(([left], [right]) => Number(left) - Number(right))
      .slice(-maxSamples)
      .map(([tabId, quality]) => [tabId, normalizedQuality(quality)]),
  );
}

function normalizeTargetQualities(value, maxSamples) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxSamples)
    .map((quality) => normalizedQuality(quality))
    .filter(Boolean)
    .sort((left, right) => qualityNumber(right) - qualityNumber(left));
}

function normalizeRuntimeRedirectSummary(value, maxSamples) {
  // Older snapshots used browser tab IDs. Read them once as aggregates and
  // never copy their keys or identifiers into the new persisted/exported schema.
  const activeTabCount = Object.hasOwn(value, "activeTabCount")
    ? Math.min(normalizedCounter(value.activeTabCount), maxSamples)
    : normalizeActiveTabIds(value.activeTabIds, maxSamples).length;
  const targetQualities = normalizeTargetQualities(
    Object.hasOwn(value, "targetQualities")
      ? value.targetQualities
      : Object.values(normalizeTargetsByTab(value.targetsByTab, maxSamples)),
    maxSamples,
  );
  return {
    activeTabCount,
    lastError: normalizedRuntimeError(value.lastError),
    targetQualities,
    updatedAt: normalizedIsoTimestamp(value.updatedAt),
  };
}

export function normalizeDiagnostics(value, { maxSamples = 200 } = {}) {
  const policyMaxSamples = normalizedMaxSamples(maxSamples, HARD_MAX_DIAGNOSTIC_SAMPLES);
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const effectiveMaxSamples = normalizedMaxSamples(source.maxSamples, policyMaxSamples);
  const runtimeSource =
    source.runtimeRedirects &&
    typeof source.runtimeRedirects === "object" &&
    !Array.isArray(source.runtimeRedirects)
      ? source.runtimeRedirects
      : {};

  return {
    decisions: (Array.isArray(source.decisions)
      ? source.decisions.slice(-effectiveMaxSamples)
      : []
    )
      .map(normalizeDecision)
      .filter(Boolean),
    generatedAt: normalizedIsoTimestamp(source.generatedAt),
    maxSamples: effectiveMaxSamples,
    qualities: normalizeQualityCounters(source.qualities),
    runtimeRedirects: normalizeRuntimeRedirectSummary(runtimeSource, effectiveMaxSamples),
    runtimeTransitions: (Array.isArray(source.runtimeTransitions)
      ? source.runtimeTransitions.slice(-effectiveMaxSamples)
      : []
    )
      .map(normalizeRuntimeTransition)
      .filter(Boolean),
    samples: (Array.isArray(source.samples) ? source.samples.slice(-effectiveMaxSamples) : [])
      .map(normalizeSample)
      .filter(Boolean),
    totalHlsRequests: normalizedCounter(source.totalHlsRequests),
  };
}

export function createEmptyDiagnostics({ maxSamples = 200 } = {}) {
  return {
    decisions: [],
    generatedAt: EPOCH_ISO,
    maxSamples: normalizedMaxSamples(maxSamples, HARD_MAX_DIAGNOSTIC_SAMPLES),
    qualities: {},
    runtimeRedirects: {
      activeTabCount: 0,
      lastError: null,
      targetQualities: [],
      updatedAt: EPOCH_ISO,
    },
    runtimeTransitions: [],
    samples: [],
    totalHlsRequests: 0,
  };
}

function capList(list, maxItems) {
  if (list.length > maxItems) {
    list.splice(0, list.length - maxItems);
  }
}

export function recordDiagnosticUrl(diagnostics, url, { context = {}, now = new Date() } = {}) {
  if (!diagnostics || typeof url !== "string" || !/\.m3u8(?:[?#]|$)/i.test(url)) return false;

  const quality = parseQualityFromUrl(url);
  if (!quality) return false;
  const sample = normalizeSample({
    quality,
    seenAt: now.toISOString(),
    type: context.type ?? null,
    url,
  });
  if (!sample) return false;

  diagnostics.totalHlsRequests = incrementCounter(diagnostics.totalHlsRequests);
  if (!diagnostics.qualities || typeof diagnostics.qualities !== "object" || Array.isArray(diagnostics.qualities)) {
    diagnostics.qualities = {};
  }
  diagnostics.qualities[quality] = incrementCounter(diagnostics.qualities[quality]);
  if (!Array.isArray(diagnostics.samples)) diagnostics.samples = [];
  diagnostics.samples.push(sample);

  capList(diagnostics.samples, normalizedMaxSamples(diagnostics.maxSamples, HARD_MAX_DIAGNOSTIC_SAMPLES));
  diagnostics.generatedAt = now.toISOString();
  return true;
}

export function recordDecision(diagnostics, decision, details = {}, { now = new Date() } = {}) {
  if (!diagnostics || !decision) return false;
  if (!Array.isArray(diagnostics.decisions)) diagnostics.decisions = [];
  const entry = normalizeDecision({
    ok: Boolean(decision.ok),
    quality: decision.quality ?? null,
    reason: decision.reason ?? "unknown",
    redirectedCurrentRequest: Boolean(decision.redirectedCurrentRequest),
    seenAt: now.toISOString(),
    targetQuality: decision.targetQuality ?? null,
    type: details.type ?? null,
    url: details.url ?? "",
  });
  if (!entry) return false;
  diagnostics.decisions.push(entry);
  capList(diagnostics.decisions, normalizedMaxSamples(diagnostics.maxSamples, HARD_MAX_DIAGNOSTIC_SAMPLES));
  diagnostics.generatedAt = now.toISOString();
  return true;
}

export function recordRuntimeTransition(
  diagnostics,
  transition,
  { now = new Date() } = {},
) {
  if (!diagnostics || !transition) return false;
  if (!Array.isArray(diagnostics.runtimeTransitions)) diagnostics.runtimeTransitions = [];
  const entry = normalizeRuntimeTransition({
    ...transition,
    seenAt: now.toISOString(),
  });
  if (!entry) return false;
  diagnostics.runtimeTransitions.push(entry);
  capList(
    diagnostics.runtimeTransitions,
    normalizedMaxSamples(diagnostics.maxSamples, HARD_MAX_DIAGNOSTIC_SAMPLES),
  );
  diagnostics.generatedAt = now.toISOString();
  return true;
}

export function updateRuntimeRedirectDiagnostics(
  diagnostics,
  { activeTabIds = [], lastError = null, now = new Date(), targetsByTab = {} } = {},
) {
  if (!diagnostics) return false;
  const maxSamples = normalizedMaxSamples(diagnostics.maxSamples, HARD_MAX_DIAGNOSTIC_SAMPLES);
  diagnostics.runtimeRedirects = normalizeRuntimeRedirectSummary(
    { activeTabIds, lastError, targetsByTab, updatedAt: now.toISOString() },
    maxSamples,
  );
  diagnostics.generatedAt = now.toISOString();
  return true;
}

export function createDiagnosticsSnapshot(diagnostics) {
  return normalizeDiagnostics(diagnostics, {
    maxSamples: normalizedMaxSamples(diagnostics?.maxSamples, HARD_MAX_DIAGNOSTIC_SAMPLES),
  });
}

export function analyzeDiagnostics(snapshot, { qualityCandidates = [] } = {}) {
  const qualities = Object.keys(snapshot?.qualities ?? {});
  const observedQualities = qualities.sort((a, b) => (qualityNumber(a) ?? 0) - (qualityNumber(b) ?? 0));
  const highestObservedQuality =
    observedQualities
      .map((quality) => ({ label: quality, value: qualityNumber(quality) }))
      .filter((entry) => entry.value != null)
      .sort((a, b) => b.value - a.value)[0]?.label ?? null;

  const configuredCandidates = normalizeQualityCandidates(qualityCandidates, {
    include: highestObservedQuality ? [] : [],
  });
  const highestConfiguredQuality = highestQualityCandidate(configuredCandidates);
  const highestObservedNumber = qualityNumber(highestObservedQuality);
  const highestConfiguredNumber = qualityNumber(highestConfiguredQuality);
  const needsPolicyUpdate = Boolean(
    highestObservedNumber &&
      (!highestConfiguredNumber || highestObservedNumber > highestConfiguredNumber),
  );
  const suggestedQualityCandidates = needsPolicyUpdate
    ? normalizeQualityCandidates(configuredCandidates, { include: [highestObservedQuality] })
    : configuredCandidates;

  return {
    highestConfiguredQuality,
    highestObservedQuality,
    needsPolicyUpdate,
    observedQualities,
    suggestedQualityCandidates,
  };
}
