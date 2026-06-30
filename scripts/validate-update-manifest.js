import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const updatesPath = process.env.UPDATE_MANIFEST ?? "dist/update-site/updates.json";
const signedXpi = process.env.SIGNED_XPI ?? `dist/chzzk-${packageJson.version}-signed.xpi`;

const addonId = manifest.browser_specific_settings?.gecko?.id;
const updateUrl = manifest.browser_specific_settings?.gecko?.update_url;
const updates = JSON.parse(readFileSync(updatesPath, "utf8"));
const update = updates.addons?.[addonId]?.updates?.[0];

assert.equal(
  updateUrl,
  "https://alpha-apple.dedyn.io/chzzk/updates.json",
  "manifest update_url must be the internal HTTPS update manifest",
);
assert.ok(update, `updates.json must include ${addonId}`);
assert.equal(update.version, packageJson.version, "update entry version must match package.json");
assert.match(
  update.update_link,
  /^https:\/\/alpha-apple\.dedyn\.io\/chzzk\/chzzk-[^/]+-signed\.xpi$/,
  "update_link must point at the internally hosted signed XPI",
);
assert.equal(
  update.update_hash,
  `sha256:${createHash("sha256").update(readFileSync(signedXpi)).digest("hex")}`,
);
assert.equal(
  update.applications?.gecko?.strict_min_version,
  manifest.browser_specific_settings?.gecko?.strict_min_version,
  "update manifest must preserve Firefox strict_min_version",
);

console.log("Firefox update manifest is valid");
