export const QUALITY_LABEL_RE = /^(\d{3,4})p$/i;
export const DEFAULT_QUALITY_CANDIDATES = [
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "360p",
  "270p",
  "144p",
];

const QUALITY_PATH_MARKER_SOURCE = String.raw`(?:chunklist_|\/)(\d{3,4}p)(?=(?:[_-][^/]*)?\.m3u8(?:\/|$)|\/)`;
const RESOLUTION_RE = /(?:RESOLUTION=|^)(\d{3,5})x(\d{3,5})(?:[,\s]|$)/i;
const TEXT_QUALITY_RE = /(?:^|[^0-9])(\d{3,4})\s*p(?:[^0-9]|$)/i;
const MAX_PLAYLIST_FAMILY_PATH_LENGTH = 4096;
const MAX_PLAYLIST_FAMILY_SEGMENTS = 64;
const MAX_HLS_BANDWIDTH = 1_000_000_000;
const MAX_HLS_FRAME_RATE = 240;
const MAX_HLS_WIDTH = 16_384;
const MAX_HLS_HEIGHT = 8_640;
const MAX_HLS_PIXELS = MAX_HLS_WIDTH * MAX_HLS_HEIGHT;
const GENERIC_RENDITION_DIRECTORIES = new Set(["media", "playlist", "playlists", "segment", "segments"]);
const GENERIC_PLAYLIST_NAMES = new Set([
  "chunklist",
  "index",
  "main",
  "manifest",
  "master",
  "media",
  "playlist",
  "stream",
  "video",
]);
const RENDITION_QUALIFIER_RE = /^(?:av1|avc|avc1|baseline|bitrate|h264|h265|hdr|hevc|high|highbitrate|low|main|source|sdr|vp9|\d{2,3}fps)$/i;
const SIGNED_PATH_KEY_RE = /^(?:acl|auth|expires?|hdntl|hdnts|hmac|key-pair-id|md5|policy|signature|st|token)$/i;
const VOLATILE_QUERY_KEY_RE = /^(?:_HLS_(?:msn|part|skip|start_offset)|acl|auth|expires?|hdntl|hdnts|hmac|key-pair-id|md5|policy|signature|st|token)$/i;
const LIVE_CONTROL_QUERY_KEY_RE = /^_HLS_(?:msn|part|skip|start_offset)$/i;
const DIAGNOSTIC_DOMAIN_LABELS = [
  "akamaized.net",
  "chzzk.naver.com",
  "gscdn.net",
  "navercdn.com",
  "pstatic.net",
];

const FAMILY_HASH_SALT = (() => {
  const fallback = `${Date.now()}-${Math.random()}`;
  try {
    const bytes = new Uint32Array(2);
    globalThis.crypto?.getRandomValues?.(bytes);
    if (bytes[0] || bytes[1]) return `${bytes[0].toString(16)}-${bytes[1].toString(16)}`;
  } catch {
    // A process-local fallback still keeps raw query values out of the family key.
  }
  return fallback;
})();

