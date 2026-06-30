import { buildQualityRegexFilter, parseQualityFromUrl, qualityNumber } from "./quality.js";

const DEFAULT_SESSION_RULE_BASE_ID = 100_000;
export const SESSION_RULE_ID_RANGE = 100_000;
const DEFAULT_RESOURCE_TYPES = ["media", "xmlhttprequest"];
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
    : ["akamaized.net", "navercdn.com", "pstatic.net"];
}

function resourceTypes(policy) {
  return asArray(policy.resourceTypes).length > 0 ? asArray(policy.resourceTypes) : DEFAULT_RESOURCE_TYPES;
}

function requestMethods(policy) {
  return asArray(policy.requestMethods).length > 0 ? asArray(policy.requestMethods) : DEFAULT_REQUEST_METHODS;
}

export function sessionRuleIdForTab(tabId, { baseId = DEFAULT_SESSION_RULE_BASE_ID } = {}) {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || tabId >= SESSION_RULE_ID_RANGE) {
    throw new Error(`invalid tabId for session DNR rule: ${tabId}`);
  }
  return baseId + tabId;
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

export function isTrustedChzzkContext(details, policy) {
  if (!details || details.tabId == null || details.tabId < 0 || details.tabId >= SESSION_RULE_ID_RANGE) {
    return false;
  }
  if (isChzzkLiveUrl(details.documentUrl, policy)) return true;
  if (isChzzkLiveUrl(details.originUrl, policy)) return true;

  const initiatorDomain = canonicalDomainFromUrl(details.initiator);
  const hasTrustedInitiator = Boolean(
    initiatorDomain &&
      trustedInitiatorDomains(policy).some((domain) => domainMatches(initiatorDomain, domain)),
  );

  // An origin-only initiator is useful as a supporting signal, but it is not enough by itself: require
  // at least one page-level URL to point at a CHZZK live route so unrelated NAVER pages cannot bootstrap.
  return Boolean(
    hasTrustedInitiator &&
      [details.documentUrl, details.originUrl].some((url) => isChzzkLiveUrl(url, policy)),
  );
}

export function shouldRecordDiagnostics(details, policy) {
  if (!details?.url || !/\.m3u8(?:[?#]|$)/i.test(details.url)) return false;
  if (!Number.isSafeInteger(details.tabId) || details.tabId < 0 || details.tabId >= SESSION_RULE_ID_RANGE) {
    return false;
  }
  if (!isTrustedRequestDomain(details.url, policy)) return false;
  return isTrustedChzzkContext(details, policy);
}

export function shouldBootstrapSessionRule(details, policy) {
  const tabId = details?.tabId;
  if (!Number.isSafeInteger(tabId) || tabId < 0 || tabId >= SESSION_RULE_ID_RANGE) {
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

  if (!isTrustedChzzkContext(details, policy)) {
    return { ok: false, reason: "untrusted-initiator", tabId };
  }

  const quality = parseQualityFromUrl(details.url);
  const current = qualityNumber(quality);
  const target = qualityNumber(policy.targetQuality);
  const min = qualityNumber(policy.minRedirectQuality ?? "100p");
  if (!quality || !current || !target || !min) {
    return { ok: false, reason: "unknown-quality-shape", tabId };
  }
  if (current < min) {
    return { ok: false, quality, reason: "quality-below-minimum", tabId };
  }
  if (current >= target) {
    return { ok: false, quality, reason: "target-or-higher-quality", tabId };
  }

  return { ok: true, quality, reason: "eligible-lower-quality-chzzk-hls", tabId };
}

export function buildScopedSessionRule({ policy, tabId }) {
  return {
    id: sessionRuleIdForTab(tabId, { baseId: policy.sessionRuleBaseId ?? DEFAULT_SESSION_RULE_BASE_ID }),
    priority: policy.redirectRulePriority ?? 1,
    action: {
      type: "redirect",
      redirect: {
        regexSubstitution: `\\1${policy.targetQuality}\\3`,
      },
    },
    condition: {
      regexFilter: buildQualityRegexFilter({
        minRedirectQuality: policy.minRedirectQuality,
        targetQuality: policy.targetQuality,
      }),
      initiatorDomains: trustedInitiatorDomains(policy),
      isUrlFilterCaseSensitive: false,
      requestDomains: trustedRequestDomains(policy),
      requestMethods: requestMethods(policy),
      resourceTypes: resourceTypes(policy),
      tabIds: [tabId],
    },
  };
}
