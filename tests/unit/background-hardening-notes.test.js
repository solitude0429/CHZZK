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
    assert.match(source, /startupRedirectTargetQuality/);
    assert.match(source, /activeTargetsByTab/);
  });

  it("prewarms CHZZK live tabs before the first playlist request is observed", () => {
    const observer = readFileSync(new URL("../../src/runtime/site-observer.js", import.meta.url), "utf8");
    assert.match(observer, /chzzk\.live-page-ready/);
    assert.match(observer, /sendMessage/);
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
});
