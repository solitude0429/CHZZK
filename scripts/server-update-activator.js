#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { deployUpdateRelease } from "./lib/update-deployment.js";
import { canonicalReleaseAssetNames } from "./lib/release-artifacts.js";

const DEFAULT_TARGET = "/srv/admin/chzzk-updates";
const CURL_CANDIDATES = Object.freeze(["/run/current-system/sw/bin/curl", "/usr/bin/curl"]);
const MAX_HTTP_BYTES = 16 * 1024 * 1024;
const VERSION_RE = /^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.includes("\0")) {
      throw new Error("Server activator arguments must be --name value pairs");
    }
    if (values.has(name)) throw new Error(`Duplicate server activator argument: ${name}`);
    values.set(name, value);
  }
  const expected = ["--metadata", "--mode", "--signed", "--source"];
  for (const name of expected) {
    if (!values.has(name)) throw new Error(`Missing server activator argument: ${name}`);
  }
  for (const name of values.keys()) {
    if (![...expected, "--target"].includes(name)) {
      throw new Error(`Unknown server activator argument: ${name}`);
    }
  }
  return {
    metadataPath: values.get("--metadata"),
    mode: values.get("--mode"),
    signedXpiPath: values.get("--signed"),
    sourceArchivePath: values.get("--source"),
    targetDir: values.get("--target") ?? DEFAULT_TARGET,
  };
}

function parseVersion(value, label) {
  if (!VERSION_RE.test(String(value ?? ""))) throw new Error(`${label} is not canonical`);
  return String(value);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left, "target version").split(".").map(Number);
  const rightParts = parseVersion(right, "current version").split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function currentVersion(targetDir) {
  const currentPath = resolve(targetDir, "current");
  try {
    const metadata = lstatSync(currentPath);
    if (!metadata.isSymbolicLink()) throw new Error("Current deployment path is not a managed link");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const target = readlinkSync(currentPath);
  const match = /^releases\/((?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2})$/.exec(target);
  if (!match) throw new Error("Current deployment link has an invalid target");
  return parseVersion(match[1], "current version");
}

export function validateServerTransition(
  { mode, targetDir, version },
  { readCurrentVersion = currentVersion } = {},
) {
  if (!new Set(["deploy", "rollback"]).has(mode)) {
    throw new Error("Server activation mode must be deploy or rollback");
  }
  const targetVersion = parseVersion(version, "target version");
  const activeVersion = readCurrentVersion(targetDir);
  if (mode === "rollback") {
    if (!activeVersion || compareVersions(targetVersion, activeVersion) >= 0) {
      throw new Error("Rollback target must be older than the active deployment");
    }
  } else if (activeVersion && compareVersions(targetVersion, activeVersion) < 0) {
    throw new Error("An older target requires explicit rollback mode");
  }
}

function canonicalRegularFile(path, label) {
  const absolute = resolve(path);
  if (absolute !== path || path.includes("\0")) {
    throw new Error(`${label} must be one absolute canonical path`);
  }
  const canonical = realpathSync(path);
  if (canonical !== absolute) throw new Error(`${label} must not traverse symbolic links`);
  const metadata = statSync(canonical);
  if (!metadata.isFile() || (metadata.mode & 0o022) !== 0) {
    throw new Error(`${label} must be a protected regular file`);
  }
  return canonical;
}

function protectedCurl() {
  const path = CURL_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("A protected system curl executable is required for activation validation");
  const canonical = realpathSync(path);
  const metadata = statSync(canonical);
  if (!metadata.isFile() || (metadata.mode & 0o022) !== 0 || (metadata.mode & 0o111) === 0) {
    throw new Error("The activation validation curl executable is not protected");
  }
  return canonical;
}

function curl(curlPath, args, { binary = false } = {}) {
  const result = spawnSync(curlPath, ["--fail", "--silent", "--show-error", "--max-time", "15", ...args], {
    encoding: binary ? undefined : "utf8",
    env: {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/run/current-system/sw/bin:/usr/bin:/bin",
    },
    maxBuffer: MAX_HTTP_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || "HTTP validation failed").trim();
    throw new Error(`Activation HTTP validation failed: ${detail}`);
  }
  return binary ? Buffer.from(result.stdout) : String(result.stdout).trim();
}

function assertHttpRepresentation(curlPath, baseUrl, relativePath, expectedBytes, expectedMime) {
  const url = new URL(relativePath, baseUrl).toString();
  const contentType = curl(curlPath, ["--output", "/dev/null", "--write-out", "%{content_type}", url]);
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== expectedMime) {
    throw new Error(`Activation HTTP MIME mismatch for ${url}: ${contentType}`);
  }
  const actualBytes = curl(curlPath, [url], { binary: true });
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error(`Activation HTTP bytes differ from the deployed file: ${url}`);
  }
}

export async function validateServerActivation(
  { metadata, signedXpiSha256, targetDir },
  { curlPath = protectedCurl(), request = assertHttpRepresentation } = {},
) {
  const names = canonicalReleaseAssetNames(metadata.version);
  const expectedUpdateBytes = readFileSync(resolve(targetDir, "updates.json"));
  const expectedXpiBytes = readFileSync(resolve(targetDir, "current", names.signed));
  if (sha256(expectedXpiBytes) !== signedXpiSha256) {
    throw new Error("Activated signed XPI digest differs from the verified deployment digest");
  }

  for (const baseUrl of ["http://127.0.0.1:18082", "https://chzzk.home.arpa:8443"]) {
    request(curlPath, baseUrl, "/updates.json", expectedUpdateBytes, "application/json");
    request(
      curlPath,
      baseUrl,
      `/releases/${metadata.version}/${names.signed}`,
      expectedXpiBytes,
      "application/x-xpinstall",
    );
  }
}

export async function activateServerUpdate(input) {
  if (!new Set(["deploy", "rollback"]).has(input.mode)) {
    throw new Error("Server activation mode must be deploy or rollback");
  }
  if ((input.targetDir ?? DEFAULT_TARGET) !== DEFAULT_TARGET) {
    throw new Error("Server activation target must be the canonical update directory");
  }
  const paths = {
    metadataPath: canonicalRegularFile(input.metadataPath, "Release metadata"),
    signedXpiPath: canonicalRegularFile(input.signedXpiPath, "Signed XPI"),
    sourceArchivePath: canonicalRegularFile(input.sourceArchivePath, "Source archive"),
  };
  const parent = dirname(paths.metadataPath);
  if ([paths.signedXpiPath, paths.sourceArchivePath].some((path) => dirname(path) !== parent)) {
    throw new Error("Server activation inputs must share one private staging directory");
  }
  if (new Set(Object.values(paths).map((path) => basename(path))).size !== 3) {
    throw new Error("Server activation input filenames must be distinct");
  }
  return deployUpdateRelease({
    ...paths,
    targetDir: DEFAULT_TARGET,
    validateActivation: validateServerActivation,
    validateTransition: ({ targetDir, version }) =>
      validateServerTransition({ mode: input.mode, targetDir, version }),
  });
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    const result = await activateServerUpdate(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Server update activation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
