#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FIREFOX_VERSION = "153.0b12";
const GECKODRIVER_VERSION = "0.37.0";
const MAX_FIREFOX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_GECKODRIVER_ARCHIVE_BYTES = 32 * 1024 * 1024;
const platform = {
  arm64: {
    firefoxArch: "linux-aarch64",
    firefoxSha512:
      "d36edb7c4925b236ef825101ae56e245032fa7dea3ec9fe5c6638f6ce5aafb3d55dba111e17fffd3aee38da4cf35879f1d77f4a19f1e32376cfba6d0b99f2d6f",
    geckodriverAsset: `geckodriver-v${GECKODRIVER_VERSION}-linux-aarch64.tar.gz`,
    geckodriverSha256: "a16bc29598e1776da78b45dc78a6aa876abe125f5d82a5c8b9d7366204ad4158",
  },
  x64: {
    firefoxArch: "linux-x86_64",
    firefoxSha512:
      "0d1bebff153339957f3bb6417fcaff64a9e1486da921714d67a07ae51670e3c6af2626919536960941c6e025193f7ab19c73f59deb97c7b56a8ebb3360a16e9b",
    geckodriverAsset: `geckodriver-v${GECKODRIVER_VERSION}-linux64.tar.gz`,
    geckodriverSha256: "90d4e33bd9816684400c160d1309aaffec23a3f65103511d5a62d8501062e548",
  },
}[process.arch];

if (!platform || process.platform !== "linux") {
  throw new Error(`Firefox E2E setup supports Linux x64/arm64 only, got ${process.platform}/${process.arch}`);
}

const toolsDir = resolve(process.env.CHZZK_E2E_TOOLS_DIR ?? "dist/e2e-tools");
const downloadsDir = join(toolsDir, "downloads");
const firefoxDir = join(toolsDir, "firefox");
const firefoxArchive = join(downloadsDir, `firefox-${FIREFOX_VERSION}-${platform.firefoxArch}.tar.xz`);
const geckodriverArchive = join(downloadsDir, platform.geckodriverAsset);
const geckodriverPath = join(toolsDir, "geckodriver");
const firefoxUrl = `https://archive.mozilla.org/pub/devedition/releases/${FIREFOX_VERSION}/${platform.firefoxArch}/en-US/firefox-${FIREFOX_VERSION}.tar.xz`;
const geckodriverUrl = `https://github.com/mozilla/geckodriver/releases/download/v${GECKODRIVER_VERSION}/${platform.geckodriverAsset}`;

function digest(path, algorithm) {
  return createHash(algorithm).update(readFileSync(path)).digest("hex");
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
    if (digest(path, algorithm) === expectedDigest) return;
  } catch {
    // Best-effort removal only; a later checksum/extraction step still fails closed.
  }

  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`Refusing non-HTTPS E2E tool URL: ${url}`);
  const response = await fetch(url, { headers: { "user-agent": "CHZZK-Firefox-E2E-setup/1" } });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const bytes = await readBoundedDownload(response, maxBytes, url);
  const actualDigest = createHash(algorithm).update(bytes).digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new Error(`Checksum mismatch for ${url}: expected ${expectedDigest}, got ${actualDigest}`);
  }
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
  renameSync(temporaryPath, path);
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

console.log(
  JSON.stringify({
    firefox: join(firefoxDir, "firefox"),
    firefoxVersion: FIREFOX_VERSION,
    geckodriver: geckodriverPath,
    geckodriverVersion: GECKODRIVER_VERSION,
  }),
);
