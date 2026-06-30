import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildQualityRegexFilter } from "../src/shared/quality.js";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const policy = JSON.parse(await readFile(new URL("../policy/quality-policy.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../rules.json", import.meta.url), "utf8"));

assert.equal(manifest.manifest_version, 3, "manifest_version must be 3");
assert.equal(manifest.name, "CHZZK", "extension name must be CHZZK");
assert.ok(
  manifest.permissions.includes("declarativeNetRequest"),
  "DNR permission is required for the CHZZK highest-quality redirect",
);
assert.ok(manifest.permissions.includes("storage"), "storage permission is required for local diagnostics");
assert.ok(
  manifest.permissions.includes("webRequest"),
  "webRequest permission is required for local diagnostics",
);
assert.ok(!manifest.permissions.includes("scripting"), "scripting permission must not be needed");
assert.equal(manifest.content_scripts, undefined, "content scripts must not be needed");
assert.ok(
  manifest.host_permissions.includes("*://chzzk.naver.com/live/*"),
  "CHZZK live host permission is required",
);
assert.deepEqual(
  manifest.declarative_net_request?.rule_resources,
  [{ id: "ruleset_1", enabled: true, path: "rules.json" }],
  "rules.json must be registered as the static DNR ruleset",
);
assert.deepEqual(
  manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required,
  ["none"],
  "manifest must declare no remote data collection",
);
assert.equal(manifest.icons?.["32"], "icon.png", "official CHZZK favicon must be registered");
assert.equal(manifest.action?.default_icon?.["32"], "icon.png", "action icon must use the CHZZK favicon");
assert.equal(manifest.action?.default_popup, "diagnostics.html", "diagnostics popup must be registered");

assert.equal(rules.length, 1, "exactly one DNR rule is expected");
assert.equal(rules[0].action?.type, "redirect", "DNR rule must redirect matching media requests");
assert.equal(rules[0].action?.redirect?.regexSubstitution, `\\1${policy.targetQuality}\\3`);
assert.equal(
  rules[0].condition?.regexFilter,
  buildQualityRegexFilter({
    minRedirectQuality: policy.minRedirectQuality,
    targetQuality: policy.targetQuality,
  }),
);
assert.equal(rules[0].condition.regexFilter.includes("360p|480p|720p"), false);
assert.deepEqual([...rules[0].condition.resourceTypes].sort(), ["media", "xmlhttprequest"]);

console.log("manifest, diagnostics, and generated highest-quality DNR rules are valid");
