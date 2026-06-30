import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../rules.json", import.meta.url), "utf8"));

assert.equal(manifest.manifest_version, 3, "manifest_version must be 3");
assert.equal(manifest.name, "CHZZK", "extension name must be CHZZK");
assert.ok(manifest.permissions.includes("scripting"), "scripting permission is required");
assert.ok(
  manifest.permissions.includes("declarativeNetRequest"),
  "DNR permission is required for the CHZZK grid-bypass redirect",
);
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
  "manifest must declare no data collection",
);

assert.equal(rules.length, 1, "exactly one DNR rule is expected");
assert.equal(rules[0].action?.type, "redirect", "DNR rule must redirect matching media requests");
assert.equal(rules[0].action?.redirect?.regexSubstitution, "\\11080p\\2");
assert.equal(rules[0].condition?.regexFilter, "(.*)480p(.*\\.m3u8.*)");
assert.deepEqual([...rules[0].condition.resourceTypes].sort(), ["media", "xmlhttprequest"]);

console.log("manifest and grid-bypass DNR rules are valid");
