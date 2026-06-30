import { parseQualityFromUrl, qualityNumber, redactMediaUrl } from "./quality.js";

export function createEmptyDiagnostics({ maxSamples = 200 } = {}) {
  return {
    generatedAt: new Date(0).toISOString(),
    maxSamples,
    qualities: {},
    samples: [],
    totalHlsRequests: 0,
  };
}

export function recordDiagnosticUrl(diagnostics, url, { now = new Date() } = {}) {
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
    url: redactMediaUrl(url),
  });

  const maxSamples = diagnostics.maxSamples ?? 200;
  if (diagnostics.samples.length > maxSamples) {
    diagnostics.samples.splice(0, diagnostics.samples.length - maxSamples);
  }

  diagnostics.generatedAt = now.toISOString();
  return true;
}

export function createDiagnosticsSnapshot(diagnostics) {
  return {
    generatedAt: diagnostics.generatedAt,
    qualities: { ...(diagnostics.qualities ?? {}) },
    samples: [...(diagnostics.samples ?? [])],
    totalHlsRequests: diagnostics.totalHlsRequests ?? 0,
  };
}

export function analyzeDiagnostics(snapshot, { targetQuality = "1080p" } = {}) {
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
