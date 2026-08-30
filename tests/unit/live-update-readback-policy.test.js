import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(new URL("../../scripts/verify-live-update.windows.ps1", import.meta.url), "utf8");

describe("Windows production update readback", () => {
  it("uses PowerShell HTTPS and binds live JSON, XPI MIME/digest, and provenance", () => {
    assert.match(source, /Invoke-WebRequest/);
    assert.match(source, /https:\/\/chzzk\.home\.arpa:8443/);
    assert.match(source, /application\/json/);
    assert.match(source, /application\/x-xpinstall/);
    assert.match(source, /Get-FileHash[^\n]+SHA256/);
    assert.match(source, /sourceDigest/);
    assert.match(source, /sourceRepository/);
    assert.match(source, /MaximumRedirection 0/);
    assert.doesNotMatch(source, /curl(?:\.exe)?/i);
    assert.doesNotMatch(source, /GH_TOKEN|GITHUB_TOKEN/);
  });
});
