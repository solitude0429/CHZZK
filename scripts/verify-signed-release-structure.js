#!/usr/bin/env node
import { resolve } from "node:path";

import { verifySignedReleaseStructure } from "./lib/release-artifacts.js";

try {
  const metadataPath = resolve(process.env.CHZZK_RELEASE_METADATA ?? "");
  const signedXpiPath = resolve(process.env.CHZZK_SIGNED_XPI ?? "");
  const sourceArchivePath = resolve(process.env.CHZZK_UNSIGNED_XPI ?? "");
  if (
    !process.env.CHZZK_RELEASE_METADATA ||
    !process.env.CHZZK_SIGNED_XPI ||
    !process.env.CHZZK_UNSIGNED_XPI
  ) {
    throw new Error("CHZZK_RELEASE_METADATA, CHZZK_SIGNED_XPI, and CHZZK_UNSIGNED_XPI are required");
  }
  const verified = await verifySignedReleaseStructure({ metadataPath, signedXpiPath, sourceArchivePath });
  console.log(
    JSON.stringify({
      signedXpiSha256: verified.signedXpiSha256,
      signedXpiSize: verified.signedXpiSize,
      sourceDigest: verified.sourceDigest,
      verification: verified.verification,
      version: verified.version,
    }),
  );
} catch (error) {
  console.error(`Signed release structural verification failed: ${error.message}`);
  process.exitCode = 1;
}
