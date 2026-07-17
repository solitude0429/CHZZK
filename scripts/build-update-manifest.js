#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { buildUpdateManifestDocument, validateUpdateManifestDocument } from "./lib/update-manifest.js";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWrite(path, content) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Refusing to replace non-regular output: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  }
}

try {
  if (!process.env.CHZZK_RELEASE_METADATA || !process.env.CHZZK_SIGNED_XPI) {
    throw new Error("CHZZK_RELEASE_METADATA and CHZZK_SIGNED_XPI are required");
  }
  const metadataPath = resolve(process.env.CHZZK_RELEASE_METADATA);
  const signedXpiPath = resolve(process.env.CHZZK_SIGNED_XPI);
  const outputPath = resolve(process.env.CHZZK_UPDATE_MANIFEST_OUTPUT ?? "dist/updates.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const signedXpiSha256 = sha256(signedXpiPath);
  const document = buildUpdateManifestDocument({ metadata, signedXpiPath });
  validateUpdateManifestDocument(document, {
    expectedMetadata: metadata,
    expectedSignedXpiSha256: signedXpiSha256,
  });
  atomicWrite(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, signedXpiSha256, version: metadata.version }));
} catch (error) {
  console.error(`Update manifest build failed: ${error.message}`);
  process.exitCode = 1;
}
