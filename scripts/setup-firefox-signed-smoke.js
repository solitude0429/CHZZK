#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadCompatibilityPolicy, resolveSignedSmokeToolchain } from "./lib/compatibility-policy.js";

const MAX_FIREFOX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_GECKODRIVER_ARCHIVE_BYTES = 32 * 1024 * 1024;
const profileName = process.env.CHZZK_SIGNED_SMOKE_PROFILE ?? "current";
const policy = loadCompatibilityPolicy();
const toolchain = resolveSignedSmokeToolchain(policy, {
  architecture: process.arch,
  profileName,
});
if (
  !toolchain.firefoxUrl.startsWith("https://archive.mozilla.org/pub/firefox/releases/") ||
  !toolchain.geckodriverUrl.startsWith("https://github.com/mozilla/geckodriver/releases/download/")
) {
  throw new Error("Signed-smoke tool URLs escaped the canonical download roots");
}

if (process.platform !== "linux") {
  throw new Error(
    `Stock Firefox signed-smoke setup supports Linux x64/arm64 only, got ${process.platform}/${process.arch}`,
  );
}

const toolsDir = resolve(process.env.CHZZK_SIGNED_SMOKE_TOOLS_DIR ?? "dist/signed-smoke-tools");
const downloadsDir = join(toolsDir, "downloads");
const firefoxDir = join(toolsDir, "firefox");
const firefoxArchive = join(
  downloadsDir,
  `firefox-${toolchain.firefoxVersion}-${toolchain.firefoxArch}.tar.xz`,
);
const geckodriverArchive = join(downloadsDir, toolchain.geckodriverAsset);
const geckodriverPath = join(toolsDir, "geckodriver");

function digest(path, algorithm) {
  return createHash(algorithm).update(readFileSync(path)).digest("hex");
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function readBoundedDownload(response, maxBytes, url) {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(rawLength)) {
      await response.body?.cancel();
      throw new Error(`Download returned an invalid Content-Length for ${url}`);
    }
    const contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > maxBytes) {
      await response.body?.cancel();
      throw new Error(`Download size limit exceeded for ${url}`);
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error(`Download did not provide a readable stream for ${url}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    let streamComplete = false;
    while (!streamComplete) {
      const { done, value } = await reader.read();
      if (done) {
        streamComplete = true;
        continue;
      }
      if (!(value instanceof Uint8Array)) throw new Error(`Download stream was invalid for ${url}`);
      totalBytes += value.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`Download size limit exceeded for ${url}`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes <= 0) throw new Error(`Download was empty for ${url}`);
  return Buffer.concat(chunks, totalBytes);
}

async function downloadVerified({ algorithm, expectedDigest, maxBytes, path, url }) {
  try {
    const stat = lstatSync(path);
    if (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size > 0 &&
      stat.size <= maxBytes &&
      digest(path, algorithm) === expectedDigest
    ) {
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  rmSync(path, { force: true });

  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`Refusing non-HTTPS tool URL: ${url}`);
  const response = await fetch(url, {
    headers: { "user-agent": "CHZZK-stock-Firefox-signed-smoke-setup/2" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const bytes = await readBoundedDownload(response, maxBytes, url);
  const actualDigest = createHash(algorithm).update(bytes).digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new Error(`Checksum mismatch for ${url}: expected ${expectedDigest}, got ${actualDigest}`);
  }

  const temporaryPath = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporaryPath, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

mkdirSync(downloadsDir, { mode: 0o755, recursive: true });
await downloadVerified({
  algorithm: "sha512",
  expectedDigest: toolchain.firefoxSha512,
  maxBytes: MAX_FIREFOX_ARCHIVE_BYTES,
  path: firefoxArchive,
  url: toolchain.firefoxUrl,
});
await downloadVerified({
  algorithm: "sha256",
  expectedDigest: toolchain.geckodriverSha256,
  maxBytes: MAX_GECKODRIVER_ARCHIVE_BYTES,
  path: geckodriverArchive,
  url: toolchain.geckodriverUrl,
});

rmSync(firefoxDir, { force: true, recursive: true });
mkdirSync(firefoxDir, { mode: 0o755, recursive: true });
run("tar", ["-xJf", firefoxArchive, "-C", firefoxDir, "--strip-components=1"]);
rmSync(geckodriverPath, { force: true });
run("tar", ["-xzf", geckodriverArchive, "-C", toolsDir, "geckodriver"]);
chmodSync(geckodriverPath, 0o755);

const firefoxPath = join(firefoxDir, "firefox");
for (const path of [firefoxPath, geckodriverPath]) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error(`Signed-smoke tool is not a regular executable: ${path}`);
  }
}

console.log(
  JSON.stringify({
    firefox: firefoxPath,
    firefoxVersion: toolchain.firefoxVersion,
    geckodriver: geckodriverPath,
    geckodriverVersion: toolchain.geckodriverVersion,
    profile: profileName,
  }),
);
