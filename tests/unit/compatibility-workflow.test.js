import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function workflow(path) {
  return parse(read(path));
}

describe("compatibility and production-health workflows", () => {
  it("binds signed minimum/current smokes to exact release sources on x64 and arm64", () => {
    const document = workflow(".github/workflows/release-compatibility.yml");
    assert.deepEqual(document.permissions, { contents: "read" });
    assert.equal(Object.hasOwn(document.on, "pull_request"), true);
    assert.deepEqual(document.jobs["resolve-release"].permissions, {
      contents: "read",
    });
    assert.deepEqual(document.jobs["signed-smoke"].permissions, {
      attestations: "read",
      contents: "read",
    });
    assert.deepEqual(document.jobs["signed-smoke"].strategy.matrix.include, [
      { architecture: "x64", profile: "minimum", runner: "ubuntu-24.04" },
      { architecture: "x64", profile: "current", runner: "ubuntu-24.04" },
      { architecture: "arm64", profile: "minimum", runner: "ubuntu-24.04-arm" },
      { architecture: "arm64", profile: "current", runner: "ubuntu-24.04-arm" },
    ]);
    assert.equal(document.jobs["signed-smoke"]["runs-on"], "${{ matrix.runner }}");

    const resolveStep = document.jobs["resolve-release"].steps.find((step) => step.id === "release");
    assert.match(resolveStep.run, /github\.ref_protected|REF_PROTECTED/);
    assert.match(resolveStep.run, /git\/ref\/tags/);
    assert.match(resolveStep.run, /source_sha=/);
    assert.match(resolveStep.run, /immutable=/);
    assert.match(resolveStep.run, /EXPECTED_ASSETS/);
    assert.match(resolveStep.run, /isImmutable/);
    assert.match(resolveStep.run, /pull_request/);

    const checkout = document.jobs["signed-smoke"].steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.match(checkout.with.ref, /pull_request\.head\.sha/);

    const sourceStep = document.jobs["signed-smoke"].steps.find(
      (step) => step.name === "Require the exact compatibility-harness source tree and architecture",
    );
    assert.equal(sourceStep.env.EXPECTED_ARCHITECTURE, "${{ matrix.architecture }}");
    assert.match(sourceStep.run, /process\.arch/);

    const verifyStep = document.jobs["signed-smoke"].steps.find(
      (step) => step.name === "Download and verify the exact signed release inputs",
    );
    assert.match(verifyStep.run, /assertReleaseMetadata/);
    assert.match(verifyStep.run, /metadata\.sourceDigest/);
    assert.match(verifyStep.run, /EXPECTED_SOURCE_SHA/);
    assert.match(verifyStep.run, /npm run verify:signed-release/);

    const attestationStep = document.jobs["signed-smoke"].steps.find(
      (step) => step.name === "Verify release-asset attestations",
    );
    assert.match(attestationStep.if, /draft.*immutable|immutable.*draft/);
    assert.match(attestationStep.run, /gh attestation verify/);
    assert.match(attestationStep.run, /--source-digest/);
    assert.match(attestationStep.run, /sign-unlisted\.yml/);

    const setupStep = document.jobs["signed-smoke"].steps.find(
      (step) => step.name === "Prepare checksum-pinned stock Firefox",
    );
    assert.equal(setupStep.env.CHZZK_SIGNED_SMOKE_PROFILE, "${{ matrix.profile }}");
    assert.match(setupStep.env.CHZZK_SIGNED_SMOKE_TOOLS_DIR, /matrix\.architecture/);
  });

  it("keeps the WireGuard-only production canary outside GitHub Actions", () => {
    const packageDocument = JSON.parse(read("package.json"));
    assert.equal(packageDocument.scripts["check:live-update"], "node scripts/check-live-update.js");
    assert.doesNotMatch(packageDocument.scripts.verify, /check:live-update/);

    const workflowDirectory = new URL("../../.github/workflows/", import.meta.url);
    for (const name of readdirSync(workflowDirectory)) {
      if (!/\.ya?ml$/u.test(name)) continue;
      assert.doesNotMatch(
        read(`.github/workflows/${name}`),
        /npm run check:live-update/,
        `${name} must not contact the WireGuard-only production update host`,
      );
    }
  });

  it("checks Mozilla release freshness on schedule and relevant pull requests", () => {
    const document = workflow(".github/workflows/firefox-compatibility-freshness.yml");
    assert.deepEqual(document.permissions, { contents: "read" });
    assert.equal(Array.isArray(document.on.schedule), true);
    assert.equal(Object.hasOwn(document.on, "pull_request"), true);
    const job = document.jobs["verify-freshness"];
    assert.deepEqual(job.permissions, { contents: "read" });
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.match(checkout.with.ref, /pull_request\.head\.sha/);
    const sourceStep = job.steps.find(
      (step) => step.name === "Require the exact freshness-check source tree",
    );
    assert.match(sourceStep.run, /EXPECTED_SOURCE_SHA/);
    assert.equal(
      job.steps.find((step) => step.name === "Compare pinned Firefox profiles with Mozilla release metadata")
        .run,
      "npm run check:firefox-compatibility-freshness",
    );
  });

  it("verifies both the pull-request head and the effective event tree", () => {
    const document = workflow(".github/workflows/ci.yml");
    for (const jobName of ["verify", "firefox-e2e"]) {
      const step = document.jobs[jobName].steps.find(
        (candidate) => candidate.name === "Require the exact event source tree",
      );
      assert.match(step.run, /git rev-parse HEAD/);
      assert.match(step.run, /GITHUB_SHA/);
      assert.match(step.run, /git diff --cached --exit-code/);
    }

    const headJob = document.jobs["verify-head"];
    assert.match(headJob.if, /pull_request/);
    const checkout = headJob.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout.with.ref, "${{ github.event.pull_request.head.sha }}");
    const headStep = headJob.steps.find((step) => step.name === "Require the exact pull-request head tree");
    assert.equal(headStep.env.EXPECTED_HEAD_SHA, "${{ github.event.pull_request.head.sha }}");
    assert.match(headStep.run, /EXPECTED_HEAD_SHA/);
    assert.equal(
      headJob.steps.some((step) => step.run === "npm run verify"),
      true,
    );
  });

  it("runs CodeQL on both the exact pull-request head and effective event tree", () => {
    const document = workflow(".github/workflows/codeql.yml");
    assert.deepEqual(document.jobs.analyze.permissions, {
      contents: "read",
      "security-events": "write",
    });
    const eventStep = document.jobs.analyze.steps.find(
      (step) => step.name === "Require the exact event source tree",
    );
    assert.match(eventStep.run, /GITHUB_SHA/);

    const headJob = document.jobs["analyze-head"];
    assert.match(headJob.if, /pull_request/);
    assert.deepEqual(headJob.permissions, {
      contents: "read",
      "security-events": "write",
    });
    const checkout = headJob.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout.with.ref, "${{ github.event.pull_request.head.sha }}");
    const headStep = headJob.steps.find((step) => step.name === "Require the exact pull-request head tree");
    assert.match(headStep.run, /EXPECTED_HEAD_SHA/);
    assert.equal(headJob.steps.filter((step) => step.uses?.startsWith("github/codeql-action/")).length, 2);
  });
});
