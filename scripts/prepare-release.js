#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareReleaseArtifacts } from "./lib/release-artifacts.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));

function repositoryName() {
  if (process.env.CHZZK_SOURCE_REPOSITORY) return process.env.CHZZK_SOURCE_REPOSITORY;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const repository =
    typeof packageJson.repository === "string" ? packageJson.repository : packageJson.repository?.url;
  const match = String(repository ?? "").match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (!match) throw new Error("Unable to determine source repository; set CHZZK_SOURCE_REPOSITORY");
  return match[1];
}

function gitOutput(args) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
}

function sourceDigest() {
  const configured = process.env.CHZZK_SOURCE_DIGEST ?? process.env.GITHUB_SHA;
  return configured ? configured.trim() : gitOutput(["rev-parse", "HEAD"]);
}

function assertCleanSourceTree(expectedDigest) {
  const head = gitOutput(["rev-parse", "HEAD"]);
  if (head !== expectedDigest) {
    throw new Error(`Prepared source digest ${expectedDigest} does not match checked-out HEAD ${head}`);
  }
  const status = gitOutput(["status", "--porcelain=v1", "--untracked-files=no"]);
  if (status) throw new Error("Release preparation requires a clean tracked source tree");
}

try {
  const outputDir = resolve(process.env.CHZZK_RELEASE_OUTPUT_DIR ?? resolve(rootDir, "dist/release"));
  const expectedSourceDigest = sourceDigest();
  assertCleanSourceTree(expectedSourceDigest);
  const result = await prepareReleaseArtifacts({
    outputDir,
    rootDir,
    sourceDigest: expectedSourceDigest,
    sourceRepository: repositoryName(),
  });
  console.log(
    JSON.stringify({
      metadataPath: result.metadataPath,
      sourceArchivePath: result.sourceArchivePath,
      version: result.metadata.version,
    }),
  );
} catch (error) {
  console.error(`Release preparation failed: ${error.message}`);
  process.exitCode = 1;
}
