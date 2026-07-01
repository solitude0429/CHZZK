export const TELEMETRY_ENDPOINT = "https://chzzk-report.alpha-apple.dedyn.io/report";
export const TELEMETRY_SCOPE = "chzzk-live";
export const TELEMETRY_SCHEMA_VERSION = 1;
export const TELEMETRY_AUTH_SCHEME = "hmac-sha256-v1";

const MAX_CLASS_TOKENS = 80;
const MAX_SELECTOR_SAMPLE = 120;
const MAX_ERROR_TEXT = 300;
const MAX_URL_TEXT = 500;
const CLASS_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_-]{0,48}$/;
const INSTALL_ID_RE = /^[A-Za-z0-9_.:@-]{1,120}$/;
const SENSITIVE_KEY_RE =
  /(?:policy|signature|key-pair-id|expires|token|auth|session|secret|credential|jwt|cookie)/i;
const SCRIPT_ERROR_RE = /\b(referenceerror|typeerror|syntaxerror|rangeerror|evalerror)\b/i;
const NETWORK_ERROR_RE = /\b(network|fetch|timeout|http\s*\d{3}|connection|cors|dns)\b/i;

function textEncoder() {
  return new TextEncoder();
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extractQuality(value) {
  const match = String(value ?? "").match(/(?:^|[^0-9])(\d{3,4}p)(?:[^0-9]|$)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function extensionFromPath(pathname) {
  const match = pathname.match(/\.([a-z0-9]{2,8})$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function isChzzkLivePageUrl(value) {
  if (typeof value !== "string" || value === "") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "chzzk.naver.com" &&
      parsed.pathname.startsWith("/live/")
    );
  } catch {
    return false;
  }
}

export function routeShapeForChzzkLiveUrl(value) {
  if (!isChzzkLivePageUrl(value)) return null;
  return "/live/[redacted]";
}

export function stripSensitiveTail(value) {
  if (typeof value !== "string") return "";
  const input = value.slice(0, MAX_URL_TEXT);
  try {
    const parsed = new URL(input);
    if (!/^https?:$/.test(parsed.protocol)) return "[redacted-url]";
    const quality = extractQuality(parsed.pathname);
    const extension = extensionFromPath(parsed.pathname);
    const suffix = [quality, extension].filter(Boolean).join(".");
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}/[redacted-path]${suffix ? `/${suffix}` : ""}`;
  } catch {
    return input.replace(/[?#].*$/, "?[redacted]").replace(/[A-Za-z0-9_-]{24,}/g, "[redacted-token]");
  }
}

export function sanitizeErrorText(value) {
  if (value == null) return null;
  const text = String(value).slice(0, MAX_ERROR_TEXT);
  if (/^error:[a-z0-9-]{1,80}$/.test(text)) return text;
  if (/https?:\/\/[^\s)]+/i.test(text) && SENSITIVE_KEY_RE.test(text))
    return "error:url-with-sensitive-material";
  if (SENSITIVE_KEY_RE.test(text)) return "error:sensitive-material";
  if (SCRIPT_ERROR_RE.test(text)) {
    const kind = text.match(SCRIPT_ERROR_RE)?.[1]?.toLowerCase().replace("error", "") || "script";
    return `error:script-${kind || "exception"}`;
  }
  if (NETWORK_ERROR_RE.test(text)) return "error:network";
  return text ? "error:page-exception" : null;
}

export function stableHash(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function sanitizeClassToken(value) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!CLASS_TOKEN_RE.test(token)) return null;
  if (/[A-Za-z0-9_-]{24,}/.test(token)) return null;
  return token;
}

export function summarizeClassTokens(tokens = []) {
  const counts = new Map();
  for (const token of tokens) {
    const clean = sanitizeClassToken(token);
    if (!clean) continue;
    counts.set(clean, (counts.get(clean) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_CLASS_TOKENS)
    .map(([token, count]) => ({ token, count }));
}

export function summarizeDomStructure({ url, nodes = [], tagCounts = {}, featureCounts = {} } = {}) {
  const routeShape = routeShapeForChzzkLiveUrl(url);
  if (!routeShape) return null;

  const classTokens = [];
  const selectorSample = [];
  for (const node of nodes.slice(0, MAX_SELECTOR_SAMPLE)) {
    const tag = String(node?.tag ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");
    if (!tag) continue;
    const classes = Array.isArray(node?.classes)
      ? node.classes.map(sanitizeClassToken).filter(Boolean).slice(0, 5)
      : [];
    classTokens.push(...classes);
    selectorSample.push(classes.length > 0 ? `${tag}.${classes.join(".")}` : tag);
  }

  const classSummary = summarizeClassTokens(classTokens);
  const structureHash = stableHash({ classSummary, featureCounts, routeShape, selectorSample, tagCounts });

  return {
    classSummary,
    featureCounts: sanitizeNumericMap(featureCounts),
    routeShape,
    selectorSample,
    structureHash,
    tagCounts: sanitizeNumericMap(tagCounts),
  };
}

export function sanitizeNumericMap(value = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(key)) continue;
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0) continue;
    out[key] = Math.min(Math.trunc(number), 100_000);
  }
  return out;
}

export function summarizeDiagnosticsForTelemetry(snapshot = {}) {
  const decisionsByReason = {};
  for (const decision of snapshot.decisions ?? []) {
    const reason = String(decision?.reason ?? "unknown").slice(0, 80);
    decisionsByReason[reason] = (decisionsByReason[reason] ?? 0) + 1;
  }

  const samples = (snapshot.samples ?? []).slice(-20).map((sample) => ({
    quality: String(sample?.quality ?? "").slice(0, 16) || null,
    seenAt: sample?.seenAt ?? null,
    type: String(sample?.type ?? "").slice(0, 40) || null,
    url: stripSensitiveTail(sample?.url ?? ""),
  }));

  return {
    decisionsByReason,
    generatedAt: snapshot.generatedAt ?? null,
    qualities: sanitizeNumericMap(snapshot.qualities ?? {}),
    samples,
    sessionRules: {
      activeRuleCount: (snapshot.sessionRules?.activeRuleIds ?? []).length,
      activeTabCount: (snapshot.sessionRules?.activeTabIds ?? []).length,
      lastError: sanitizeErrorText(snapshot.sessionRules?.lastError),
      updatedAt: snapshot.sessionRules?.updatedAt ?? null,
    },
    totalHlsRequests: Math.max(0, Math.trunc(Number(snapshot.totalHlsRequests ?? 0) || 0)),
  };
}

export function makeTelemetryReport({ addonId, diagnostics, eventType, extensionVersion, structure } = {}) {
  const now = new Date().toISOString();
  return {
    addonId: addonId ?? null,
    diagnostics: diagnostics ? summarizeDiagnosticsForTelemetry(diagnostics) : null,
    eventType,
    extensionVersion: extensionVersion ?? null,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    scope: TELEMETRY_SCOPE,
    sentAt: now,
    structure: structure ?? null,
  };
}

export function isTelemetryReportSafe(report) {
  if (!report || report.schemaVersion !== TELEMETRY_SCHEMA_VERSION) return false;
  if (report.scope !== TELEMETRY_SCOPE) return false;
  if (report.auth?.scheme !== TELEMETRY_AUTH_SCHEME) return false;
  if (!INSTALL_ID_RE.test(String(report.installId ?? ""))) return false;
  if (!/^[a-z0-9_.@-]+$/i.test(String(report.addonId ?? ""))) return false;
  if (!/^[a-z0-9_.:-]+$/i.test(String(report.extensionVersion ?? ""))) return false;
  const serialized = JSON.stringify(report);
  if (serialized.length > 64_000) return false;
  if (/[?&](Policy|Signature|Key-Pair-Id|Expires|token|auth|session)=/i.test(serialized)) return false;
  return true;
}

async function storageGet(storageArea, keys) {
  if (!storageArea?.get) return {};
  try {
    return (await storageArea.get(keys)) ?? {};
  } catch {
    return {};
  }
}

export async function loadTelemetryCredentials(api) {
  const managed = await storageGet(api?.storage?.managed, [
    "chzzkTelemetryHmacSecret",
    "chzzkTelemetryInstallId",
  ]);
  const local = await storageGet(api?.storage?.local, ["chzzkTelemetryInstallId"]);
  const secret = String(managed.chzzkTelemetryHmacSecret ?? "").trim();
  const installId = String(managed.chzzkTelemetryInstallId ?? local.chzzkTelemetryInstallId ?? "").trim();
  if (!secret || !INSTALL_ID_RE.test(installId)) return null;
  return { installId, secret };
}

export async function signTelemetryPayload(secret, timestamp, body) {
  if (!globalThis.crypto?.subtle) throw new Error("WebCrypto HMAC is unavailable");
  const encoder = textEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
  return bytesToHex(signature);
}

export async function prepareTelemetryRequest(report, { api } = {}) {
  const credentials = await loadTelemetryCredentials(api);
  if (!credentials) return null;
  const authenticated = {
    ...report,
    auth: { scheme: TELEMETRY_AUTH_SCHEME },
    installId: credentials.installId,
  };
  if (!isTelemetryReportSafe(authenticated)) return null;
  const body = JSON.stringify(authenticated);
  const timestamp = new Date().toISOString();
  const signature = await signTelemetryPayload(credentials.secret, timestamp, body);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-chzzk-telemetry-install-id": credentials.installId,
      "x-chzzk-telemetry-signature": `v1=${signature}`,
      "x-chzzk-telemetry-timestamp": timestamp,
    },
  };
}
