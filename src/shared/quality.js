export const HIGHEST_QUALITY = "1080p";
export const LOWER_QUALITIES = ["144p", "240p", "270p", "360p", "480p", "720p"];

const QUALITY_RE = /(?:^|[^0-9])(\d{3,4})\s*p(?:[^0-9]|$)/i;
const RESOLUTION_RE = /(?:RESOLUTION=|^)(\d{3,5})x(\d{3,5})(?:[,\s]|$)/i;
const LOWER_QUALITY_PATTERN = LOWER_QUALITIES.join("|");
const HIGHEST_QUALITY_REPLACEMENTS = [
  {
    from: new RegExp(`chunklist_(${LOWER_QUALITY_PATTERN})(?=\\.m3u8(?:[?#]|$))`, "i"),
    to: `chunklist_${HIGHEST_QUALITY}`,
  },
  {
    from: new RegExp(`(?<=/)(${LOWER_QUALITY_PATTERN})(?=/)`, "i"),
    to: HIGHEST_QUALITY,
  },
];

export function normalizeQualityLabel(value) {
  if (typeof value !== "string") return null;

  const resolutionMatch = value.match(RESOLUTION_RE);
  if (resolutionMatch) return `${Number(resolutionMatch[2])}p`;

  const qualityMatch = value.match(QUALITY_RE);
  if (!qualityMatch) return null;

  return `${Number(qualityMatch[1])}p`;
}

export function parseQualityFromUrl(url) {
  if (typeof url !== "string") return null;
  let pathname = url;

  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split("?")[0].split("#")[0];
  }

  return normalizeQualityLabel(pathname);
}

export function redactMediaUrl(url) {
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

export function buildHighestQualityRedirectUrl(url) {
  if (typeof url !== "string") return null;

  const currentQuality = parseQualityFromUrl(url);
  if (!LOWER_QUALITIES.includes(currentQuality)) return null;

  for (const { from, to } of HIGHEST_QUALITY_REPLACEMENTS) {
    if (from.test(url)) return url.replace(from, to);
  }

  return null;
}
