import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertFinalizationReleaseVersion,
  canonicalReleaseAssetNames,
  inspectFinalizationReleaseState,
  prepareFinalizationInputs,
} from "./release-finalize-state.js";

const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_API_HEADERS = [
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2026-03-10",
];

function paginatedApiArgs(method, endpoint) {
  const args = apiArgs(method, endpoint);
  args.splice(-1, 0, "--paginate", "--slurp");
  return args;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function apiArgs(method, endpoint) {
  return ["api", "--method", method, ...GITHUB_API_HEADERS, endpoint];
}

function readBoundVersion(cwd) {
  const packageJson = parseJson(readFileSync(join(cwd, "package.json"), "utf8"), "package.json");
  const manifest = parseJson(readFileSync(join(cwd, "manifest.json"), "utf8"), "manifest.json");
  const version = assertFinalizationReleaseVersion(packageJson.version, "package.json version");
  if (manifest.version !== version) {
    throw new Error("package.json and manifest.json versions must match before release finalization");
  }
  return version;
}

function inspectAdministratorContext({ cwd, repository, runCommand }) {
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
  if (typeof operatorLogin !== "string" || !GITHUB_LOGIN_RE.test(operatorLogin)) {
    throw new Error("Authenticated release operator identity is missing or malformed");
  }
  const configuredOperator = parseJson(
    runCommand("gh", apiArgs("GET", `repos/${repository}/actions/variables/RELEASE_OPERATOR_LOGIN`), { cwd }),
    "Release operator configuration",
  );
  if (configuredOperator?.name !== "RELEASE_OPERATOR_LOGIN" || configuredOperator?.value !== operatorLogin) {
    throw new Error("Authenticated release operator does not match RELEASE_OPERATOR_LOGIN");
  }
  const localHead = runCommand("git", ["rev-parse", "HEAD"], { cwd }).trim().toLowerCase();
  const localBranch = runCommand("git", ["symbolic-ref", "--short", "HEAD"], { cwd }).trim();
  const localStatus = runCommand("git", ["status", "--porcelain"], { cwd }).trim();
  if (localHead !== sourceSha || localBranch !== defaultBranch || localStatus) {
    throw new Error("Release finalization requires a clean checkout at the exact remote default-branch head");
  }
  return { defaultBranch, operatorLogin, sourceSha, version: readBoundVersion(cwd) };
}

function assertStagedState(state) {
  if (state?.reuseExisting === true) return "published";
  if (state?.draftSignedReady !== true || state?.reuseExisting !== false) {
    throw new Error("Release finalization requires a complete, verified staged draft");
  }
  return "draft";
}

function stableSnapshot(state, label) {
  if (!Object.hasOwn(state ?? {}, "assetSnapshot")) return null;
  if (
    !Array.isArray(state.assetSnapshot?.assets) ||
    !Number.isSafeInteger(state.assetSnapshot?.releaseId) ||
    state.assetSnapshot.releaseId <= 0 ||
    typeof state.assetSnapshot?.tag !== "string"
  ) {
    throw new Error(`${label} release asset snapshot is malformed`);
  }
  try {
    return JSON.stringify({
      assets: state.assetSnapshot.assets,
      releaseId: state.assetSnapshot.releaseId,
      tag: state.assetSnapshot.tag,
    });
  } catch {
    throw new Error(`${label} release asset snapshot is malformed`);
  }
}

function assertSameAssetSnapshot(left, right, message) {
  const leftSnapshot = stableSnapshot(left, "Initial");
  const rightSnapshot = stableSnapshot(right, "Rechecked");
  if (leftSnapshot === null && rightSnapshot === null) return;
  if (!leftSnapshot || !rightSnapshot || leftSnapshot !== rightSnapshot) {
    throw new Error(message);
  }
}

function verifiedReleaseId(state, label) {
  if (stableSnapshot(state, label) === null) {
    throw new Error(`${label} release identity snapshot is missing`);
  }
  return state.assetSnapshot.releaseId;
}

function assertStagingWorkflowComplete({ cwd, repository, runCommand, sourceSha }) {
  const endpoint = `repos/${repository}/actions/workflows/sign-unlisted.yml/runs?head_sha=${sourceSha}&per_page=100`;
  const response = parseJson(
    runCommand("gh", paginatedApiArgs("GET", endpoint), { cwd }),
    "Release staging workflow lookup",
  );
  const pages = Array.isArray(response) ? response : [response];
  const runs = pages.flatMap((page) => {
    if (!Array.isArray(page?.workflow_runs)) {
      throw new Error("Release staging workflow lookup returned malformed pagination");
    }
    return page.workflow_runs;
  });
  if (runs.length === 0) {
    throw new Error("Release finalization could not prove a completed staging workflow");
  }
  const runIds = new Set();
  const runCoordinates = new Set();
  for (const run of runs) {
    if (String(run?.head_sha ?? "").toLowerCase() !== sourceSha) {
      throw new Error("Release staging workflow lookup returned a mismatched source");
    }
    if (
      !Number.isSafeInteger(run.id) ||
      run.id <= 0 ||
      !Number.isSafeInteger(run.run_number) ||
      run.run_number <= 0 ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt <= 0 ||
      runIds.has(run.id)
    ) {
      throw new Error("Release staging workflow lookup returned malformed run identity");
    }
    const coordinate = `${run.run_number}:${run.run_attempt}`;
    if (runCoordinates.has(coordinate)) {
      throw new Error("Release staging workflow lookup returned duplicate run ordering");
    }
    runIds.add(run.id);
    runCoordinates.add(coordinate);
    if (run.status !== "completed") {
      throw new Error("Release finalization requires every exact-source staging workflow to be complete");
    }
    if (typeof run.conclusion !== "string" || !run.conclusion) {
      throw new Error("Release staging workflow lookup returned malformed completion state");
    }
  }
  const newestRun = runs.reduce((latest, run) => {
    if (!latest) return run;
    if (run.run_number !== latest.run_number) {
      return run.run_number > latest.run_number ? run : latest;
    }
    if (run.run_attempt !== latest.run_attempt) {
      return run.run_attempt > latest.run_attempt ? run : latest;
    }
    return run.id > latest.id ? run : latest;
  }, null);
  if (newestRun.conclusion !== "success") {
    throw new Error("Release finalization requires the newest exact-source staging workflow to succeed");
  }
}

function assertReleaseCompatibilityComplete({ cwd, defaultBranch, repository, runCommand, sourceSha, tag }) {
  const endpoint =
    `repos/${repository}/actions/workflows/release-compatibility.yml/runs?` +
    `branch=${encodeURIComponent(defaultBranch)}&event=workflow_dispatch&` +
    `head_sha=${sourceSha}&per_page=100`;
  const response = parseJson(
    runCommand("gh", paginatedApiArgs("GET", endpoint), { cwd }),
    "Signed compatibility workflow lookup",
  );
  const pages = Array.isArray(response) ? response : [response];
  const expectedTitle = `Signed Firefox compatibility ${tag}`;
  const runs = pages
    .flatMap((page) => {
      if (!Array.isArray(page?.workflow_runs)) {
        throw new Error("Signed compatibility workflow lookup returned malformed pagination");
      }
      return page.workflow_runs;
    })
    .filter((run) => run?.display_title === expectedTitle);
  if (runs.length === 0) {
    throw new Error(
      "Release finalization could not prove a manually dispatched signed compatibility workflow for the exact draft tag",
    );
  }

  const runIds = new Set();
  const runCoordinates = new Set();
  for (const run of runs) {
    if (
      run.name !== "Signed Firefox compatibility" ||
      run.event !== "workflow_dispatch" ||
      run.head_branch !== defaultBranch ||
      String(run.head_sha ?? "").toLowerCase() !== sourceSha ||
      run.path !== ".github/workflows/release-compatibility.yml"
    ) {
      throw new Error("Signed compatibility workflow lookup returned a mismatched source or workflow");
    }
    if (
      !Number.isSafeInteger(run.id) ||
      run.id <= 0 ||
      !Number.isSafeInteger(run.run_number) ||
      run.run_number <= 0 ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt <= 0 ||
      runIds.has(run.id)
    ) {
      throw new Error("Signed compatibility workflow lookup returned malformed run identity");
    }
    const coordinate = `${run.run_number}:${run.run_attempt}`;
    if (runCoordinates.has(coordinate)) {
      throw new Error("Signed compatibility workflow lookup returned duplicate run ordering");
    }
    runIds.add(run.id);
    runCoordinates.add(coordinate);
    if (run.status !== "completed") {
      throw new Error(
        "Release finalization requires every exact-tag signed compatibility workflow to be complete",
      );
    }
    if (typeof run.conclusion !== "string" || !run.conclusion) {
      throw new Error("Signed compatibility workflow lookup returned malformed completion state");
    }
  }
  const newestRun = runs.reduce((latest, run) => {
    if (!latest) return run;
    if (run.run_number !== latest.run_number) {
      return run.run_number > latest.run_number ? run : latest;
    }
    if (run.run_attempt !== latest.run_attempt) {
      return run.run_attempt > latest.run_attempt ? run : latest;
    }
    return run.id > latest.id ? run : latest;
  }, null);
  if (newestRun.conclusion !== "success") {
    throw new Error(
      "Release finalization requires the newest exact-tag signed compatibility workflow to succeed",
    );
  }
}

function immutableReleasesEnabled({ cwd, repository, runCommand }) {
  let setting;
  try {
    setting = parseJson(
      runCommand("gh", apiArgs("GET", `repos/${repository}/immutable-releases`), { cwd }),
      "Immutable release finalization preflight",
    );
  } catch (error) {
    throw new Error(`Immutable release finalization preflight could not prove the setting: ${error.message}`);
  }
  if (setting?.enabled !== true) {
    throw new Error("Immutable release finalization preflight did not return enabled: true");
  }
}

export async function finalizeStagedReleaseFromAdminPreflight({
  cwd = process.cwd(),
  inspectReleaseState = inspectFinalizationReleaseState,
  prepareArtifacts = prepareFinalizationInputs,
  repository,
  runCommand,
}) {
  if (typeof runCommand !== "function") {
    throw new Error("Release finalization requires an external trusted command runner");
  }
  const context = inspectAdministratorContext({ cwd, repository, runCommand });
  const names = canonicalReleaseAssetNames(context.version);
  const tag = `v${context.version}`;
  const verificationDir = mkdtempSync(join(tmpdir(), "chzzk-release-finalize-"));
  chmodSync(verificationDir, 0o700);
  const runGh = (args, options = {}) => {
    const commandArgs = args[0] === "api" ? ["api", ...GITHUB_API_HEADERS, ...args.slice(1)] : args;
    return runCommand("gh", commandArgs, { ...options, cwd });
  };

  try {
    const prepared = await prepareArtifacts({
      outputDir: verificationDir,
      rootDir: cwd,
      sourceDigest: context.sourceSha,
      sourceRepository: repository,
    });
    if (
      prepared?.metadata?.version !== context.version ||
      prepared?.metadata?.sourceDigest !== context.sourceSha ||
      prepared?.metadata?.sourceRepository !== repository
    ) {
      throw new Error("Prepared finalization metadata is not bound to the exact release source");
    }
    const signedXpiPath = join(verificationDir, names.signed);
    const inspectionInput = {
      expectedFiles: prepared.expectedFiles,
      metadataPath: prepared.metadataPath,
      repository,
      runGh,
      signedXpiPath,
      sourceArchivePath: prepared.sourceArchivePath,
      sourceSha: context.sourceSha,
      version: context.version,
    };

    const initialState = await inspectReleaseState(inspectionInput);
    if (assertStagedState(initialState) === "published") {
      for (const path of [prepared.sourceArchivePath, prepared.metadataPath, signedXpiPath]) {
        runGh([
          "attestation",
          "verify",
          path,
          "--repo",
          repository,
          "--source-digest",
          context.sourceSha,
          "--signer-workflow",
          `${repository}/.github/workflows/sign-unlisted.yml`,
        ]);
      }
      immutableReleasesEnabled({ cwd, repository, runCommand });
      return { ...context, alreadyPublished: true, tag };
    }

    for (const path of [prepared.sourceArchivePath, prepared.metadataPath, signedXpiPath]) {
      runGh([
        "attestation",
        "verify",
        path,
        "--repo",
        repository,
        "--source-digest",
        context.sourceSha,
        "--signer-workflow",
        `${repository}/.github/workflows/sign-unlisted.yml`,
      ]);
    }

    const recheckedState = await inspectReleaseState(inspectionInput);
    if (assertStagedState(recheckedState) !== "draft") {
      throw new Error("Staged release changed during finalization verification");
    }
    assertSameAssetSnapshot(
      initialState,
      recheckedState,
      "Staged release asset bytes changed during finalization verification",
    );
    assertStagingWorkflowComplete({
      cwd,
      repository,
      runCommand,
      sourceSha: context.sourceSha,
    });
    assertReleaseCompatibilityComplete({
      cwd,
      defaultBranch: context.defaultBranch,
      repository,
      runCommand,
      sourceSha: context.sourceSha,
      tag,
    });
    const publishReadyState = await inspectReleaseState(inspectionInput);
    if (assertStagedState(publishReadyState) !== "draft") {
      throw new Error("Staged release changed during the immediate pre-publication inspection");
    }
    assertSameAssetSnapshot(
      recheckedState,
      publishReadyState,
      "Staged release identity or asset bytes changed immediately before publication",
    );
    const releaseId = verifiedReleaseId(publishReadyState, "Publish-ready");
    immutableReleasesEnabled({ cwd, repository, runCommand });
    // GitHub does not support a conditional release PATCH. Targeting the exact inspected release ID
    // prevents tag substitution; the documented exclusive same-authority writer boundary still
    // covers mutation of that same draft between this last inspection and the PATCH.
    let publishError = null;
    try {
      runGh([
        "api",
        "--method",
        "PATCH",
        `repos/${repository}/releases/${releaseId}`,
        "-F",
        "draft=false",
        "-f",
        `name=CHZZK ${context.version}`,
        "-F",
        "prerelease=false",
        "-f",
        `tag_name=${tag}`,
        "-f",
        `target_commitish=${context.sourceSha}`,
      ]);
    } catch (error) {
      publishError = error;
    }
    const finalState = await inspectReleaseState(inspectionInput);
    if (assertStagedState(finalState) !== "published") {
      if (publishError) throw publishError;
      throw new Error("Release remained a draft after the publication command");
    }
    assertSameAssetSnapshot(
      publishReadyState,
      finalState,
      "Published release identity or asset bytes differ from the verified staged draft",
    );
    return {
      ...context,
      alreadyPublished: false,
      recoveredAmbiguousPublish: publishError !== null,
      tag,
    };
  } finally {
    rmSync(verificationDir, { force: true, recursive: true });
  }
}
