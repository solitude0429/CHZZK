import { highestQualityCandidate, normalizeQualityCandidates, parseQualityFromUrl, qualityNumber, redactMediaUrl } from "./quality.js";

export function createEmptyDiagnostics({ maxSamples = 200 } = {}) {
  return {
    decisions: [],
    generatedAt: new Date(0).toISOString(),
    maxSamples,
    qualities: {},
    samples: [],
    sessionRules: {
      activeRuleIds: [],
      activeTabIds: [],
      lastError: null,
      updatedAt: new Date(0).toISOString(),
    },
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

export function recordDecision(diagnostics, decision, details = {}, { now = new Date() } = {}) {
  if (!diagnostics || !decision) return false;
  diagnostics.decisions ??= [];
  diagnostics.decisions.push({
    ok: Boolean(decision.ok),
    quality: decision.quality ?? null,
    reason: decision.reason ?? "unknown",
    seenAt: now.toISOString(),
    tabId: decision.tabId ?? details.tabId ?? null,
    targetQuality: decision.targetQuality ?? null,
    type: details.type ?? null,
    url: redactMediaUrl(details.url ?? ""),
  });
  capList(diagnostics.decisions, diagnostics.maxSamples ?? 200);
  diagnostics.generatedAt = now.toISOString();
  return true;
}

export function updateSessionRuleDiagnostics(
  diagnostics,
  { activeRuleIds = [], activeTabIds = [], lastError = null, now = new Date() } = {},
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

export function createDiagnosticsSnapshot(diagnostics) {
  return {
    decisions: [...(diagnostics.decisions ?? [])],
    generatedAt: diagnostics.generatedAt,
    qualities: { ...(diagnostics.qualities ?? {}) },
    samples: [...(diagnostics.samples ?? [])],
    sessionRules: {
      activeRuleIds: [...(diagnostics.sessionRules?.activeRuleIds ?? [])],
      activeTabIds: [...(diagnostics.sessionRules?.activeTabIds ?? [])],
      lastError: diagnostics.sessionRules?.lastError ?? null,
      updatedAt: diagnostics.sessionRules?.updatedAt ?? new Date(0).toISOString(),
    },
    totalHlsRequests: diagnostics.totalHlsRequests ?? 0,
  };
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
