export const QUALITY_LABEL_RE = /^(\d{3,4})p$/i;
export const DEFAULT_QUALITY_CANDIDATES = ["2160p", "1440p", "1080p", "720p", "480p", "360p", "270p", "144p"];

const QUALITY_PATH_MARKER_SOURCE = String.raw`(?:chunklist_|\/)(\d{3,4}p)(?=(?:[_-][^/]*)?\.m3u8$|\/)`;
const RESOLUTION_RE = /(?:RESOLUTION=|^)(\d{3,5})x(\d{3,5})(?:[,\s]|$)/i;
const TEXT_QUALITY_RE = /(?:^|[^0-9])(\d{3,4})\s*p(?:[^0-9]|$)/i;
const MAX_PLAYLIST_FAMILY_PATH_LENGTH = 4096;
const MAX_PLAYLIST_FAMILY_SEGMENTS = 64;
const MAX_HLS_BANDWIDTH = 1_000_000_000;
const MAX_HLS_FRAME_RATE = 240;
const SIGNED_PATH_TAIL_RE = /(?:^|[~;&])(?:[a-z][a-z0-9_-]{0,31})=/i;
const DIAGNOSTIC_DOMAIN_LABELS = [
  "akamaized.net",
  "chzzk.naver.com",
  "gscdn.net",
  "navercdn.com",
  "pstatic.net",
];

export function normalizeQualityLabel(value) {
  if (typeof value !== "string") return null;

  const resolutionMatch = value.match(RESOLUTION_RE);
  if (resolutionMatch) return `${Number(resolutionMatch[2])}p`;

  const qualityMatch = value.match(TEXT_QUALITY_RE);
  if (!qualityMatch) return null;

  return `${Number(qualityMatch[1])}p`;
}

export function qualityNumber(label) {
  const normalized = normalizeQualityLabel(label);
  if (!normalized) return null;
  const match = normalized.match(QUALITY_LABEL_RE);
  return match ? Number(match[1]) : null;
}

export function parseQualitiesFromUrl(url) {
  if (typeof url !== "string") return [];
  let pathname = url;

  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split("?")[0].split("#")[0];
  }

  return [...pathname.matchAll(new RegExp(QUALITY_PATH_MARKER_SOURCE, "gi"))]
    .map((match) => normalizeQualityLabel(match[1]))
    .filter(Boolean);
}

export function parseQualityFromUrl(url) {
  return parseQualitiesFromUrl(url)[0] ?? null;
}

export function urlQualityMarkersAreSafe(url) {
  const qualities = parseQualitiesFromUrl(url);
  if (qualities.length <= 1) return true;
  if (qualities.every((quality) => quality === qualities[0])) return true;

  // CHZZK has emitted this exact legacy shape: a 360p rendition directory
  // containing a chunklist_480p filename. Both markers are rewritten together.
  return qualities.length === 2 && qualities[0] === "360p" && qualities[1] === "480p";
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function stripSignedPathTail(segment) {
  const decoded = decodePathSegment(segment);
  const match = SIGNED_PATH_TAIL_RE.exec(decoded);
  if (!match) return { prefix: segment, signed: false };
  const prefix = decoded.slice(0, match.index).replace(/[~;&]+$/, "");
  return { prefix: prefix ? encodeURIComponent(prefix) : "", signed: true };
}

function playlistNameDiscriminator(segment) {
  const { prefix } = stripSignedPathTail(segment);
  const decoded = decodePathSegment(prefix);
  if (!/\.m3u8$/i.test(decoded)) return null;

  let stem = decoded.slice(0, -".m3u8".length);
  stem = stem.replace(/(^|[_-])\d{3,4}p(?=$|[_-])/gi, "$1{quality}");
  stem = stem.replace(/^(?:chunklist(?:_\{quality\})?|index|manifest|master|media|playlist)(?:[_-]+|$)/i, "");
  stem = stem.replace(/\{quality\}/gi, "").replace(/^[-_.]+|[-_.]+$/g, "");
  return stem ? encodeURIComponent(stem) : "";
}

export function playlistFamilyKey(url) {
  if (typeof url !== "string" || url === "") return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname) return null;
    if (parsed.pathname.length > MAX_PLAYLIST_FAMILY_PATH_LENGTH) return null;

    const rawSegments = parsed.pathname.split("/").filter(Boolean);
    if (rawSegments.length > MAX_PLAYLIST_FAMILY_SEGMENTS) return null;

    const playlistIndex = rawSegments.findIndex((segment) => {
      const { prefix } = stripSignedPathTail(segment);
      return /\.m3u8$/i.test(decodePathSegment(prefix));
    });
    if (playlistIndex === -1) return null;
    const discriminator = playlistNameDiscriminator(rawSegments[playlistIndex]);
    if (discriminator === null) return null;

    const directorySegments = rawSegments.slice(0, playlistIndex);
    const familySegments = [];
    let removedRenditionMarker = false;
    for (const segment of directorySegments) {
      const { prefix, signed } = stripSignedPathTail(segment);
      const decoded = decodePathSegment(prefix);
      if (prefix === "" && signed) break;
      if (/^\d{3,4}p$/i.test(decoded)) {
        removedRenditionMarker = true;
        continue;
      }
      if (removedRenditionMarker && /^(?:media|playlist|playlists|segment|segments)$/i.test(decoded)) {
        continue;
      }
      familySegments.push(prefix);
      if (signed) break;
    }

    return JSON.stringify([
      `${parsed.protocol}//${parsed.host.toLowerCase()}`,
      familySegments,
      discriminator,
    ]);
  } catch {
    return null;
  }
}

