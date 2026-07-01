import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("background hardening invariants", () => {
  const source = readFileSync(new URL("../../src/runtime/background.js", import.meta.url), "utf8");

  it("uses MV2 required-permission webRequest redirects without DNR/session rules", () => {
    assert.equal(source.includes("declarativeNetRequest"), false);
    assert.equal(source.includes("updateSessionRules"), false);
    assert.equal(source.includes("getSessionRules"), false);
    assert.equal(source.includes("chzzk.live-page-ready"), false);
    assert.match(source, /activeTargetsByTab/);
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
});
