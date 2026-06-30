const QUALITY_RE = /(?:^|[^0-9])(\d{3,4})\s*p(?:[^0-9]|$)/i;
const RESOLUTION_RE = /(?:RESOLUTION=|^)(\d{3,5})x(\d{3,5})(?:[,\s]|$)/i;

export function normalizeQualityLabel(value) {
  if (typeof value !== "string") return null;

  const resolutionMatch = value.match(RESOLUTION_RE);
  if (resolutionMatch) return `${Number(resolutionMatch[2])}p`;

  const qualityMatch = value.match(QUALITY_RE);
  if (!qualityMatch) return null;

  return `${Number(qualityMatch[1])}p`;
}

export function qualityRank(label) {
  const normalized = normalizeQualityLabel(label);
  if (!normalized) return -1;
  return Number(normalized.slice(0, -1));
}

export function chooseHighestQuality(labels) {
  if (!Array.isArray(labels) || labels.length === 0) return null;

  const normalizedLabels = [...new Set(labels.map(normalizeQualityLabel).filter(Boolean))];
  if (normalizedLabels.length === 0) return null;

  return normalizedLabels.sort((a, b) => qualityRank(b) - qualityRank(a))[0];
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

export function parseQualitiesFromPlaylist(playlist) {
  if (typeof playlist !== "string" || playlist.trim() === "") return [];

  const qualities = [];
  for (const rawLine of playlist.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const fromResolution = normalizeQualityLabel(line);
    if (fromResolution) qualities.push(fromResolution);

    const fromUrl = parseQualityFromUrl(line);
    if (fromUrl) qualities.push(fromUrl);
  }

  return [...new Set(qualities)].sort((a, b) => qualityRank(a) - qualityRank(b));
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
