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

const FIREFOX_VERSION = "152.0.6";
const GECKODRIVER_VERSION = "0.37.0";
const MAX_FIREFOX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_GECKODRIVER_ARCHIVE_BYTES = 32 * 1024 * 1024;
const platform = {
  arm64: {
    firefoxArch: "linux-aarch64",
    firefoxSha512:
      "774a05b4512bb25c32a242f023803fdd8c36411dc618a7a352aca683cb9c7222dd71206fe253ed95511c758c90e6191a17b3dfe1a15a40d6d7efd3a543a377e9",
    geckodriverAsset: `geckodriver-v${GECKODRIVER_VERSION}-linux-aarch64.tar.gz`,
    geckodriverSha256: "a16bc29598e1776da78b45dc78a6aa876abe125f5d82a5c8b9d7366204ad4158",
  },
  x64: {
    firefoxArch: "linux-x86_64",
    firefoxSha512:
      "414b060f5e28e1b9c8818dee51896a81bd273c6cf6a4cffa53c4d7214f2c1d26d0416b9088518294435a7ead014a320a8deb910e93f3345ab6fbbbe596b4a336",
    geckodriverAsset: `geckodriver-v${GECKODRIVER_VERSION}-linux64.tar.gz`,
    geckodriverSha256: "90d4e33bd9816684400c160d1309aaffec23a3f65103511d5a62d8501062e548",
  },
}[process.arch];

if (!platform || process.platform !== "linux") {
  throw new Error(
    `Stock Firefox signed-smoke setup supports Linux x64/arm64 only, got ${process.platform}/${process.arch}`,
  );
}

const toolsDir = resolve(process.env.CHZZK_SIGNED_SMOKE_TOOLS_DIR ?? "dist/signed-smoke-tools");
const downloadsDir = join(toolsDir, "downloads");
const firefoxDir = join(toolsDir, "firefox");
const firefoxArchive = join(downloadsDir, `firefox-${FIREFOX_VERSION}-${platform.firefoxArch}.tar.xz`);
const geckodriverArchive = join(downloadsDir, platform.geckodriverAsset);
const geckodriverPath = join(toolsDir, "geckodriver");
const firefoxUrl = `https://archive.mozilla.org/pub/firefox/releases/${FIREFOX_VERSION}/${platform.firefoxArch}/en-US/firefox-${FIREFOX_VERSION}.tar.xz`;
const geckodriverUrl = `https://github.com/mozilla/geckodriver/releases/download/v${GECKODRIVER_VERSION}/${platform.geckodriverAsset}`;

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
    headers: { "user-agent": "CHZZK-stock-Firefox-signed-smoke-setup/1" },
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
  expectedDigest: platform.firefoxSha512,
  maxBytes: MAX_FIREFOX_ARCHIVE_BYTES,
  path: firefoxArchive,
  url: firefoxUrl,
});
await downloadVerified({
  algorithm: "sha256",
  expectedDigest: platform.geckodriverSha256,
  maxBytes: MAX_GECKODRIVER_ARCHIVE_BYTES,
  path: geckodriverArchive,
  url: geckodriverUrl,
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
    firefoxVersion: FIREFOX_VERSION,
    geckodriver: geckodriverPath,
    geckodriverVersion: GECKODRIVER_VERSION,
  }),
);
