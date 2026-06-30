export const SOURCE_QUALITY = "480p";
export const TARGET_QUALITY = "1080p";

const QUALITY_RE = /(?:^|[^0-9])(\d{3,4})\s*p(?:[^0-9]|$)/i;
const RESOLUTION_RE = /(?:RESOLUTION=|^)(\d{3,5})x(\d{3,5})(?:[,\s]|$)/i;
const GRID_BYPASS_REPLACEMENTS = [
  {
    from: /chunklist_480p(?=\.m3u8(?:[?#]|$))/i,
    to: "chunklist_1080p",
  },
  {
    from: /(?<=\/)480p(?=\/)/i,
    to: "1080p",
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

export function buildGridBypassRedirectUrl(url) {
  if (typeof url !== "string" || parseQualityFromUrl(url) !== SOURCE_QUALITY) return null;

  for (const { from, to } of GRID_BYPASS_REPLACEMENTS) {
    if (from.test(url)) return url.replace(from, to);
  }

  return null;
}