function hashFamilyComponent(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const source = `${FAMILY_HASH_SALT}\0${String(value)}`;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

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

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function encodePathSegment(segment) {
  return encodeURIComponent(segment);
}

function signedPathKey(segment) {
  const decoded = decodePathSegment(segment);
  const separator = decoded.indexOf("=");
  if (separator <= 0) return null;
  const key = decoded.slice(0, separator);
  return SIGNED_PATH_KEY_RE.test(key) ? key.toLowerCase() : null;
}

function stripKnownSignedPathTail(segment) {
  const decoded = decodePathSegment(segment);
  const markerRe = /(?:^|[~;&])([a-z][a-z0-9_-]{0,31})=/gi;
  for (const match of decoded.matchAll(markerRe)) {
    if (!SIGNED_PATH_KEY_RE.test(match[1])) continue;
    const prefix = decoded.slice(0, match.index).replace(/[~;&]+$/, "");
    return { prefix: prefix ? encodePathSegment(prefix) : "", signed: true };
  }
  return { prefix: segment, signed: false };
}

export function hlsPlaylistPathInfo(value) {
  if (typeof value !== "string" || value === "") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) return null;
  if (parsed.pathname.length > MAX_PLAYLIST_FAMILY_PATH_LENGTH) return null;

  const rawSegments = parsed.pathname.split("/").filter(Boolean);
  if (rawSegments.length === 0 || rawSegments.length > MAX_PLAYLIST_FAMILY_SEGMENTS) return null;

  let playlistIndex = -1;
  let playlistPrefix = "";
  for (let index = rawSegments.length - 1; index >= 0; index -= 1) {
    const stripped = stripKnownSignedPathTail(rawSegments[index]);
    if (/\.m3u8$/i.test(decodePathSegment(stripped.prefix))) {
      playlistIndex = index;
      playlistPrefix = stripped.prefix;
      break;
    }
  }
  if (playlistIndex < 0) return null;

  for (const segment of rawSegments.slice(playlistIndex + 1)) {
    if (!signedPathKey(segment)) return null;
  }

  return {
    parsed,
    playlistIndex,
    playlistSegment: playlistPrefix,
    rawSegments,
  };
}

