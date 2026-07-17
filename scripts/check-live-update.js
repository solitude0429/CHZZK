#!/usr/bin/env node
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import { checkLiveUpdate } from "./lib/live-update-health.js";
import { canonicalReleaseAssetNames, verifySignedReleaseStructure } from "./lib/release-artifacts.js";

let verificationDirectory = null;
try {
  const productionManifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(new URL("../manifest.json", import.meta.url)),
    ),
  );
  const result = await checkLiveUpdate({ productionManifest });
  const names = canonicalReleaseAssetNames(result.version);
  verificationDirectory = mkdtempSync(join(tmpdir(), "chzzk-live-update-"));
  chmodSync(verificationDirectory, 0o700);

  const metadataPath = join(verificationDirectory, names.metadata);
  const signedXpiPath = join(verificationDirectory, names.signed);
  const sourceArchivePath = join(verificationDirectory, names.source);
  writeFileSync(metadataPath, result.assets.metadataBytes, { flag: "wx", mode: 0o600 });
  writeFileSync(signedXpiPath, result.assets.signedXpiBytes, { flag: "wx", mode: 0o600 });
  writeFileSync(sourceArchivePath, result.assets.sourceArchiveBytes, {
    flag: "wx",
    mode: 0o600,
  });

  const verified = await verifySignedReleaseStructure({
    metadataPath,
    signedXpiPath,
    sourceArchivePath,
  });
  if (
    verified.version !== result.version ||
    verified.signedXpiSha256 !== result.signedXpiSha256 ||
    verified.sourceArchiveSha256 !== result.sourceArchiveSha256
  ) {
    throw new Error("Hosted release structure disagrees with the live update health result");
  }

  console.log(
    JSON.stringify({
      manifestBytes: result.manifestBytes,
      metadataBytes: result.metadataBytes,
      signedXpiBytes: result.signedXpiBytes,
      signedXpiSha256: result.signedXpiSha256,
      sourceArchiveBytes: result.sourceArchiveBytes,
      sourceArchiveSha256: result.sourceArchiveSha256,
      sourceDigest: verified.sourceDigest,
      structuralVerification: verified.verification,
      version: result.version,
    }),
  );
} catch (error) {
  console.error(`Live update health check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (verificationDirectory) {
    rmSync(verificationDirectory, { force: true, recursive: true });
  }
}
