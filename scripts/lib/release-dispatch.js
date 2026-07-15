import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assertCanonicalReleaseVersion } from "./release-version.js";

export const RELEASE_DISPATCH_EVENT_TYPE = "chzzk-release-preflight-v1";

const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_API_HEADERS = [
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2026-03-10",
];

function defaultRunCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown command failure").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function apiArgs(method, endpoint, extra = []) {
  return ["api", "--method", method, ...GITHUB_API_HEADERS, ...extra, endpoint];
}

function readBoundVersion(cwd) {
  const packageJson = parseJson(readFileSync(join(cwd, "package.json"), "utf8"), "package.json");
  const manifest = parseJson(readFileSync(join(cwd, "manifest.json"), "utf8"), "manifest.json");
  const version = assertCanonicalReleaseVersion(packageJson.version, "package.json version");
  if (manifest.version !== version) {
    throw new Error("package.json and manifest.json versions must match before release dispatch");
  }
  return version;
}

export async function dispatchReleaseFromAdminPreflight({
  cwd = process.cwd(),
  now = () => new Date(),
  repository,
  runCommand = defaultRunCommand,
}) {
  if (!REPOSITORY_RE.test(String(repository ?? ""))) {
    throw new Error("Release repository must use owner/repository form");
  }

  const repositoryState = parseJson(
    runCommand("gh", apiArgs("GET", `repos/${repository}`), { cwd }),
    "Repository lookup",
  );
  const defaultBranch = repositoryState.default_branch;
  if (typeof defaultBranch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(defaultBranch)) {
    throw new Error("Repository default branch is missing or malformed");
  }

  const remoteRef = parseJson(
    runCommand("gh", apiArgs("GET", `repos/${repository}/git/ref/heads/${defaultBranch}`), { cwd }),
    "Default-branch lookup",
  );
  const sourceSha = String(remoteRef?.object?.sha ?? "").toLowerCase();
  if (remoteRef?.object?.type !== "commit" || !FULL_GIT_SHA_RE.test(sourceSha)) {
    throw new Error("Repository default branch did not resolve to one full commit SHA");
  }

  const operator = parseJson(runCommand("gh", apiArgs("GET", "user"), { cwd }), "Operator lookup");
  const operatorLogin = operator.login;
  if (typeof operatorLogin !== "string" || !/^[A-Za-z0-9-]+$/.test(operatorLogin)) {
    throw new Error("Authenticated release operator identity is missing or malformed");
  }

  const localHead = runCommand("git", ["rev-parse", "HEAD"], { cwd }).trim().toLowerCase();
  const localBranch = runCommand("git", ["symbolic-ref", "--short", "HEAD"], { cwd }).trim();
  const localStatus = runCommand("git", ["status", "--porcelain"], { cwd }).trim();
  if (localHead !== sourceSha || localBranch !== defaultBranch || localStatus) {
    throw new Error("Release dispatch requires a clean checkout at the exact remote default-branch head");
  }
  const version = readBoundVersion(cwd);

  let immutableSetting;
  try {
    immutableSetting = parseJson(
      runCommand("gh", apiArgs("GET", `repos/${repository}/immutable-releases`), { cwd }),
      "Immutable release preflight",
    );
  } catch (error) {
    throw new Error(`Immutable release preflight could not prove the setting is enabled: ${error.message}`);
  }
  if (immutableSetting?.enabled !== true) {
    throw new Error("Immutable release preflight did not return enabled: true");
  }

  const verifiedAt = now();
  if (!(verifiedAt instanceof Date) || !Number.isFinite(verifiedAt.getTime())) {
    throw new Error("Immutable release preflight timestamp is invalid");
  }
  const dispatchBody = {
    client_payload: {
      default_branch: defaultBranch,
      immutable_releases_verified: true,
      operator_login: operatorLogin,
      source_sha: sourceSha,
      verified_at: verifiedAt.toISOString(),
      version,
    },
    event_type: RELEASE_DISPATCH_EVENT_TYPE,
  };
  runCommand("gh", apiArgs("POST", `repos/${repository}/dispatches`, ["--input", "-"]), {
    cwd,
    input: `${JSON.stringify(dispatchBody)}\n`,
  });

  return { defaultBranch, operatorLogin, sourceSha, version };
}
