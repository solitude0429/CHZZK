export const QUALITY_LABEL_RE = /^(\d{3,4})p$/i;
export const DEFAULT_QUALITY_CANDIDATES = ["2160p", "1440p", "1080p", "720p", "480p", "360p", "270p", "144p"];

const PATH_QUALITY_RE = /(?:chunklist_|\/)(\d{3,4}p)(?=(?:[_-][^/]*)?\.m3u8$|\/)/i;
const RESOLUTION_RE = /(?:RESOLUTION=|^)(\d{3,5})x(\d{3,5})(?:[,\s]|$)/i;
const TEXT_QUALITY_RE = /(?:^|[^0-9])(\d{3,4})\s*p(?:[^0-9]|$)/i;
const SENSITIVE_PATH_SEGMENT_RE = /(?:hdntl|hmac|policy|signature|token|key|acl|exp|st)(?:=|%3d)/i;
const HIGH_ENTROPY_PATH_SEGMENT_RE = /(?:[a-z0-9_-]{24,}|[a-f0-9]{16,})/i;

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

export function parseQualityFromUrl(url) {
  if (typeof url !== "string") return null;
  let pathname = url;

  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split("?")[0].split("#")[0];
  }

  const pathQuality = pathname.match(PATH_QUALITY_RE);
  return pathQuality ? normalizeQualityLabel(pathQuality[1]) : null;
}

export function redactMediaUrl(url) {
  if (typeof url !== "string" || url === "") return "";

  try {
    const parsed = new URL(url);
    const hadSensitiveTail = parsed.search || parsed.hash;
    parsed.pathname = parsed.pathname
      .split("/")
      .map((segment) => {
        if (!segment) return segment;
        if (/^\d{3,4}p$/i.test(segment)) return segment;
        if (/\.m3u8$/i.test(segment) && !HIGH_ENTROPY_PATH_SEGMENT_RE.test(segment)) return segment;
        if (SENSITIVE_PATH_SEGMENT_RE.test(segment) || HIGH_ENTROPY_PATH_SEGMENT_RE.test(segment)) {
          return "[redacted-path]";
        }
        return segment;
      })
      .join("/");
    parsed.search = "";
    parsed.hash = "";
    return `${parsed.toString()}${hadSensitiveTail ? "?[redacted]" : ""}`;
  } catch {
    return url.replace(/[?#].*$/, "?[redacted]");
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
  if (typeof url !== "string" || !normalizedTarget || !target || !currentQuality) return null;

  let replacedAny = false;
  const replaced = url.replace(
    /(chunklist_|\/)(\d{3,4}p)(?=\.m3u8(?:[?#]|$)|\/)/gi,
    (match, prefix, quality) => {
      const current = qualityNumber(quality);
      if (!current || current >= target) return match;
      replacedAny = true;
      return `${prefix}${normalizedTarget}`;
    },
  );

  return replacedAny ? replaced : null;
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
  if (current) result.push(current);
  return result;
}

function parseHlsAttributeList(value) {
  return Object.fromEntries(
    splitHlsAttributeList(value)
      .map((entry) => {
        const separator = entry.indexOf("=");
        if (separator === -1) return null;
        const key = entry.slice(0, separator).trim().toUpperCase();
        const rawValue = entry
          .slice(separator + 1)
          .trim()
          .replace(/^"|"$/g, "");
        return key ? [key, rawValue] : null;
      })
      .filter(Boolean),
  );
}

function numericAttribute(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
      averageBandwidth: numericAttribute(attributes["AVERAGE-BANDWIDTH"]),
      bandwidth: numericAttribute(attributes.BANDWIDTH),
      frameRate: numericAttribute(attributes["FRAME-RATE"]),
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

export function chooseBestHlsVariant(playlistText, baseUrl = "", { minRedirectQuality = "100p" } = {}) {
  const min = qualityNumber(minRedirectQuality) ?? 0;
  return (
    parseHlsMasterPlaylistVariants(playlistText, baseUrl)
      .filter((variant) => (variantScore(variant).height || 0) >= min)
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
