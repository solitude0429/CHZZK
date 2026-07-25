#!/usr/bin/env node
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");
export const EXTENSION_PACKAGE_FILES = Object.freeze([
  "LICENSE",
  "NOTICE",
  "README.md",
  "background.js",
  "diagnostics.html",
  "diagnostics.js",
  "icon-32.png",
  "icon-48.png",
  "icon-96.png",
  "icon.png",
  "manifest.json",
  "site-observer.js",
]);

function readRegularFile(relativePath) {
  const absolutePath = join(ROOT, relativePath);
  const stat = lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Extension package input must be a regular file: ${relativePath}`);
  }
  const bytes = readFileSync(absolutePath);
  if (bytes.length === 0) throw new Error(`Extension package input must not be empty: ${relativePath}`);
  return bytes;
}

export async function buildExtensionPackage({ outputDir = join(ROOT, "dist") } = {}) {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const version = String(packageJson.version ?? "");
  if (!/^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(version)) {
    throw new Error("Extension package version is not canonical");
  }

  const zip = new JSZip();
  for (const relativePath of EXTENSION_PACKAGE_FILES) {
    zip.file(relativePath, readRegularFile(relativePath), {
      binary: true,
      createFolders: false,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }
  const bytes = await zip.generateAsync({
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
    type: "nodebuffer",
  });
  mkdirSync(outputDir, { mode: 0o755, recursive: true });
  const outputPath = join(outputDir, `chzzk-${version}.zip`);
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, outputPath);
    chmodSync(outputPath, 0o644);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return outputPath;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const outputPath = await buildExtensionPackage();
    console.log(`built ${outputPath}`);
  } catch (error) {
    console.error(`Extension package build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
