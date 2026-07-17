import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { assertReleaseMetadata, canonicalReleaseAssetNames } from "./release-artifacts.js";

const SHA256_RE = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(keys)) {
    throw new Error(`${label} has invalid schema keys: ${actual.join(", ")}`);
  }
}

function validateReleaseUpdateMetadata(metadata) {
  assertReleaseMetadata(metadata);
  if (typeof metadata.strictMinVersion !== "string" || !metadata.strictMinVersion) {
    throw new Error("Release metadata strict minimum Firefox version is missing");
  }
  const manifestUrl = new URL(metadata.updateManifestUrl);
  if (
    manifestUrl.protocol !== "https:" ||
    manifestUrl.username ||
    manifestUrl.password ||
    manifestUrl.search ||
    manifestUrl.hash ||
    manifestUrl.pathname !== "/updates.json"
  ) {
    throw new Error("Release metadata update manifest URL is not canonical");
  }
  return manifestUrl;
}

function canonicalSignedXpiUrl(metadata) {
  const manifestUrl = validateReleaseUpdateMetadata(metadata);
  return new URL(
    `/releases/${metadata.version}/chzzk-${metadata.version}-signed.xpi`,
    manifestUrl.origin,
  ).toString();
}

export function buildUpdateManifestDocument({ metadata, signedXpiBytes = null, signedXpiPath = null }) {
  if ((signedXpiBytes === null) === (signedXpiPath === null)) {
    throw new Error("Provide exactly one of signedXpiBytes or signedXpiPath");
  }
  validateReleaseUpdateMetadata(metadata);
  if (
    signedXpiPath !== null &&
    basename(signedXpiPath) !== canonicalReleaseAssetNames(metadata.version).signed
  ) {
    throw new Error("Signed XPI filename is not canonical for release metadata");
  }
  const bytes = signedXpiBytes === null ? readFileSync(signedXpiPath) : Buffer.from(signedXpiBytes);
  if (bytes.length === 0) throw new Error("Signed XPI is empty");
  return {
    addons: {
      [metadata.addOnId]: {
        updates: [
          {
            applications: {
              gecko: {
                strict_min_version: metadata.strictMinVersion,
              },
            },
            update_hash: `sha256:${sha256(bytes)}`,
            update_link: canonicalSignedXpiUrl(metadata),
            version: metadata.version,
          },
        ],
      },
    },
  };
}

export function validateUpdateManifestDocument(document, { expectedMetadata, expectedSignedXpiSha256 }) {
  validateReleaseUpdateMetadata(expectedMetadata);
  if (!SHA256_RE.test(String(expectedSignedXpiSha256 ?? ""))) {
    throw new Error("Expected signed XPI SHA-256 is invalid");
  }

  assertExactKeys(document, ["addons"], "Update manifest root");
  assertExactKeys(document.addons, [expectedMetadata.addOnId], "Update manifest add-ons");
  const addon = document.addons[expectedMetadata.addOnId];
  assertExactKeys(addon, ["updates"], "Update manifest add-on");
  if (!Array.isArray(addon.updates) || addon.updates.length !== 1) {
    throw new Error("Update manifest must contain exactly one update entry");
  }

  const update = addon.updates[0];
  assertExactKeys(update, ["applications", "update_hash", "update_link", "version"], "Update manifest entry");
  assertExactKeys(update.applications, ["gecko"], "Update manifest applications");
  assertExactKeys(update.applications.gecko, ["strict_min_version"], "Update manifest Gecko application");
  if (update.version !== expectedMetadata.version)
    throw new Error("Update version does not match release metadata");
  if (update.applications.gecko.strict_min_version !== expectedMetadata.strictMinVersion) {
    throw new Error("Update strict minimum Firefox version does not match release metadata");
  }
  if (update.update_hash !== `sha256:${expectedSignedXpiSha256}`) {
    throw new Error("Update hash does not match the signed XPI");
  }

  let updateUrl;
  try {
    updateUrl = new URL(update.update_link);
  } catch {
    throw new Error("Update URL is invalid");
  }
  if (
    updateUrl.protocol !== "https:" ||
    updateUrl.username ||
    updateUrl.password ||
    updateUrl.search ||
    updateUrl.hash ||
    updateUrl.toString() !== canonicalSignedXpiUrl(expectedMetadata)
  ) {
    throw new Error("Update URL is not canonical for the immutable release asset");
  }

  return { signedXpiSha256: expectedSignedXpiSha256, version: expectedMetadata.version };
}
