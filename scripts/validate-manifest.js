import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const policy = JSON.parse(await readFile(new URL("../policy/quality-policy.json", import.meta.url), "utf8"));

assert.equal(manifest.manifest_version, 2, "manifest_version must be 2 for Firefox required host permissions");
assert.equal(manifest.name, "CHZZK", "extension name must be CHZZK");
assert.equal(manifest.description, undefined, "manifest description should be omitted from about:addons");
assert.equal(manifest.version, packageJson.version, "manifest version must match package.json");
assert.deepEqual(
  manifest.permissions,
  [
    "https://*.akamaized.net/*",
    "https://*.chzzk.naver.com/*",
    "https://*.gscdn.net/*",
    "https://*.navercdn.com/*",
    "https://*.pstatic.net/*",
    "storage",
    "webRequest",
    "webRequestBlocking",
  ],
  "MV2 must declare all core API and origin access as required permissions",
);
assert.ok(!manifest.permissions.includes("declarativeNetRequest"), "DNR must not be used in the MV2 build");
assert.ok(!manifest.permissions.includes("scripting"), "scripting permission must not be needed");
assert.equal(manifest.host_permissions, undefined, "MV2 build must not expose revocable host_permissions");
assert.deepEqual(
  manifest.content_scripts,
  [{ js: ["site-observer.js"], matches: ["https://*.chzzk.naver.com/live/*"], run_at: "document_start" }],
  "MV2 content script must be required install-time CHZZK live access for first-request prewarm only",
);
assert.equal(manifest.optional_permissions, undefined, "optional permissions must not be used for core functionality");
assert.equal(manifest.optional_host_permissions, undefined, "optional host permissions must not be used for core functionality");
assert.equal(
  manifest.declarative_net_request,
  undefined,
  "global static DNR rulesets are forbidden; use MV2 blocking webRequest redirects instead",
);
assert.equal(existsSync(new URL("../rules.json", import.meta.url)), false, "rules.json must not exist");
assert.equal(
  manifest.permissions.some((permission) => permission.includes("chzzk-report")),
  false,
  "external diagnostics collector host permission must not be requested",
);
assert.deepEqual(
  manifest.browser_specific_settings?.gecko?.data_collection_permissions,
  { required: ["none"] },
  "manifest must declare no external data collection/transmission",
);
assert.equal(
  manifest.browser_specific_settings?.gecko?.update_url,
  "https://chzzk-updates.alpha-apple.dedyn.io/updates.json",
  "Firefox auto-update manifest URL must remain stable",
);
assert.deepEqual(
  manifest.icons,
  { 32: "icon-32.png", 48: "icon-48.png", 96: "icon-96.png", 128: "icon.png" },
  "CHZZK favicon sizes must be registered with size-matched PNGs",
);
assert.equal(manifest.action, undefined, "MV3 action key must not be used in MV2");
assert.deepEqual(
  manifest.browser_action?.default_icon,
  { 32: "icon-32.png", 48: "icon-48.png", 96: "icon-96.png", 128: "icon.png" },
  "browser_action icon sizes must use size-matched CHZZK favicon PNGs",
);
assert.equal(manifest.browser_action?.default_popup, "diagnostics.html", "diagnostics popup must be registered");

assert.deepEqual(policy.trustedRequestDomains, [
  "akamaized.net",
  "chzzk.naver.com",
  "gscdn.net",
  "navercdn.com",
  "pstatic.net",
]);
assert.equal(policy.resourceTypes.includes("other"), true);

console.log("manifest and MV2 required-permission CHZZK redirect policy are valid");