export function isHlsPlaylistUrl(value) {
  return hlsPlaylistPathInfo(value) !== null;
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

function playlistNameDiscriminator(segment) {
  const { prefix } = stripKnownSignedPathTail(segment);
  const decoded = decodePathSegment(prefix);
  if (!/\.m3u8$/i.test(decoded)) return null;

  let stem = decoded.slice(0, -".m3u8".length);
  const hadQualityMarker = /(^|[_-])\d{3,4}p(?=$|[_-])/i.test(stem);
  stem = stem.replace(/(^|[_-])\d{3,4}p(?=$|[_-])/gi, "$1{quality}");
  stem = stem.replace(/^(?:chunklist(?:_\{quality\})?|index|manifest|master|media|playlist)(?:[_-]+|$)/i, "");
  stem = stem.replace(/\{quality\}/gi, "").replace(/^[-_.]+|[-_.]+$/g, "");
  if (!hadQualityMarker && GENERIC_PLAYLIST_NAMES.has(stem.toLowerCase())) return "";
  const semanticTokens = stem
    .split(/[-_.]+/)
    .filter(Boolean)
    .filter((token) => !RENDITION_QUALIFIER_RE.test(token));
  return semanticTokens.length > 0 ? encodePathSegment(semanticTokens.join("_")) : "";
}

function semanticQueryDiscriminator(parsed) {
  const entries = [];
  for (const [key, value] of parsed.searchParams) {
    if (VOLATILE_QUERY_KEY_RE.test(key)) continue;
    // URL query names and ordering can be application-significant. Preserve
    // both while hashing values so distinct streams never share state and raw
    // identifiers never enter the in-memory family key.
    entries.push([key, hashFamilyComponent(`${key}\0${value}`)]);
  }
  return entries;
}

function familyParts(url, { includeShape = true } = {}) {
  const info = hlsPlaylistPathInfo(url);
  if (!info) return null;
  const { parsed, playlistIndex, playlistSegment, rawSegments } = info;
  const directorySegments = rawSegments.slice(0, playlistIndex);

  let qualityDirectoryIndex = -1;
  for (let index = directorySegments.length - 1; index >= 0; index -= 1) {
    const { prefix } = stripKnownSignedPathTail(directorySegments[index]);
    if (/^\d{3,4}p$/i.test(decodePathSegment(prefix))) {
      qualityDirectoryIndex = index;
      break;
    }
  }

  const baseDirectorySegments =
    qualityDirectoryIndex >= 0 ? directorySegments.slice(0, qualityDirectoryIndex) : directorySegments;
  const rawRenditionTail =
    qualityDirectoryIndex >= 0 ? directorySegments.slice(qualityDirectoryIndex + 1) : [];
  const renditionTail = rawRenditionTail.map((segment) => stripKnownSignedPathTail(segment).prefix);
  const normalizedTail =
    renditionTail.length === 1 && GENERIC_RENDITION_DIRECTORIES.has(decodePathSegment(renditionTail[0]).toLowerCase())
      ? []
      : renditionTail;

  const safeBaseSegments = [];
  for (const segment of baseDirectorySegments) {
    const { prefix, signed } = stripKnownSignedPathTail(segment);
    if (prefix) safeBaseSegments.push(prefix);
    if (signed) break;
  }

  return {
    baseDirectorySegments: safeBaseSegments,
    discriminator: includeShape ? playlistNameDiscriminator(playlistSegment) : "",
    origin: `${parsed.protocol}//${parsed.host.toLowerCase()}`,
    query: semanticQueryDiscriminator(parsed),
    renditionTail: includeShape ? normalizedTail : [],
  };
}

export function playlistRootKey(url) {
  const parts = familyParts(url, { includeShape: false });
  if (!parts) return null;
  return JSON.stringify([parts.origin, parts.baseDirectorySegments, parts.query]);
}

export function playlistFamilyKey(url) {
  const parts = familyParts(url);
  if (!parts) return null;
  return JSON.stringify([
    parts.origin,
    parts.baseDirectorySegments,
    parts.renditionTail,
    parts.discriminator,
    parts.query,
  ]);
}

export function canonicalNetworkUrl(url) {
  if (typeof url !== "string" || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function buildMasterVariantRedirectUrl(variantUrl, requestUrl) {
  try {
    const variant = new URL(variantUrl);
    const request = new URL(requestUrl);
    if (variant.protocol !== "https:" || request.protocol !== "https:") return null;

    for (const key of [...variant.searchParams.keys()]) {
      if (LIVE_CONTROL_QUERY_KEY_RE.test(key)) variant.searchParams.delete(key);
    }
    for (const [key, value] of request.searchParams) {
      if (LIVE_CONTROL_QUERY_KEY_RE.test(key)) variant.searchParams.append(key, value);
    }
    variant.hash = request.hash;
    return variant.toString();
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
    const isPlaylist = isHlsPlaylistUrl(url);
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
    !urlQualityMarkersAreSafe(url) ||
    !isHlsPlaylistUrl(url)
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
  return urlQualityMarkersAreSafe(replacedUrl) && isHlsPlaylistUrl(replacedUrl) ? replacedUrl : null;
}

function splitHlsAttributeList(value) {
  const source = String(value ?? "");
  if (!source || /[\r\n]/.test(source)) return null;
  const result = [];
  let current = "";
  let quoted = false;

  for (const character of source) {
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (!quoted && /[\t ]/.test(character)) return null;
    if (character === "," && !quoted) {
      if (!current) return null;
      result.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quoted || !current) return null;
  result.push(current);
  return result;
}

function parseHlsAttributeList(value) {
  const entries = splitHlsAttributeList(value);
  if (!entries) return null;

  const attributes = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) return null;
    const key = entry.slice(0, separator);
    if (!/^[A-Z0-9-]+$/.test(key) || Object.hasOwn(attributes, key)) return null;

    const rawValue = entry.slice(separator + 1);
    if (!rawValue) return null;
    if (rawValue.startsWith('"')) {
      if (rawValue.length < 2 || !rawValue.endsWith('"')) return null;
      const valueText = rawValue.slice(1, -1);
      if (valueText.includes('"') || /[\r\n]/.test(valueText)) return null;
      attributes[key] = { quoted: true, value: valueText };
    } else {
      if (rawValue.includes('"')) return null;
      attributes[key] = { quoted: false, value: rawValue };
    }
  }
  return attributes;
}

function unquotedAttribute(attributes, name) {
  const attribute = attributes[name];
  if (attribute == null) return { present: false, value: null };
  return attribute.quoted
    ? { present: true, value: null }
    : { present: true, value: attribute.value };
}

function boundedPositiveDecimalInteger(attribute, max) {
  if (!attribute.present) return { valid: true, value: null };
  if (typeof attribute.value !== "string" || !/^\d+$/.test(attribute.value)) {
    return { valid: false, value: null };
  }
  const number = Number(attribute.value);
  return {
    valid: Number.isSafeInteger(number) && number > 0 && number <= max,
    value: number,
  };
}

function boundedPositiveDecimal(attribute, max) {
  if (!attribute.present) return { valid: true, value: null };
  if (typeof attribute.value !== "string" || !/^\d+(?:\.\d+)?$/.test(attribute.value)) {
    return { valid: false, value: null };
  }
  const number = Number(attribute.value);
  return {
    valid: Number.isFinite(number) && number > 0 && number <= max,
    value: number,
  };
}

function parseResolutionAttribute(attribute) {
  if (!attribute.present) return { present: false, valid: true, value: null };
  if (typeof attribute.value !== "string") return { present: true, valid: false, value: null };
  const match = attribute.value.match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) return { present: true, valid: false, value: null };
  const width = Number(match[1]);
  const height = Number(match[2]);
  const valid =
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_HLS_WIDTH &&
    height <= MAX_HLS_HEIGHT &&
    width * height <= MAX_HLS_PIXELS;
  return { present: true, valid, value: valid ? { height, width } : null };
}

function safeVariantUrl(nextUri, baseUrl) {
  if (typeof nextUri !== "string" || !nextUri || /[\u0000-\u001f\u007f]/.test(nextUri)) return null;
  try {
    const parsed = new URL(nextUri, baseUrl);
    if (parsed.protocol !== "https:" || !parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function parseHlsMasterPlaylistVariants(playlistText, baseUrl = "") {
  const lines = String(playlistText ?? "").split(/\r\n|[\r\n]/);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

    const attributes = parseHlsAttributeList(line.slice("#EXT-X-STREAM-INF:".length));
    if (!attributes) continue;
    const averageBandwidth = boundedPositiveDecimalInteger(
      unquotedAttribute(attributes, "AVERAGE-BANDWIDTH"),
      MAX_HLS_BANDWIDTH,
    );
    const bandwidth = boundedPositiveDecimalInteger(
      unquotedAttribute(attributes, "BANDWIDTH"),
      MAX_HLS_BANDWIDTH,
    );
    const frameRate = boundedPositiveDecimal(
      unquotedAttribute(attributes, "FRAME-RATE"),
      MAX_HLS_FRAME_RATE,
    );
    const resolution = parseResolutionAttribute(unquotedAttribute(attributes, "RESOLUTION"));
    if (
      !averageBandwidth.valid ||
      !bandwidth.valid ||
      bandwidth.value === null ||
      !frameRate.valid ||
      !resolution.valid
    ) {
      continue;
    }

    let uriIndex = index + 1;
    while (uriIndex < lines.length && lines[uriIndex].trim() === "") uriIndex += 1;
    const nextUri = lines[uriIndex]?.trim();
    if (!nextUri || nextUri.startsWith("#")) continue;
    const url = safeVariantUrl(nextUri, baseUrl);
    if (!url) continue;

    const quality = resolution.value
      ? normalizeQualityLabel(`${resolution.value.width}x${resolution.value.height}`)
      : parseQualityFromUrl(url);
    variants.push({
      averageBandwidth: averageBandwidth.value,
      bandwidth: bandwidth.value,
      frameRate: frameRate.value,
      quality,
      resolution: resolution.value,
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
  { excludedQualities = [], minRedirectQuality = "100p", variantFilter = null } = {},
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
      .filter((variant) => (typeof variantFilter === "function" ? variantFilter(variant) : true))
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
