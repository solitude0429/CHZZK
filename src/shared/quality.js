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

const PATH_QUALITY_RE = /(?:chunklist_|\/)(\d{3,4}p)(?=\.m3u8(?:[?#]|$)|\/)/i;
const RESOLUTION_RE = /(?:RESOLUTION=|^)(\d{3,5})x(\d{3,5})(?:[,\s]|$)/i;
const TEXT_QUALITY_RE = /(?:^|[^0-9])(\d{3,4})\s*p(?:[^0-9]|$)/i;
const URL_QUALITY_RE = /(.*(?:chunklist_|\/))(\d{3,4}p)(.*\.m3u8.*)/i;
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
  return pathQuality ? normalizeQualityLabel(pathQuality[1]) : normalizeQualityLabel(pathname);
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
  const currentQuality = parseQualityFromUrl(url);
  if (typeof url !== "string" || !normalizedTarget || !currentQuality) return null;
  const replaced = url.replace(URL_QUALITY_RE, `$1${normalizedTarget}$3`);
  if (replaced === url && normalizedTarget !== currentQuality) return null;
  return replaced;
}

export function buildHighestQualityRedirectUrl(
  url,
  { targetQuality, minRedirectQuality = "100p" } = {},
) {
  const currentQuality = qualityNumber(parseQualityFromUrl(url));
  const target = qualityNumber(targetQuality);
  const min = qualityNumber(minRedirectQuality);
  if (!currentQuality || !target || !min || currentQuality < min || currentQuality >= target) return null;

  return replaceQualityInUrl(url, targetQuality);
}