export function redactMediaUrl(url) {
  if (typeof url !== "string" || url === "") return "";

  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return "[redacted-url]";
    const quality = parseQualityFromUrl(url);
    const isPlaylist = /\.m3u8$/i.test(parsed.pathname);
    const mediaShape = isPlaylist ? `/${quality ?? "playlist"}.m3u8` : quality ? `/${quality}` : "";
    const hadSensitiveTail = Boolean(parsed.search || parsed.hash);
    const hostname = parsed.hostname.toLowerCase();
    const domainLabel =
      DIAGNOSTIC_DOMAIN_LABELS.find((domain) => hostname === domain || hostname.endsWith(`.${domain}`)) ??
      "other-media.invalid";
    return `${parsed.protocol}//${domainLabel}/[redacted-path]${mediaShape}${hadSensitiveTail ? "?[redacted]" : ""}`;
  } catch {
    return "[redacted-url]";
  }
}

export function normalizeQualityCandidates(
  candidates = DEFAULT_QUALITY_CANDIDATES,
  { include = [], minRedirectQuality = "100p" } = {},
) {
  const min = qualityNumber(minRedirectQuality) ?? 0;
  const labels = [...(Array.isArray(candidates) ? candidates : []), ...include]
    .map((candidate) => normalizeQualityLabel(candidate))
    .filter(Boolean);

  return [...new Set(labels)]
    .map((label) => ({ label, value: qualityNumber(label) }))
    .filter((entry) => entry.value && entry.value >= min)
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.label);
}

export function highestQualityCandidate(candidates, options = {}) {
  return normalizeQualityCandidates(candidates, options)[0] ?? null;
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

export function lowerQualityNumberRegex(targetQuality, minQuality = "100p") {
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

export function buildQualityRegexFilter({ targetQuality, minRedirectQuality = "100p" }) {
  const lowerPattern = lowerQualityNumberRegex(targetQuality, minRedirectQuality);
  return `(.*(?:chunklist_|/))(${lowerPattern}p)(.*\\.m3u8.*)`;
}

export function replaceQualityInUrl(url, targetQuality) {
  const normalizedTarget = normalizeQualityLabel(targetQuality);
  const target = qualityNumber(normalizedTarget);
  const currentQuality = parseQualityFromUrl(url);
  if (
    typeof url !== "string" ||
    !normalizedTarget ||
    !target ||
    !currentQuality ||
    !urlQualityMarkersAreSafe(url)
  ) {
    return null;
  }

  const urlParts = url.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)([?#][\s\S]*)?$/i);
  if (!urlParts) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }

  let replacedAny = false;
  const replacedPath = urlParts[2].replace(new RegExp(QUALITY_PATH_MARKER_SOURCE, "gi"), (match, quality) => {
    const current = qualityNumber(quality);
    if (!current || current >= target) return match;
    replacedAny = true;
    return match.replace(quality, normalizedTarget);
  });

  if (!replacedAny) return null;
  const replacedUrl = `${urlParts[1]}${replacedPath}${urlParts[3] ?? ""}`;
  return urlQualityMarkersAreSafe(replacedUrl) ? replacedUrl : null;
}

function splitHlsAttributeList(value) {
  const result = [];
  let current = "";
  let quoted = false;
  for (const char of String(value ?? "")) {
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      result.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quoted) return null;
  if (current) result.push(current);
  return result;
}

function parseHlsAttributeList(value) {
  const entries = splitHlsAttributeList(value);
  if (!entries) return null;

  const attributes = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) return null;
    const key = entry.slice(0, separator).trim().toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(key) || Object.hasOwn(attributes, key)) return null;

    let rawValue = entry.slice(separator + 1).trim();
    if (rawValue.startsWith('"')) {
      if (rawValue.length < 2 || !rawValue.endsWith('"')) return null;
      rawValue = rawValue.slice(1, -1);
    } else if (rawValue.includes('"')) {
      return null;
    }
    attributes[key] = rawValue;
  }
  return attributes;
}

