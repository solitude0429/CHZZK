#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateUpdateManifestDocument } from "./lib/update-manifest.js";

try {
  if (
    !process.env.CHZZK_RELEASE_METADATA ||
    !process.env.CHZZK_SIGNED_XPI ||
    !process.env.CHZZK_UPDATE_MANIFEST
  ) {
    throw new Error("CHZZK_RELEASE_METADATA, CHZZK_SIGNED_XPI, and CHZZK_UPDATE_MANIFEST are required");
  }
  const metadata = JSON.parse(readFileSync(resolve(process.env.CHZZK_RELEASE_METADATA), "utf8"));
  const signedXpiBytes = readFileSync(resolve(process.env.CHZZK_SIGNED_XPI));
  const document = JSON.parse(readFileSync(resolve(process.env.CHZZK_UPDATE_MANIFEST), "utf8"));
  const expectedSignedXpiSha256 = createHash("sha256").update(signedXpiBytes).digest("hex");
  const result = validateUpdateManifestDocument(document, {
    expectedMetadata: metadata,
    expectedSignedXpiSha256,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Update manifest validation failed: ${error.message}`);
  process.exitCode = 1;
}
