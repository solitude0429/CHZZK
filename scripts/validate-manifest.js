import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { buildScopedSessionRule } from "../src/shared/session-rules.js";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const policy = JSON.parse(await readFile(new URL("../policy/quality-policy.json", import.meta.url), "utf8"));

assert.equal(manifest.manifest_version, 3, "manifest_version must be 3");
assert.equal(manifest.name, "CHZZK", "extension name must be CHZZK");
assert.equal(manifest.description, undefined, "manifest description should be omitted from about:addons");
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
assert.ok(
  manifest.permissions.includes("webRequestBlocking"),
  "webRequestBlocking permission is required to redirect the first observed HLS playlist request",
);
assert.ok(!manifest.permissions.includes("scripting"), "scripting permission must not be needed");
assert.deepEqual(
  manifest.content_scripts,
  [
    {
      matches: ["https://chzzk.naver.com/live/*"],
      js: ["site-observer.js"],
      run_at: "document_start",
    },
  ],
  "content script must be scoped to CHZZK live pages only",
);
assert.equal(
  manifest.declarative_net_request,
  undefined,
  "global static DNR rulesets are forbidden; use tab-scoped session rules instead",
);
assert.equal(existsSync(new URL("../rules.json", import.meta.url)), false, "rules.json must not exist");
assert.deepEqual(
  manifest.host_permissions,
  ["https://*.akamaized.net/*", "https://*.gscdn.net/*", "https://*.navercdn.com/*", "https://*.pstatic.net/*"],
  "host permissions must be limited to the trusted HLS CDN origins that webRequest/DNR need",
);
assert.equal(
  manifest.host_permissions.some((permission) => permission.includes("chzzk.naver.com")),
  false,
  "CHZZK page access must be declared only once via content_scripts.matches, not duplicated in host_permissions",
);
assert.equal(
  manifest.host_permissions.some((permission) => permission.includes("chzzk-report")),
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
assert.deepEqual(
  manifest.action?.default_icon,
  { 32: "icon-32.png", 48: "icon-48.png", 96: "icon-96.png", 128: "icon.png" },
  "action icon sizes must use size-matched CHZZK favicon PNGs",
);
assert.equal(manifest.action?.default_popup, "diagnostics.html", "diagnostics popup must be registered");

const sampleRule = buildScopedSessionRule({ policy, tabId: 1 });
assert.deepEqual(sampleRule.condition.tabIds, [1], "session rule must be scoped to one tab");
assert.deepEqual(sampleRule.condition.initiatorDomains, ["chzzk.naver.com"]);
assert.deepEqual(sampleRule.condition.requestDomains, ["akamaized.net", "gscdn.net", "navercdn.com", "pstatic.net"]);
assert.equal(sampleRule.condition.regexFilter.includes("360p|480p|720p"), false);

console.log("manifest and session-scoped CHZZK redirect policy are valid");
