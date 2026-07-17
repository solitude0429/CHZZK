import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("background hardening invariants", () => {
  const source = readFileSync(new URL("../../src/runtime/background.js", import.meta.url), "utf8");

  it("uses MV2 required-permission webRequest redirects without DNR/session rules", () => {
    assert.equal(source.includes("declarativeNetRequest"), false);
    assert.equal(source.includes("updateSessionRules"), false);
    assert.equal(source.includes("getSessionRules"), false);
    assert.equal(source.includes("chzzk.live-page-ready"), true);
    assert.equal(source.includes("startupRedirectTargetQuality"), false);
    assert.equal(source.includes("startupTargetQuality"), false);
    assert.match(source, /activeLiveTabIds/);
    assert.match(source, /activeTargetsBySession/);
    assert.doesNotMatch(source, /activeTargetsByTab/);
  });

  it("prewarms CHZZK live tabs before the first playlist request is observed", () => {
    const observer = readFileSync(new URL("../../src/runtime/site-observer.js", import.meta.url), "utf8");
    assert.match(observer, /chzzk\.live-page-ready/);
    assert.equal(
      (observer.match(/api\.runtime\.sendMessage\s*\(/g) ?? []).length,
      1,
      "site observer must emit exactly one prewarm message per script execution",
    );
    assert.equal(
      source.includes("sender?.url") || source.includes("sender?.tab?.url") || source.includes("tabUrl"),
      false,
      "prewarm must trust the MV2 content_scripts match because Firefox can omit sender URL fields",
    );
    assert.equal(observer.includes("querySelector"), false);
    assert.equal(observer.includes("MutationObserver"), false);
  });

  it("uses blocking webRequest redirect so the first playlist request is not missed", () => {
    assert.match(source, /buildHighestQualityRedirectUrl\(details\.url/);
    assert.match(source, /return redirectUrl \? \{ redirectUrl \} : undefined/);
    assert.match(source, /\["blocking"\]/);
  });

  it("keeps diagnostics local-only without external telemetry collector code", () => {
    assert.equal(source.includes("TELEMETRY_ENDPOINT"), false);
    assert.equal(source.includes("postTelemetryReport"), false);
    assert.equal(source.includes("chzzk.telemetry.report"), false);
    assert.match(source, /recordRequestDiagnostics\(details, decision\)/);
  });

  it("derives webRequest URL coverage from the trusted HLS domain policy", () => {
    assert.match(source, /WEB_REQUEST_URLS = configuredWebRequestUrls\(policy\)/);
    assert.match(source, /urls: WEB_REQUEST_URLS/);
    assert.match(source, /types: configuredResourceTypes\(policy\)/);
  });

  it("documents the exact contextless fallback, evidence lifetime, and diagnostics privacy scope", () => {
    const hardening = readFileSync(new URL("../../docs/HARDENING.md", import.meta.url), "utf8");
    const security = readFileSync(new URL("../../docs/SECURITY.md", import.meta.url), "utf8");
    const docs = `${hardening}\n${security}`;

    assert.match(docs, /livecloud\.pstatic\.net\.live\.gscdn\.net/);
    assert.match(docs, /nvelop-livecloud\.pstatic\.net/);
    assert.match(docs, /generic CDN path markers? (?:are|is) never contextless trust evidence/i);
    assert.match(docs, /markerEvidenceTtlMs/);
    assert.match(docs, /playlist family/i);
    assert.match(docs, /subdomains? and ports? (?:are|is) discarded/i);
  });
});
