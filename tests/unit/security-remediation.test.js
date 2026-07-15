import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath) {
  return readFileSync(join(rootDir, relativePath), "utf8");
}

function workflow(name) {
  return parse(read(`.github/workflows/${name}`));
}

describe("release and repository security guardrails", () => {
  it("rejects command-line delivery of AMO signing secrets and uses a dependency-free signer", () => {
    const rejected = spawnSync(
      process.execPath,
      ["scripts/sign-unlisted.js", "--api-key=synthetic", "--api-secret=synthetic"],
      { cwd: rootDir, encoding: "utf8" },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /environment variables/i);

    const wrapper = read("scripts/sign-unlisted.js");
    const client = read("scripts/lib/amo-client.js");
    assert.doesNotMatch(`${wrapper}\n${client}`, /web-ext|source-dir|node_modules|npm\s+(?:ci|install)/i);
    assert.match(client, /AMO_API_ROOT/);
    assert.match(client, /hostname === AMO_DOWNLOAD_DOMAIN/);
    assert.match(client, /url\.username/);
    assert.match(client, /url\.password/);
    assert.match(client, /fetchSignedXpi/);
    assert.doesNotMatch(client, /authorizedFetch\(downloadUrl/);
    assert.match(client, /fsyncDirectory/);
    assert.match(client, /fsyncSync/);
    assert.match(read("scripts/lib/release-artifacts.js"), /fsyncDirectory/);
    assert.match(read("scripts/build-update-manifest.js"), /fsyncDirectory/);
  });

  it("pins all actions and semantically separates build, secret, attestation, and publish authority", () => {
    const workflowDir = join(rootDir, ".github/workflows");
    for (const name of readdirSync(workflowDir).filter((entry) => /\.ya?ml$/.test(entry))) {
      const text = read(`.github/workflows/${name}`);
      for (const match of text.matchAll(/^\s*-\s+uses:\s*([^\s#]+)/gm)) {
        if (match[1].startsWith("./")) continue;
        assert.match(match[1], /@[a-f0-9]{40}$/i, `${name} contains an unpinned action: ${match[1]}`);
      }
    }

    const release = workflow("sign-unlisted.yml");
    assert.deepEqual(release.jobs.prepare.permissions, {
      attestations: "read",
      contents: "read",
    });
    assert.deepEqual(release.jobs.sign.permissions, { actions: "read" });
    assert.deepEqual(release.jobs.attest.permissions, {
      actions: "read",
      attestations: "write",
      contents: "read",
      "id-token": "write",
    });
    assert.deepEqual(release.jobs.publish.permissions, { actions: "read", contents: "write" });

    const signText = JSON.stringify(release.jobs.sign);
    const attestText = JSON.stringify(release.jobs.attest);
    const publishText = JSON.stringify(release.jobs.publish);
    assert.match(signText, /secrets\.AMO_JWT_ISSUER/);
    assert.doesNotMatch(signText, /actions\/checkout|npm ci|npm install/);
    assert.doesNotMatch(attestText, /secrets\.|actions\/checkout|npm ci|npm install|node scripts/);
    assert.doesNotMatch(publishText, /secrets\.|actions\/checkout|npm ci|npm install|node scripts/);

    const prepareSteps = release.jobs.prepare.steps;
    const preparationIndex = prepareSteps.findIndex((step) => step.run === "npm run prepare:release");
    const signerAnchorIndex = prepareSteps.findIndex(
      (step) => step.name === "Anchor signer code to the protected commit",
    );
    assert.notEqual(preparationIndex, -1);
    assert.equal(signerAnchorIndex > preparationIndex, true);
    const signerAnchor = prepareSteps[signerAnchorIndex].run;
    assert.match(signerAnchor, /git show "\$GITHUB_SHA:scripts\/sign-unlisted\.js"/);
    assert.match(signerAnchor, /git show "\$GITHUB_SHA:scripts\/lib\/amo-client\.js"/);
    const releasePreparation = prepareSteps.find((step) => step.id === "release").run;
    assert.match(
      releasePreparation,
      /SIGNER_SHA=\$\(git show "\$GITHUB_SHA:scripts\/sign-unlisted\.js" \| sha256sum/,
    );
    assert.match(
      releasePreparation,
      /CLIENT_SHA=\$\(git show "\$GITHUB_SHA:scripts\/lib\/amo-client\.js" \| sha256sum/,
    );
  });

  it("keeps releases immutable and treats an exact rerun as verified reuse", () => {
    const text = read(".github/workflows/sign-unlisted.yml");
    const release = workflow("sign-unlisted.yml");
    const prepareRelease = release.jobs.prepare.steps.find((step) => step.id === "release").run;
    const operatorPreflight = read("scripts/lib/release-dispatch.js");
    const statePreflight = read("scripts/lib/github-release-state.js");
    assert.deepEqual(release.on, {
      repository_dispatch: { types: ["chzzk-release-preflight-v1"] },
    });
    assert.equal(Object.hasOwn(release.on, "workflow_dispatch"), false);
    assert.equal(release.jobs.prepare.needs, "authorize");
    assert.match(JSON.stringify(release.jobs.authorize), /RELEASE_OPERATOR_LOGIN|operator_login/);
    assert.match(
      JSON.stringify(release.jobs.authorize),
      /source_sha|verified_at|immutable_releases_verified/,
    );
    assert.match(operatorPreflight, /\/immutable-releases/);
    assert.match(operatorPreflight, /enabled\s*!==\s*true/);
    assert.match(operatorPreflight, /repos\/\$\{repository\}\/dispatches/);
    assert.match(text, /reuse_existing/);
    assert.match(text, /draft_signed_ready/);
    assert.match(text, /gh release view/);
    assert.match(text, /cmp "\$SOURCE"/);
    assert.match(text, /--draft/);
    assert.match(text, /gh release edit "\$TAG" --draft=false/);
    assert.doesNotMatch(text, /\/immutable-releases/);
    assert.match(text, /--json isImmutable/);
    assert.match(text, /sync_draft_assets/);
    assert.match(text, /gh release upload "\$TAG" "\$ASSET"/);
    assert.match(text, /--json isDraft/);
    assert.match(text, /--json isPrerelease/);
    assert.match(statePreflight, /--source-digest/);
    assert.match(statePreflight, /\.github\/workflows\/sign-unlisted\.yml/);
    assert.match(text, /git diff --cached --exit-code/);
    assert.doesNotMatch(text, /--clobber|gh release edit "\$TAG" --target/);
    assert.match(text, /github\.ref_protected == true/);
    assert.match(text, /environment:\s*firefox-signing/);
    assert.match(prepareRelease, /preflight-release-state\.js/);
    assert.match(release.jobs.sign.if, /draft_signed_ready/);

    const prepare = read("scripts/prepare-release.js");
    assert.match(prepare, /--porcelain=v1/);
    assert.match(prepare, /does not match checked-out HEAD/);
  });

  it("runs the final AMO-signed XPI through stock Firefox before attestation and publication", () => {
    const packageJson = JSON.parse(read("package.json"));
    const release = workflow("sign-unlisted.yml");
    const verifySteps = release.jobs["verify-signed"].steps;
    const setupIndex = verifySteps.findIndex((step) => step.run === "npm run setup:firefox-signed-smoke");
    const structuralIndex = verifySteps.findIndex(
      (step) => step.name === "Verify signed runtime against immutable release metadata",
    );
    const smokeIndex = verifySteps.findIndex(
      (step) => step.name === "Require stock Firefox to trust and permanently install the signed XPI",
    );
    const uploadIndex = verifySteps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@"));

    assert.equal(
      packageJson.scripts["setup:firefox-signed-smoke"],
      "node scripts/setup-firefox-signed-smoke.js",
    );
    const setup = read("scripts/setup-firefox-signed-smoke.js");
    assert.match(setup, /archive\.mozilla\.org\/pub\/firefox\/releases/);
    assert.doesNotMatch(setup, /devedition/i);
    assert.equal(structuralIndex >= 0, true);
    assert.equal(setupIndex > structuralIndex, true);
    assert.equal(smokeIndex > setupIndex, true);
    assert.equal(uploadIndex > smokeIndex, true);

    const smoke = verifySteps[smokeIndex];
    assert.equal(smoke.run, "npm run test:firefox-signed-smoke");
    assert.match(smoke.env.FIREFOX_BINARY, /signed-smoke-tools\/firefox\/firefox/);
    assert.match(smoke.env.GECKODRIVER_BINARY, /signed-smoke-tools\/geckodriver/);
    assert.match(smoke.env.CHZZK_RELEASE_METADATA, /release-metadata\.json/);
    assert.match(smoke.env.CHZZK_SIGNED_XPI, /-signed\.xpi/);
    assert.equal(smoke.env.CHZZK_SIGNED_SMOKE_MODE, "install");
    assert.doesNotMatch(JSON.stringify(smoke), /xpinstall\.signatures|requiredBuiltInCerts/i);
    assert.match(JSON.stringify(release.jobs.attest.needs), /verify-signed/);
    assert.match(JSON.stringify(release.jobs.publish.needs), /verify-signed/);
  });

  it("removes generated-file auto-commit workflows and retired external collector code", () => {
    assert.equal(existsSync(join(rootDir, ".github/workflows/generate-package-lock.yml")), false);
    assert.equal(existsSync(join(rootDir, ".github/workflows/sync-generated-release-files.yml")), false);
    assert.equal(existsSync(join(rootDir, "ops/chzzk-telemetry-collector.py")), false);
    assert.equal(existsSync(join(rootDir, "ops/chzzk-telemetry-context.py")), false);
    assert.equal(existsSync(join(rootDir, "ops/chzzk-telemetry-summary.py")), false);
    assert.equal(existsSync(join(rootDir, "docs/AUTO_UPDATE_LOOP.md")), false);
  });

  it("removes unnecessary Scorecard OIDC and analyzes only shipped JavaScript", () => {
    const scorecard = read(".github/workflows/scorecard.yml");
    const codeql = read(".github/workflows/codeql.yml");
    assert.doesNotMatch(scorecard, /id-token/);
    assert.match(scorecard, /publish_results:\s*false/);
    assert.match(codeql, /languages:\s*javascript-typescript/);
    assert.doesNotMatch(codeql, /python/i);
  });

  it("pins direct dependencies and ignores local secrets and generated release artifacts", () => {
    const packageJson = JSON.parse(read("package.json"));
    for (const [name, version] of Object.entries(packageJson.devDependencies)) {
      assert.doesNotMatch(version, /^[~^]/, `${name} must be exactly pinned`);
    }
    const ignore = read(".gitignore");
    assert.match(ignore, /^\.env$/m);
    assert.match(ignore, /^\.env\.\*$/m);
    assert.match(ignore, /^web-ext-artifacts\/$/m);
    assert.match(ignore, /^dist\/$/m);
  });

  it("deploys only an attested exact release set through the transactional deployment library", () => {
    const cli = read("scripts/deploy-internal-updates.js");
    const transaction = read("scripts/lib/update-deployment.js");
    assert.match(cli, /CHZZK_GITHUB_REPOSITORY/);
    assert.match(cli, /git", \["status", "--porcelain"\]/);
    assert.match(cli, /"attestation",\s*"verify"/);
    assert.match(cli, /--source-digest/);
    assert.match(cli, /release\.assets\.map/);
    assert.match(cli, /release\.isPrerelease/);
    assert.match(cli, /isImmutable/);
    assert.match(cli, /release must be immutable/i);
    assert.match(cli, /deployment client checkout must match/);
    assert.match(transaction, /snapshotLink/);
    assert.match(transaction, /restoreLink/);
    assert.match(transaction, /fsyncDirectory/);
    assert.doesNotMatch(transaction, /chmodSync\(targetDir|chmodSync\(releasesDir/);
  });

  it("requires a trusted exact-head automated review status for release and security PRs", () => {
    const gate = workflow("review-gate.yml");
    const text = read(".github/workflows/review-gate.yml");
    const settings = read("scripts/configure-review-gate.js");
    assert.equal(Object.hasOwn(gate.on, "pull_request_target"), true);
    assert.equal(Object.hasOwn(gate.on, "check_run"), true);
    assert.equal(Object.hasOwn(gate.on, "workflow_dispatch"), true);
    assert.deepEqual(gate.jobs.evaluate.permissions, {
      checks: "read",
      contents: "read",
      "pull-requests": "read",
    });
    assert.deepEqual(gate.jobs.status.permissions, { checks: "write" });
    assert.doesNotMatch(JSON.stringify(gate.jobs.status), /actions\/checkout|node scripts\/|npm\s/);
    assert.match(text, /AUTOMATED_REVIEW_APP_SLUG/);
    assert.match(text, /AUTOMATED_REVIEW_CHECK_NAME/);
    assert.match(text, /CHZZK review completion/);
    assert.match(text, /check-runs/);
    assert.match(settings, /required_status_checks/);
    assert.match(settings, /apps\/github-actions/);
    assert.match(settings, /dismiss_stale_reviews/);
    assert.match(settings, /require_last_push_approval/);
    assert.match(settings, /required_conversation_resolution/);
    assert.match(settings, /protection\/enforce_admins/);
    assert.match(settings, /Math\.max\(\s*1/);
    assert.match(settings, /--apply/);
  });

  it("keeps extension diagnostics local-only and documented as such", () => {
    const manifest = JSON.parse(read("manifest.json"));
    const docs = `${read("docs/HARDENING.md")}\n${read("docs/SECURITY.md")}`;
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ["none"]);
    assert.equal(
      manifest.permissions.some((permission) => permission.includes("chzzk-report")),
      false,
    );
    assert.match(docs, /No external telemetry\/data collector/i);
    assert.match(docs, /local/i);
  });
});
