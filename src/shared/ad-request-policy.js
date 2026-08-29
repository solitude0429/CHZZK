export const CHZZK_AD_WEB_REQUEST_URLS = Object.freeze([
  "https://api.chzzk.naver.com/ad-polling/v1/lives/*/ad*",
  "https://api.chzzk.naver.com/service/*/channels/*/live-detail*",
  "https://api.chzzk.naver.com/service/*/videos/*",
  "https://api.chzzk.naver.com/service/v1/lives/*/ads/current*",
  "https://api.chzzk.naver.com/service/v1/seoraksan*",
]);

const CANCELLED_AD_PATHS = [
  /^\/ad-polling\/v1\/lives\/[^/]+\/ad\/?$/,
  /^\/service\/v1\/lives\/[^/]+\/ads\/current\/?$/,
  /^\/service\/v1\/seoraksan\/?$/,
];
const LIVE_DETAIL_PATH = /^\/service\/[^/]+\/channels\/[^/]+\/live-detail\/?$/;
const VIDEO_DETAIL_PATH = /^\/service\/[^/]+\/videos\/[^/]+\/?$/;

function chzzkPageUrl(value) {
  if (typeof value !== "string" || value === "") return false;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === "https:" &&
      (hostname === "chzzk.naver.com" || hostname.endsWith(".chzzk.naver.com"))
    );
  } catch {
    return false;
  }
}

function hasTrustedPageMetadata(details) {
  const metadata = [details?.documentUrl, details?.originUrl, details?.initiator].filter(
    (value) => value !== undefined && value !== null,
  );
  return metadata.length > 0 && metadata.every(chzzkPageUrl);
}

function parsedAdApiUrl(details) {
  if (!Number.isSafeInteger(details?.tabId) || details.tabId < 0) return null;
  if (details.type && details.type !== "xmlhttprequest") return null;
  if (String(details.method ?? "GET").toUpperCase() !== "GET") return null;
  if (!hasTrustedPageMetadata(details)) return null;
  try {
    const parsed = new URL(details.url);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "api.chzzk.naver.com"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function chzzkAdRequestDecision(details) {
  const parsed = parsedAdApiUrl(details);
  if (!parsed) return null;
  if (CANCELLED_AD_PATHS.some((pattern) => pattern.test(parsed.pathname))) {
    return { cancel: true };
  }
  if (
    (!LIVE_DETAIL_PATH.test(parsed.pathname) && !VIDEO_DETAIL_PATH.test(parsed.pathname)) ||
    !parsed.searchParams.has("dt")
  ) {
    return null;
  }
  parsed.searchParams.delete("dt");
  return { redirectUrl: parsed.href };
}