function boundedPositiveDecimalInteger(value, max) {
  if (value == null) return { valid: true, value: null };
  if (typeof value !== "string" || !/^\d+$/.test(value)) return { valid: false, value: null };
  const number = Number(value);
  return {
    valid: Number.isSafeInteger(number) && number > 0 && number <= max,
    value: number,
  };
}

function boundedPositiveDecimal(value, max) {
  if (value == null) return { valid: true, value: null };
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    return { valid: false, value: null };
  }
  const number = Number(value);
  return {
    valid: Number.isFinite(number) && number > 0 && number <= max,
    value: number,
  };
}

function parseResolutionAttribute(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) return null;
  return { height: Number(match[2]), width: Number(match[1]) };
}

export function parseHlsMasterPlaylistVariants(playlistText, baseUrl = "") {
  const lines = String(playlistText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.toUpperCase().startsWith("#EXT-X-STREAM-INF:")) continue;

    const attributes = parseHlsAttributeList(line.slice(line.indexOf(":") + 1));
    if (!attributes) continue;
    const averageBandwidth = boundedPositiveDecimalInteger(
      attributes["AVERAGE-BANDWIDTH"],
      MAX_HLS_BANDWIDTH,
    );
    const bandwidth = boundedPositiveDecimalInteger(attributes.BANDWIDTH, MAX_HLS_BANDWIDTH);
    const frameRate = boundedPositiveDecimal(attributes["FRAME-RATE"], MAX_HLS_FRAME_RATE);
    if (!averageBandwidth.valid || !bandwidth.valid || bandwidth.value === null || !frameRate.valid) {
      continue;
    }
    let uriIndex = index + 1;
    while (uriIndex < lines.length && !lines[uriIndex]) uriIndex += 1;
    const nextUri = lines[uriIndex];
    if (!nextUri || nextUri.startsWith("#")) continue;

    const resolution = parseResolutionAttribute(attributes.RESOLUTION);
    let url = nextUri;
    try {
      url = new URL(nextUri, baseUrl).toString();
    } catch {
      url = nextUri;
    }

    const quality = resolution ? normalizeQualityLabel(attributes.RESOLUTION) : parseQualityFromUrl(url);
    variants.push({
      averageBandwidth: averageBandwidth.value,
      bandwidth: bandwidth.value,
      frameRate: frameRate.value,
      quality,
      resolution,
      url,
    });
  }

  return variants;
}

function variantScore(variant) {
  const height = variant?.resolution?.height ?? qualityNumber(variant?.quality) ?? 0;
  return {
    bitrate: variant?.averageBandwidth ?? variant?.bandwidth ?? 0,
    frameRate: variant?.frameRate ?? 0,
    height,
    peakBandwidth: variant?.bandwidth ?? 0,
  };
}

export function chooseBestHlsVariant(
  playlistText,
  baseUrl = "",
  { excludedQualities = [], minRedirectQuality = "100p" } = {},
) {
  const min = qualityNumber(minRedirectQuality) ?? 0;
  const excluded = new Set(
    (Array.isArray(excludedQualities) ? excludedQualities : []).map(normalizeQualityLabel).filter(Boolean),
  );
  return (
    parseHlsMasterPlaylistVariants(playlistText, baseUrl)
      .filter((variant) => (variantScore(variant).height || 0) >= min)
      .filter((variant) => {
        const quality =
          normalizeQualityLabel(variant?.quality) ??
          (variant?.resolution?.height ? `${variant.resolution.height}p` : null);
        return !quality || !excluded.has(quality);
      })
      .map((variant, index) => ({ index, score: variantScore(variant), variant }))
      .sort(
        (left, right) =>
          right.score.height - left.score.height ||
          right.score.frameRate - left.score.frameRate ||
          right.score.bitrate - left.score.bitrate ||
          right.score.peakBandwidth - left.score.peakBandwidth ||
          left.index - right.index,
      )[0]?.variant ?? null
  );
}

export function buildHighestQualityRedirectUrl(url, { targetQuality, minRedirectQuality = "100p" } = {}) {
  const currentQuality = qualityNumber(parseQualityFromUrl(url));
  const target = qualityNumber(targetQuality);
  const min = qualityNumber(minRedirectQuality);
  if (!currentQuality || !target || !min || currentQuality < min || currentQuality >= target) return null;

  return replaceQualityInUrl(url, targetQuality);
}
