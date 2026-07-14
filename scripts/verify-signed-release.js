#!/usr/bin/env node
import { resolve } from "node:path";

import { verifySignedReleaseArtifacts } from "./lib/release-artifacts.js";

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
  console.log(
    JSON.stringify(await verifySignedReleaseArtifacts({ metadataPath, signedXpiPath, sourceArchivePath })),
  );
} catch (error) {
  console.error(`Signed release verification failed: ${error.message}`);
  process.exitCode = 1;
}
