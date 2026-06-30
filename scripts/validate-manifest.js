import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

assert.equal(manifest.manifest_version, 3, "manifest_version must be 3");
assert.equal(manifest.name, "CHZZK", "extension name must be CHZZK");
assert.ok(manifest.permissions.includes("scripting"), "scripting permission is required");
assert.ok(!manifest.permissions.includes("declarativeNetRequest"), "static DNR redirects are not allowed");
assert.equal(manifest.declarative_net_request, undefined, "static DNR rulesets are not allowed");
assert.ok(
  manifest.host_permissions.includes("*://chzzk.naver.com/live/*"),
  "CHZZK live host permission is required",
);
assert.deepEqual(
  manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required,
  ["none"],
  "manifest must declare no data collection",
);

console.log("manifest is valid");
