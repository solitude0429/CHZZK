import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
const rules = JSON.parse(readFileSync(new URL("../../rules.json", import.meta.url), "utf8"));

describe("grid bypass extension policy", () => {
  it("ships the DNR ruleset required to bypass the NAVER Live Streaming grid requirement", () => {
    assert.ok(
      manifest.permissions?.includes("declarativeNetRequest"),
      "DNR permission is required for the 480p→1080p HLS redirect",
    );
    assert.deepEqual(manifest.declarative_net_request?.rule_resources, [
      {
        enabled: true,
        id: "ruleset_1",
        path: "rules.json",
      },
    ]);
  });

  it("redirects CHZZK 480p HLS playlist requests to 1080p", () => {
    assert.equal(rules.length, 1, "exactly one static redirect rule should be shipped");
    const [rule] = rules;

    assert.equal(rule.action?.type, "redirect");
    assert.equal(rule.action?.redirect?.regexSubstitution, "\\11080p\\2");
    assert.equal(rule.condition?.regexFilter, "(.*)480p(.*\\.m3u8.*)");
    assert.deepEqual([...rule.condition.resourceTypes].sort(), ["media", "xmlhttprequest"]);
  });

  it("requests only CHZZK page access plus the CDN hosts needed for HLS playlist redirects", () => {
    assert.deepEqual(manifest.host_permissions, [
      "*://*.akamaized.net/*",
      "*://*.navercdn.com/*",
      "*://*.pstatic.net/*",
      "*://chzzk.naver.com/live/*",
    ]);
  });
});
