#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { inspectPreSignReleaseState } from "./lib/github-release-state.js";

try {
  const required = [
    "CHZZK_RELEASE_METADATA",
    "CHZZK_SIGNED_XPI",
    "CHZZK_SOURCE_ARCHIVE",
    "CHZZK_SOURCE_DIGEST",
    "CHZZK_VERSION",
    "GITHUB_OUTPUT",
    "GITHUB_REPOSITORY",
  ];
  for (const name of required) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  const result = await inspectPreSignReleaseState({
    metadataPath: resolve(process.env.CHZZK_RELEASE_METADATA),
    repository: process.env.GITHUB_REPOSITORY,
    signedXpiPath: resolve(process.env.CHZZK_SIGNED_XPI),
    sourceArchivePath: resolve(process.env.CHZZK_SOURCE_ARCHIVE),
    sourceSha: process.env.CHZZK_SOURCE_DIGEST,
    version: process.env.CHZZK_VERSION,
  });
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `draft_signed_ready=${result.draftSignedReady}`,
      `reuse_existing=${result.reuseExisting}`,
      `signed_sha256=${result.signedSha256}`,
      "",
    ].join("\n"),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Pre-sign release state inspection failed: ${error.message}`);
  process.exitCode = 1;
}
