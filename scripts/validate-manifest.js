import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { buildScopedSessionRule } from "../src/shared/session-rules.js";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const policy = JSON.parse(await readFile(new URL("../policy/quality-policy.json", import.meta.url), "utf8"));

assert.equal(manifest.manifest_version, 3, "manifest_version must be 3");
assert.equal(manifest.name, "CHZZK", "extension name must be CHZZK");
assert.equal(manifest.version, packageJson.version, "manifest version must match package.json");
assert.ok(
  manifest.permissions.includes("declarativeNetRequest"),
  "DNR permission is required for CHZZK session redirect rules",
);
assert.ok(manifest.permissions.includes("storage"), "storage permission is required for local diagnostics");
assert.ok(
  manifest.permissions.includes("webRequest"),
  "webRequest permission is required for local diagnostics and session-rule bootstrap",
);
assert.ok(!manifest.permissions.includes("scripting"), "scripting permission must not be needed");
assert.equal(manifest.content_scripts, undefined, "content scripts must not be needed");
assert.equal(
  manifest.declarative_net_request,
  undefined,
  "global static DNR rulesets are forbidden; use tab-scoped session rules instead",
);
assert.equal(existsSync(new URL("../rules.json", import.meta.url)), false, "rules.json must not exist");
assert.ok(
  manifest.host_permissions.includes("*://chzzk.naver.com/live/*"),
  "CHZZK live host permission is required",
);
assert.deepEqual(
  manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required,
  ["none"],
  "manifest must declare no remote data collection",
);
assert.equal(manifest.icons?.["32"], "icon.png", "CHZZK favicon must be registered");
assert.equal(manifest.action?.default_icon?.["32"], "icon.png", "action icon must use the CHZZK favicon");
assert.equal(manifest.action?.default_popup, "diagnostics.html", "diagnostics popup must be registered");

const sampleRule = buildScopedSessionRule({ policy, tabId: 1 });
assert.deepEqual(sampleRule.condition.tabIds, [1], "session rule must be scoped to one tab");
assert.deepEqual(sampleRule.condition.initiatorDomains, ["chzzk.naver.com"]);
assert.deepEqual(sampleRule.condition.requestDomains, ["akamaized.net", "navercdn.com", "pstatic.net"]);
assert.equal(sampleRule.condition.regexFilter.includes("360p|480p|720p"), false);

console.log("manifest and session-scoped CHZZK redirect policy are valid");
