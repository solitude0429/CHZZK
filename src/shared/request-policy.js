import { parseQualityFromUrl, qualityNumber, urlQualityMarkersAreSafe } from "./quality.js";

const DEFAULT_RESOURCE_TYPES = ["media", "other", "xmlhttprequest"];
const DEFAULT_REQUEST_METHODS = ["get"];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function isHttpsUrl(value) {
  if (typeof value !== "string" || value === "") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalHttpsDomainFromUrl(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function hasExplicitMetadataValue(value) {
  return value !== undefined && value !== null;
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

export function isValidRedirectTabId(tabId) {
  return Number.isSafeInteger(tabId) && tabId >= 0;
}

export function isTrustedRequestDomain(url, policy) {
  const hostname = canonicalHttpsDomainFromUrl(url);
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

export function isHlsPlaylistUrl(value) {
  if (typeof value !== "string" || value === "") return false;
  try {
    return /\.m3u8$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function isNumericHlsPlaylistUrl(url) {
  return isHlsPlaylistUrl(url) && Boolean(parseQualityFromUrl(url));
}

function knownChzzkHlsHost(hostname) {
  const knownSuffixes = ["livecloud.pstatic.net.live.gscdn.net", "nvelop-livecloud.pstatic.net"];
  return knownSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function isDedicatedChzzkHlsUrl(url, policy) {
  if (!isNumericHlsPlaylistUrl(url) || !isTrustedRequestDomain(url, policy)) return false;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return knownChzzkHlsHost(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function trustedInitiatorUrl(value, policy) {
  const hostname = canonicalHttpsDomainFromUrl(value);
  return Boolean(
    hostname && trustedInitiatorDomains(policy).some((domain) => domainMatches(hostname, domain)),
  );
}

function requestContextEvidence(details, policy) {
  let hasMetadata = false;
  let trusted = false;

  if (hasExplicitMetadataValue(details?.documentUrl)) {
    hasMetadata = true;
    if (!isChzzkLiveUrl(details.documentUrl, policy)) {
      return { hasMetadata, trusted: false, veto: true };
    }
    trusted = true;
  }

  if (hasExplicitMetadataValue(details?.originUrl)) {
    hasMetadata = true;
    if (!trustedInitiatorUrl(details.originUrl, policy)) {
      return { hasMetadata, trusted: false, veto: true };
    }
    trusted = true;
  }

  if (hasExplicitMetadataValue(details?.initiator)) {
    hasMetadata = true;
    if (!trustedInitiatorUrl(details.initiator, policy)) {
      return { hasMetadata, trusted: false, veto: true };
    }
    trusted = true;
  }

  return { hasMetadata, trusted, veto: false };
}

export function hasContradictoryChzzkMetadata(details, policy) {
  return requestContextEvidence(details, policy).veto;
}

export function hasTrustedChzzkMetadata(details, policy) {
  const evidence = requestContextEvidence(details, policy);
  return evidence.trusted && !evidence.veto;
}

export function isTrustedChzzkContext(details, policy, { trustedLiveTabIds = null } = {}) {
  if (!details || !isValidRedirectTabId(details.tabId)) return false;
  const evidence = requestContextEvidence(details, policy);
  if (evidence.veto) return false;
  if (evidence.trusted) return isNumericHlsPlaylistUrl(details.url);
  if (evidence.hasMetadata) return false;
  if (trustedLiveTabIds?.has?.(details.tabId)) return true;
  return isDedicatedChzzkHlsUrl(details.url, policy);
}

export function isTrustedMasterPlaylistRequest(details, policy, { trustedLiveTabIds = null } = {}) {
  if (!details || !isValidRedirectTabId(details.tabId) || !isHttpsUrl(details.url)) return false;
  if (!isHlsPlaylistUrl(details.url) || parseQualityFromUrl(details.url)) return false;
  if (details.type && !resourceTypes(policy).includes(details.type)) return false;
  const method = String(details.method ?? "GET").toLowerCase();
  if (!requestMethods(policy).includes(method) || !isTrustedRequestDomain(details.url, policy)) return false;
  const evidence = requestContextEvidence(details, policy);
  if (evidence.veto) return false;
  if (evidence.trusted) return true;
  if (evidence.hasMetadata) return false;
  return Boolean(trustedLiveTabIds?.has?.(details.tabId));
}

export function shouldRecordDiagnostics(details, policy, options = {}) {
  if (!isHttpsUrl(details?.url)) return false;
  if (!isHlsPlaylistUrl(details?.url)) return false;
  if (!isValidRedirectTabId(details.tabId)) return false;
  if (!isTrustedRequestDomain(details.url, policy)) return false;
  return isTrustedChzzkContext(details, policy, options);
}

export function shouldRedirectRequest(details, policy, options = {}) {
  const tabId = details?.tabId;
  if (!isHttpsUrl(details?.url)) {
    return { ok: false, reason: "non-https-request-url", tabId: tabId ?? null };
  }
  if (!isValidRedirectTabId(tabId)) {
    return { ok: false, reason: "invalid-tab", tabId: tabId ?? null };
  }
  if (!isHlsPlaylistUrl(details.url)) {
    return { ok: false, reason: "non-playlist-path", tabId };
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
  if (quality && !urlQualityMarkersAreSafe(details.url)) {
    return { ok: false, quality, reason: "contradictory-quality-markers", tabId };
  }
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
      trustedInitiatorDomains(policy).includes(domain)
        ? `https://*.${domain}/live/*`
        : `https://*.${domain}/*`,
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
