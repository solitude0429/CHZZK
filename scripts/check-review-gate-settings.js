#!/usr/bin/env node
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TRUSTED_SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";
const GH_CANDIDATES = ["/usr/local/bin/gh", "/usr/bin/gh", "/bin/gh"];
const AMBIENT_CREDENTIALS = [
  "CHZZK_RELEASE_ADMIN_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
];
const REQUIRED_ENVIRONMENT_NAMES = [
  "CHZZK_AUTOMATED_REVIEW_LOGIN",
  "CHZZK_GITHUB_REPOSITORY",
  "CHZZK_RELEASE_OPERATOR_LOGIN",
];

function requiredString(source, name) {
  const value = source?.[name];
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} is required and must be a single-line value`);
  }
  return value.trim();
}

export function trustedGhExecutable(candidates = GH_CANDIDATES) {
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate);
      const metadata = statSync(path);
      if (
        metadata.isFile() &&
        metadata.uid === 0 &&
        (metadata.mode & 0o022) === 0 &&
        (metadata.mode & 0o111) !== 0
      ) {
        return path;
      }
    } catch {
      // Try the next fixed system path.
    }
  }
  throw new Error("No root-owned, non-writable system gh executable is available");
}

export function createReviewGateAuditEnvironment(source, privateRoot, ghExecutable) {
  const token = requiredString(source, "CHZZK_REVIEW_GATE_AUDIT_TOKEN");
  if (token.length > 4096) throw new Error("CHZZK_REVIEW_GATE_AUDIT_TOKEN is unreasonably large");
  for (const name of AMBIENT_CREDENTIALS) {
    if (typeof source?.[name] === "string" && source[name]) {
      throw new Error(`${name} must be unset; use only the dedicated read-only audit token`);
    }
  }
  if (typeof privateRoot !== "string" || privateRoot !== resolve(privateRoot)) {
    throw new Error("Review-gate audit private root must be one canonical absolute path");
  }
  const rootMetadata = statSync(privateRoot);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : rootMetadata.uid;
  if (!rootMetadata.isDirectory() || rootMetadata.uid !== currentUid || (rootMetadata.mode & 0o077) !== 0) {
    throw new Error("Review-gate audit private root must be operator-owned and mode 0700");
  }
  if (typeof ghExecutable !== "string" || ghExecutable !== resolve(ghExecutable)) {
    throw new Error("Review-gate audit gh executable must be one canonical absolute path");
  }

  const environment = {
    CHZZK_GH_COMMAND: ghExecutable,
    CHZZK_REVIEW_GATE_AUDIT: "true",
    GH_CONFIG_DIR: join(privateRoot, "config"),
    GH_HOST: "github.com",
    GH_PAGER: "cat",
    GH_PROMPT_DISABLED: "1",
    GH_TOKEN: token,
    GITHUB_ACTIONS: "false",
    HOME: privateRoot,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: TRUSTED_SYSTEM_PATH,
    XDG_CACHE_HOME: join(privateRoot, "cache"),
  };
  for (const name of REQUIRED_ENVIRONMENT_NAMES) {
    environment[name] = requiredString(source, name);
  }
  return Object.freeze(environment);
}

export function validateReviewGateAuditProcess(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Review-gate audit process result is missing");
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`Review-gate settings inspection failed: ${detail || `exit ${result.status}`}`);
  }

  let report;
  try {
    report = JSON.parse(String(result.stdout ?? "").trim());
  } catch {
    throw new Error("Review-gate settings inspection returned malformed JSON");
  }
  if (
    report?.applied !== false ||
    typeof report.exact !== "boolean" ||
    !Array.isArray(report.plannedChanges)
  ) {
    throw new Error("Review-gate settings inspection returned an invalid report");
  }
  if (!report.exact || report.plannedChanges.length !== 0) {
    throw new Error(`Review-gate repository settings drifted: ${JSON.stringify(report.plannedChanges)}`);
  }
  return report;
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  let privateRoot = null;
  try {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error("Review-gate settings require an Actions-external read-only credential");
    }
    const ghExecutable = trustedGhExecutable();
    privateRoot = mkdtempSync(join(tmpdir(), "chzzk-review-gate-audit-"));
    chmodSync(privateRoot, 0o700);
    mkdirSync(join(privateRoot, "cache"), { mode: 0o700 });
    mkdirSync(join(privateRoot, "config"), { mode: 0o700 });

    const configureScript = fileURLToPath(new URL("./configure-review-gate.js", import.meta.url));
    const result = spawnSync(process.execPath, [configureScript], {
      encoding: "utf8",
      env: createReviewGateAuditEnvironment(process.env, privateRoot, ghExecutable),
    });
    const report = validateReviewGateAuditProcess(result);
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(`Review-gate settings audit failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (privateRoot) rmSync(privateRoot, { force: true, recursive: true });
  }
}
