import { highestQualityCandidate, parseQualityFromUrl, qualityNumber } from "./quality.js";

export const REDIRECT_TAB_ID_RANGE = 100_000;
const DEFAULT_RESOURCE_TYPES = ["media", "other", "xmlhttprequest"];
const DEFAULT_REQUEST_METHODS = ["get"];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function canonicalDomainFromUrl(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function domainMatches(hostname, canonicalDomain) {
  return hostname === canonicalDomain || hostname.endsWith(`.${canonicalDomain}`);
}

function trustedInitiatorDomains(policy) {
  return asArray(policy.trustedInitiatorDomains).length > 0
    ? asArray(policy.trustedInitiatorDomains)
    : ["chzzk.naver.com"];
}

function trustedRequestDomains(policy) {
  return asArray(policy.trustedRequestDomains).length > 0
    ? asArray(policy.trustedRequestDomains)
    : ["akamaized.net", "chzzk.naver.com", "gscdn.net", "navercdn.com", "pstatic.net"];
}

function resourceTypes(policy) {
  return asArray(policy.resourceTypes).length > 0 ? asArray(policy.resourceTypes) : DEFAULT_RESOURCE_TYPES;
}

function requestMethods(policy) {
  return asArray(policy.requestMethods).length > 0 ? asArray(policy.requestMethods) : DEFAULT_REQUEST_METHODS;
}

export function defaultRedirectTargetQuality(policy) {
  return highestQualityCandidate(policy.qualityCandidates, {
    minRedirectQuality: policy.minRedirectQuality,
  });
}

export function startupRedirectTargetQuality(policy) {
  return policy.startupTargetQuality ?? "1080p";
}

export function isValidRedirectTabId(tabId) {
  return Number.isSafeInteger(tabId) && tabId >= 0 && tabId < REDIRECT_TAB_ID_RANGE;
}

export function isTrustedRequestDomain(url, policy) {
  const hostname = canonicalDomainFromUrl(url);
  if (!hostname) return false;
  return trustedRequestDomains(policy).some((domain) => domainMatches(hostname, domain));
}

export function isChzzkLiveUrl(url, policy) {
  if (typeof url !== "string" || url === "") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (
      !trustedInitiatorDomains(policy).some((domain) => domainMatches(parsed.hostname.toLowerCase(), domain))
    ) {
      return false;
    }
    return parsed.pathname === "/live" || parsed.pathname.startsWith("/live/");
  } catch {
    return false;
  }
}

export function isTrustedChzzkContext(details, policy, { trustedLiveTabIds = null } = {}) {
  if (!details || !isValidRedirectTabId(details.tabId)) return false;
  if (trustedLiveTabIds?.has?.(details.tabId)) return true;
  if (isChzzkLiveUrl(details.documentUrl, policy)) return true;
  if (isChzzkLiveUrl(details.originUrl, policy)) return true;

  const initiatorDomain = canonicalDomainFromUrl(details.initiator);
  const hasTrustedInitiator = Boolean(
    initiatorDomain &&
      trustedInitiatorDomains(policy).some((domain) => domainMatches(initiatorDomain, domain)),
  );

  // An origin-only initiator is useful as a supporting signal, but it is not enough by itself: require
  // at least one page-level URL to point at a CHZZK live route so unrelated NAVER pages cannot redirect.
  return Boolean(
    hasTrustedInitiator &&
      [details.documentUrl, details.originUrl].some((url) => isChzzkLiveUrl(url, policy)),
  );
}

export function shouldRecordDiagnostics(details, policy, options = {}) {
  if (!details?.url || !/\.m3u8(?:[?#]|$)/i.test(details.url)) return false;
  if (!isValidRedirectTabId(details.tabId)) return false;
  if (!isTrustedRequestDomain(details.url, policy)) return false;
  return isTrustedChzzkContext(details, policy, options);
}

export function shouldRedirectRequest(details, policy, options = {}) {
  const tabId = details?.tabId;
  if (!isValidRedirectTabId(tabId)) {
    return { ok: false, reason: "invalid-tab", tabId: tabId ?? null };
  }

  const allowedTypes = resourceTypes(policy);
  if (details.type && !allowedTypes.includes(details.type)) {
    return { ok: false, reason: "unsupported-resource-type", tabId };
  }

  const allowedMethods = requestMethods(policy);
  const method = String(details.method ?? "GET").toLowerCase();
  if (!allowedMethods.includes(method)) {
    return { ok: false, reason: "unsupported-request-method", tabId };
  }

  if (!isTrustedRequestDomain(details.url, policy)) {
    return { ok: false, reason: "untrusted-request-domain", tabId };
  }

  if (!isTrustedChzzkContext(details, policy, options)) {
    return { ok: false, reason: "untrusted-initiator", tabId };
  }

  const quality = parseQualityFromUrl(details.url);
  const current = qualityNumber(quality);
  const min = qualityNumber(policy.minRedirectQuality ?? "100p");
  if (!quality || !current || !min) {
    return { ok: false, reason: "unknown-quality-shape", tabId };
  }
  if (current < min) {
    return { ok: false, quality, reason: "quality-below-minimum", tabId };
  }

  return { ok: true, quality, reason: "eligible-chzzk-hls-quality", tabId };
}

export function configuredRequiredOrigins(policy) {
  return trustedRequestDomains(policy)
    .map((domain) =>
      trustedInitiatorDomains(policy).includes(domain) ? `https://*.${domain}/live/*` : `https://*.${domain}/*`,
    )
    .sort((left, right) => displayPermissionKey(left).localeCompare(displayPermissionKey(right), "en"));
}

function displayPermissionKey(permission) {
  return permission.replace(/^https:\/\/\*\./, "").replace(/^https:\/\//, "");
}

export function configuredWebRequestUrls(policy) {
  return configuredRequiredOrigins(policy);
}

export function configuredResourceTypes(policy) {
  return resourceTypes(policy);
}

export function configuredRequestMethods(policy) {
  return requestMethods(policy);
}
