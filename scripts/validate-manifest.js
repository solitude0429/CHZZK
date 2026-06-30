import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const rules = JSON.parse(await readFile(new URL("../rules.json", import.meta.url), "utf8"));

assert.equal(manifest.manifest_version, 3, "manifest_version must be 3");
assert.equal(manifest.name, "CHZZK", "extension name must be CHZZK");
assert.ok(manifest.permissions.includes("declarativeNetRequest"), "DNR permission is required");
assert.ok(manifest.permissions.includes("scripting"), "scripting permission is required");
assert.ok(
  manifest.host_permissions.includes("*://chzzk.naver.com/live/*"),
  "CHZZK live host permission is required",
);
assert.ok(Array.isArray(rules), "rules.json must contain an array");
assert.ok(rules.length > 0, "at least one DNR rule is required");

for (const rule of rules) {
  assert.ok(Number.isInteger(rule.id), "rule id must be an integer");
  assert.ok(rule.condition?.regexFilter, "rule must define a regexFilter");
  assert.equal(rule.action?.type, "redirect", "rule must redirect matching media requests");
}

console.log("manifest and DNR rules are valid");
