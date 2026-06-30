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

export function choosePreferredVisibleQuality(visibleLabels, storedPreference = null) {
  const normalizedVisibleLabels = [
    ...new Set((visibleLabels ?? []).map(normalizeQualityLabel).filter(Boolean)),
  ];
  if (normalizedVisibleLabels.length === 0) return null;

  const normalizedPreference = normalizeQualityLabel(storedPreference);
  if (normalizedPreference && normalizedVisibleLabels.includes(normalizedPreference))
    return normalizedPreference;

  return chooseHighestQuality(normalizedVisibleLabels);
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

export function rewriteMediaUrlQuality(url, targetQuality) {
  const target = normalizeQualityLabel(targetQuality);
  const current = parseQualityFromUrl(url);
  if (typeof url !== "string" || !target || !current) return null;
  if (target === current) return url;

  const currentHeight = current.slice(0, -1);
  const targetHeight = target.slice(0, -1);
  const replacements = [
    {
      from: new RegExp(`chunklist_${currentHeight}p(?=\\.m3u8(?:[?#]|$))`, "i"),
      to: `chunklist_${targetHeight}p`,
    },
    {
      from: new RegExp(`(?<=/)${currentHeight}p(?=/)`, "i"),
      to: `${targetHeight}p`,
    },
  ];

  for (const { from, to } of replacements) {
    if (from.test(url)) return url.replace(from, to);
  }

  return null;
}

export function planQualityUpgrade({ mediaUrl, observedQualities = [], preferredQuality = null } = {}) {
  const currentQuality = parseQualityFromUrl(mediaUrl);
  const availableQualities = [...new Set(observedQualities.map(normalizeQualityLabel).filter(Boolean))].sort(
    (a, b) => qualityRank(a) - qualityRank(b),
  );
  const highestQuality = chooseHighestQuality(availableQualities);
  const preferred = normalizeQualityLabel(preferredQuality);
  const targetQuality = preferred && availableQualities.includes(preferred) ? preferred : highestQuality;
  const basePlan = {
    action: "keep",
    availableQualities,
    currentQuality,
    highestQuality,
    logUrl: redactMediaUrl(mediaUrl),
    reason: "no-upgrade-needed",
    redirectUrl: null,
    targetQuality,
  };

  if (!currentQuality) return { ...basePlan, reason: "current-quality-unknown" };
  if (availableQualities.length === 0 || !targetQuality) {
    return { ...basePlan, reason: "no-observed-qualities" };
  }
  if (preferred && !availableQualities.includes(preferred)) {
    return { ...basePlan, reason: "preferred-quality-unavailable" };
  }
  if (qualityRank(targetQuality) <= qualityRank(currentQuality)) {
    return { ...basePlan, reason: "already-at-or-above-target" };
  }

  const redirectUrl = rewriteMediaUrlQuality(mediaUrl, targetQuality);
  if (!redirectUrl) return { ...basePlan, reason: "unsupported-url-shape" };

  return {
    ...basePlan,
    action: "upgrade",
    reason: "highest-observed-quality-available",
    redirectUrl,
  };
}
