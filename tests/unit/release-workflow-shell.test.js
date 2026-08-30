import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceDigest = "4".repeat(40);
const version = "0.1.4";

function releaseWorkflow() {
  return parse(readFileSync(join(repoRoot, ".github/workflows/sign-unlisted.yml"), "utf8"));
}

function runAuthorizer({
  actor = "solitude0429",
  defaultBranch = "main",
  eventName = "workflow_dispatch",
  extraInput = false,
  nonce = "b".repeat(32),
  protectedRef = "true",
  ref = "refs/heads/main",
  requestedSourceSha = sourceDigest,
  requestedVersion = version,
} = {}) {
  const scratchRoot = join(repoRoot, "dist");
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, "authorizer-test-"));
  try {
    const eventPath = join(directory, "event.json");
    const inputs = {
      nonce,
      source_sha: requestedSourceSha,
      version: requestedVersion,
    };
    if (extraInput) inputs.unexpected = "value";
    writeFileSync(
      eventPath,
      JSON.stringify({
        inputs,
        repository: {
          default_branch: defaultBranch,
          full_name: "solitude0429/CHZZK",
        },
        sender: { login: actor },
      }),
    );
    const authorizeStep = releaseWorkflow().jobs.authorize.steps.find((step) =>
      String(step.name).includes("administrator preflight"),
    );
    const result = spawnSync("bash", ["-c", authorizeStep.run], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_OPERATOR: "solitude0429",
        GITHUB_ACTOR: actor,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REF: ref,
        GITHUB_REPOSITORY: "solitude0429/CHZZK",
        GITHUB_SHA: sourceDigest,
        REF_PROTECTED: protectedRef,
      },
    });
    return {
      cleanup: () => rmSync(directory, { force: true, recursive: true }),
      result,
    };
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

describe("protected release workflow authorization", () => {
  it("accepts only the configured operator on the exact protected default head", () => {
    const accepted = runAuthorizer();
    try {
      assert.equal(accepted.result.status, 0, accepted.result.stderr);
    } finally {
      accepted.cleanup();
    }

    for (const rejected of [
      runAuthorizer({ actor: "other-user" }),
      runAuthorizer({ defaultBranch: "trunk" }),
      runAuthorizer({ eventName: "repository_dispatch" }),
      runAuthorizer({ extraInput: true }),
      runAuthorizer({ nonce: "invalid" }),
      runAuthorizer({ protectedRef: "false" }),
      runAuthorizer({ ref: "refs/heads/release" }),
      runAuthorizer({ requestedSourceSha: "5".repeat(40) }),
      runAuthorizer({ requestedVersion: "01.4.0" }),
    ]) {
      try {
        assert.notEqual(rejected.result.status, 0);
      } finally {
        rejected.cleanup();
      }
    }
  });

  it("exposes only the nonce-bound artifact-producing workflow interface", () => {
    const release = releaseWorkflow();
    assert.deepEqual(Object.keys(release.on), ["workflow_dispatch"]);
    assert.deepEqual(Object.keys(release.on.workflow_dispatch.inputs).sort(), [
      "nonce",
      "source_sha",
      "version",
    ]);
    for (const input of Object.values(release.on.workflow_dispatch.inputs)) {
      assert.equal(input.required, true);
      assert.equal(input.type, "string");
    }
    assert.match(String(release["run-name"]), /inputs\.nonce/);
    assert.match(String(release.concurrency.group), /inputs\.source_sha/);
    assert.deepEqual(Object.keys(release.jobs).sort(), [
      "attest",
      "authorize",
      "prepare",
      "sign",
      "verify-signed",
    ]);
    assert.equal(
      Object.values(release.jobs).some((job) => job.permissions?.contents === "write"),
      false,
    );
    assert.doesNotMatch(JSON.stringify(release), /gh release (?:create|edit|upload)/);

    const output = release.jobs["verify-signed"].steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    assert.equal(output.with.name, "chzzk-release-assets-${{ github.sha }}");
    assert.equal(output.with.path, "release-assets/*");
    assert.deepEqual(release.jobs.attest.needs, ["prepare", "verify-signed"]);
  });
});
