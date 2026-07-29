import { isUsableHlsPlaylist, isUtf8TextWithinByteLimit } from "../shared/playlist-evidence.js";
import { isDedicatedChzzkHlsPlaylistUrl, isTrustedRequestDomain } from "../shared/request-policy.js";
import {
  chooseBestHlsVariantFromVariants,
  normalizeQualityCandidates,
  parseHlsMasterPlaylistVariants,
  parseQualitiesFromUrl,
  parseQualityFromUrl,
  playlistFamilyKey,
  qualityNumber,
  replaceQualityInUrl,
  urlQualityMarkersAreSafe,
} from "../shared/quality.js";

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) ?? null;
}

function responseContentLength(response) {
  const value = Number(responseHeader(response, "content-length") ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function hasRejectedPlaylistContentType(response) {
  const contentType = String(responseHeader(response, "content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return (
    contentType === "application/json" ||
    contentType === "application/xhtml+xml" ||
    contentType === "text/html" ||
    contentType === "text/json" ||
    contentType.endsWith("+json")
  );
}

async function readResponseTextWithLimit(response, maxBytes) {
  const declaredLength = responseContentLength(response);
  if (declaredLength > maxBytes) return null;

  if (!response?.body?.getReader) {
    const text = String(await response.text());
    return isUtf8TextWithinByteLimit(text, maxBytes) ? text : null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;
  try {
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (done) break;
      const { value } = chunk;
      totalBytes += value.byteLength ?? value.length ?? 0;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch {
    return null;
  }
}

function bestVariantTargetQuality(variant) {
  return variant?.quality ?? (variant?.resolution?.height ? `${variant.resolution.height}p` : null);
}

export function networkRequestUrl(url) {
  if (typeof url !== "string" || !url) return null;
  const fragmentIndex = url.indexOf("#");
  return fragmentIndex < 0 ? url : url.slice(0, fragmentIndex);
}

export function createPlaylistProbe({
  clearTimeoutImpl = clearTimeout,
  fetchImpl = (...args) => globalThis.fetch(...args),
  policy,
  setTimeoutImpl = setTimeout,
} = {}) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("Playlist probe policy must be an object");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("Playlist probe fetch must be a function");
  if (typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
    throw new TypeError("Playlist probe timers must be functions");
  }

  const probeMaxBytes = positiveNumber(policy.probeMaxBytes, 256_000);
  const probeTimeoutMs = positiveNumber(policy.probeTimeoutMs, 1500);

  function urlQualityMarkersMatch(url, expectedQuality) {
    const qualities = parseQualitiesFromUrl(url);
    return (
      qualities.length > 0 && urlQualityMarkersAreSafe(url) && parseQualityFromUrl(url) === expectedQuality
    );
  }

  async function fetchPlaylistEvidence(url, { signal = null } = {}) {
    if (!isTrustedRequestDomain(url, policy)) return null;
    const requestedNetworkUrl = networkRequestUrl(url);
    if (!requestedNetworkUrl) return null;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener?.("abort", abortFromParent, { once: true });
    const timeout = setTimeoutImpl(() => controller.abort(), probeTimeoutMs);

    try {
      const response = await fetchImpl(url, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || hasRejectedPlaylistContentType(response)) return null;
      const responseUrl =
        typeof response?.url === "string" && response.url ? response.url : requestedNetworkUrl;
      const finalUrl = networkRequestUrl(responseUrl);
      if (!finalUrl || !isTrustedRequestDomain(finalUrl, policy) || finalUrl !== requestedNetworkUrl) {
        return null;
      }
      const text = await readResponseTextWithLimit(response, probeMaxBytes);
      return isUsableHlsPlaylist(text) ? { finalUrl, text } : null;
    } catch {
      return null;
    } finally {
      clearTimeoutImpl(timeout);
      signal?.removeEventListener?.("abort", abortFromParent);
    }
  }

  function playlistEvidenceSupportsExpectedQuality(evidence, expectedQuality) {
    if (!evidence || !isUsableHlsPlaylist(evidence.text)) return false;
    const variants = parseHlsMasterPlaylistVariants(evidence.text, evidence.finalUrl);
    if (variants.length > 0 || /#EXT-X-STREAM-INF:/i.test(evidence.text)) {
      return variants.some((variant) => {
        const variantQuality = bestVariantTargetQuality(variant);
        return (
          variantQuality === expectedQuality &&
          typeof variant.url === "string" &&
          isTrustedRequestDomain(variant.url, policy) &&
          urlQualityMarkersMatch(variant.url, expectedQuality)
        );
      });
    }

    return urlQualityMarkersMatch(evidence.finalUrl, expectedQuality);
  }

  async function fetchSupportsExpectedQuality(url, expectedQuality, { signal = null } = {}) {
    const evidence = await fetchPlaylistEvidence(url, { signal });
    return playlistEvidenceSupportsExpectedQuality(evidence, expectedQuality);
  }

  async function resolveHighestSupportedQuality(
    details,
    observedQuality,
    { maximumTargetQuality = null, signal = null, skipTargetQualities = new Set() } = {},
  ) {
    const observedNumber = qualityNumber(observedQuality);
    const maximumTargetNumber = maximumTargetQuality == null ? null : qualityNumber(maximumTargetQuality);
    if (!observedNumber || (maximumTargetQuality != null && !maximumTargetNumber)) return null;

    const candidates = normalizeQualityCandidates(policy.qualityCandidates, {
      include: [observedQuality, maximumTargetQuality],
      minRedirectQuality: policy.minRedirectQuality,
    });

    const attempts = candidates.flatMap((candidate) => {
      if (skipTargetQualities.has(candidate)) return [];
      const candidateNumber = qualityNumber(candidate);
      if (
        !candidateNumber ||
        candidateNumber <= observedNumber ||
        (maximumTargetNumber && candidateNumber > maximumTargetNumber)
      ) {
        return [];
      }
      const candidateUrl = replaceQualityInUrl(details.url, candidate);
      return candidateUrl ? [{ candidate, candidateUrl }] : [];
    });
    const batchController = new AbortController();
    const abortBatch = () => batchController.abort();
    if (signal?.aborted) return null;
    signal?.addEventListener?.("abort", abortBatch, { once: true });

    try {
      const probes = attempts.map(async ({ candidate, candidateUrl }) => ({
        candidate,
        candidateUrl,
        supported: await fetchSupportsExpectedQuality(candidateUrl, candidate, {
          signal: batchController.signal,
        }),
      }));

      // Every eligible tier starts together, but results are consumed in
      // descending order so a fast lower response cannot beat a slower valid
      // higher response. One timed-out tier therefore cannot consume the
      // whole family budget before 1080p gets a chance.
      for (const probe of probes) {
        const result = await probe;
        if (signal?.aborted) return null;
        if (!result.supported) continue;
        batchController.abort();
        return {
          evidenceKind: "url-marker",
          targetQuality: result.candidate,
          validatedNetworkUrl: networkRequestUrl(result.candidateUrl),
        };
      }
    } finally {
      batchController.abort();
      signal?.removeEventListener?.("abort", abortBatch);
    }

    return signal?.aborted ||
      skipTargetQualities.has(observedQuality) ||
      (maximumTargetNumber && observedNumber > maximumTargetNumber)
      ? null
      : { evidenceKind: "url-marker", targetQuality: observedQuality };
  }

  async function resolveBestVariantFromMaster(
    details,
    { signal = null, skipTargetQualities = new Set() } = {},
  ) {
    const evidence = await fetchPlaylistEvidence(details.url, { signal });
    if (!evidence || signal?.aborted) return null;
    return resolveBestVariantFromEvidence(evidence, { skipTargetQualities });
  }

  function resolveBestVariantFromEvidence(
    evidence,
    { requiredFamilyKey = null, skipTargetQualities = new Set() } = {},
  ) {
    if (
      !evidence ||
      !isUsableHlsPlaylist(evidence.text) ||
      !isTrustedRequestDomain(evidence.finalUrl, policy)
    ) {
      return null;
    }
    const eligibleVariants = parseHlsMasterPlaylistVariants(evidence.text, evidence.finalUrl).filter(
      (candidate) => {
        const candidateQuality = bestVariantTargetQuality(candidate);
        return Boolean(
          candidateQuality &&
          typeof candidate?.url === "string" &&
          isTrustedRequestDomain(candidate.url, policy) &&
          (!requiredFamilyKey || playlistFamilyKey(candidate.url) === requiredFamilyKey) &&
          urlQualityMarkersMatch(candidate.url, candidateQuality),
        );
      },
    );
    const variant = chooseBestHlsVariantFromVariants(eligibleVariants, {
      excludedQualities: [...skipTargetQualities],
      minRedirectQuality: policy.minRedirectQuality,
    });
    const targetQuality = bestVariantTargetQuality(variant);
    const targetFamilyKey = playlistFamilyKey(variant?.url);
    return variant?.url && targetQuality && targetFamilyKey
      ? {
          evidenceKind: "master",
          targetDedicatedHls: isDedicatedChzzkHlsPlaylistUrl(variant.url, policy),
          targetFamilyKey,
          targetQuality,
        }
      : null;
  }

  return Object.freeze({
    fetchPlaylistEvidence,
    playlistEvidenceSupportsExpectedQuality,
    probeMaxBytes: () => probeMaxBytes,
    resolveBestVariantFromEvidence,
    resolveBestVariantFromMaster,
    resolveHighestSupportedQuality,
    urlQualityMarkersMatch,
  });
}
