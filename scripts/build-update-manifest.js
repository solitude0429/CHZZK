import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

const version = packageJson.version;
const addonId = manifest.browser_specific_settings?.gecko?.id;
const strictMinVersion = manifest.browser_specific_settings?.gecko?.strict_min_version;
const defaultReleaseBaseUrl = `https://chzzk-updates.alpha-apple.dedyn.io`;

assert.ok(addonId, "manifest must define browser_specific_settings.gecko.id");
assert.ok(strictMinVersion, "manifest must define browser_specific_settings.gecko.strict_min_version");

function findSignedXpi() {
  if (process.env.SIGNED_XPI) return process.env.SIGNED_XPI;

  const preferred = `dist/chzzk-${version}-signed.xpi`;
  try {
    readFileSync(preferred);
    return preferred;
  } catch {
    // Fall through.
  }

  const signedDir = "dist/signed";
  const candidates = readdirSync(signedDir)
    .filter((name) => name.endsWith(".xpi"))
    .map((name) => join(signedDir, name));
  assert.equal(candidates.length, 1, "expected exactly one signed XPI in dist/signed or SIGNED_XPI");
  return candidates[0];
}

const signedXpi = findSignedXpi();
const signedXpiBytes = readFileSync(signedXpi);
const signedXpiName = basename(signedXpi);
const releaseBaseUrl = process.env.RELEASE_BASE_URL ?? defaultReleaseBaseUrl;
const updateLink = process.env.UPDATE_LINK ?? `${releaseBaseUrl}/${signedXpiName}`;

assert.match(updateLink, /^https:\/\//, "update_link must use HTTPS");
assert.equal(signedXpiName, `chzzk-${version}-signed.xpi`, "signed XPI must use the release asset name");

const updateManifest = {
  addons: {
    [addonId]: {
      updates: [
        {
          version,
          update_link: updateLink,
          update_hash: `sha256:${createHash("sha256").update(signedXpiBytes).digest("hex")}`,
          applications: {
            gecko: {
              strict_min_version: strictMinVersion,
            },
          },
        },
      ],
    },
  },
};

const outputDir = process.env.UPDATE_SITE_DIR ?? "dist/update-site";
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "updates.json"), `${JSON.stringify(updateManifest, null, 2)}\n`);
writeFileSync(
  join(outputDir, "index.html"),
  `<!doctype html>\n<meta charset="utf-8">\n<title>CHZZK extension updates</title>\n<p>Firefox update manifest: <a href="updates.json">updates.json</a></p>\n`,
);
console.log(`wrote ${join(outputDir, "updates.json")}`);
console.log(`update_link=${updateLink}`);
