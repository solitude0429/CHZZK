(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const STORAGE_KEY = "chzzkDiagnostics";
  const MAX_SAMPLES = 200;
  const HLS_RE = /\.m3u8(?:[?#]|$)/i;
  const QUALITY_RE = /(?:chunklist_|\/)(\d{3,4}p)(?=\.m3u8(?:[?#]|$)|\/)/i;
  const CHZZK_PAGE_RE = /^https?:\/\/chzzk\.naver\.com\/live\//i;

  function parseQualityFromUrl(url) {
    const match = String(url ?? "").match(QUALITY_RE);
    return match ? `${Number.parseInt(match[1], 10)}p` : null;
  }

  function redactUrl(url) {
    try {
      const parsed = new URL(url);
      const hadSensitiveTail = parsed.search || parsed.hash;
      parsed.search = "";
      parsed.hash = "";
      return `${parsed.toString()}${hadSensitiveTail ? "?[redacted]" : ""}`;
    } catch {
      return String(url ?? "").replace(/[?#].*$/, "?[redacted]");
    }
  }

  function emptyDiagnostics() {
    return {
      generatedAt: new Date(0).toISOString(),
      maxSamples: MAX_SAMPLES,
      qualities: {},
      samples: [],
      totalHlsRequests: 0,
    };
  }

  async function loadDiagnostics() {
    const stored = await api.storage.local.get(STORAGE_KEY);
    return stored?.[STORAGE_KEY] ?? emptyDiagnostics();
  }

  async function saveDiagnostics(diagnostics) {
    await api.storage.local.set({ [STORAGE_KEY]: diagnostics });
  }

  function isLikelyChzzkRequest(details) {
    const pageUrl = details.documentUrl ?? details.originUrl ?? details.initiator ?? "";
    return pageUrl === "" || CHZZK_PAGE_RE.test(pageUrl);
  }

  async function recordRequest(details) {
    if (!details?.url || !HLS_RE.test(details.url) || !isLikelyChzzkRequest(details)) return;

    const quality = parseQualityFromUrl(details.url);
    if (!quality) return;

    const now = new Date().toISOString();
    const diagnostics = await loadDiagnostics();
    diagnostics.generatedAt = now;
    diagnostics.maxSamples = MAX_SAMPLES;
    diagnostics.totalHlsRequests = (diagnostics.totalHlsRequests ?? 0) + 1;
    diagnostics.qualities ??= {};
    diagnostics.qualities[quality] = (diagnostics.qualities[quality] ?? 0) + 1;
    diagnostics.samples ??= [];
    diagnostics.samples.push({
      quality,
      requestId: details.requestId,
      seenAt: now,
      type: details.type,
      url: redactUrl(details.url),
    });
    if (diagnostics.samples.length > MAX_SAMPLES) {
      diagnostics.samples.splice(0, diagnostics.samples.length - MAX_SAMPLES);
    }

    await saveDiagnostics(diagnostics);
  }

  api.webRequest.onBeforeRequest.addListener(
    (details) => {
      recordRequest(details).catch((error) => console.warn("[CHZZK] diagnostics failed", error));
    },
    {
      urls: ["*://*.akamaized.net/*", "*://*.navercdn.com/*", "*://*.pstatic.net/*"],
      types: ["media", "xmlhttprequest"],
    },
  );

  api.runtime.onInstalled?.addListener(async () => {
    const diagnostics = await loadDiagnostics();
    diagnostics.maxSamples = MAX_SAMPLES;
    await saveDiagnostics(diagnostics);
  });
})();
