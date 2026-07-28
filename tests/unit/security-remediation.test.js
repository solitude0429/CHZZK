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
  it("keeps AMO secrets out of argv and the dependency-free signing boundary", () => {
    const rejected = spawnSync(
      process.execPath,
      ["scripts/sign-unlisted.js", "--api-key=synthetic", "--api-secret=synthetic"],
      { cwd: rootDir, encoding: "utf8" },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /environment variables/i);

    const signer = `${read("scripts/sign-unlisted.js")}\n${read("scripts/lib/amo-client.js")}`;
    assert.doesNotMatch(signer, /web-ext|source-dir|node_modules|npm\s+(?:ci|install)/i);
    assert.match(signer, /AMO_API_ROOT/);
    assert.doesNotMatch(signer, /authorizedFetch\(downloadUrl/);
  });

  it("pins every action and separates build, secret, attestation, and write authority", () => {
    const workflowDir = join(rootDir, ".github/workflows");
    for (const name of readdirSync(workflowDir).filter((entry) => /\.ya?ml$/.test(entry))) {
      const text = read(`.github/workflows/${name}`);
      for (const match of text.matchAll(/^\s*-\s+uses:\s*([^\s#]+)/gm)) {
        if (!match[1].startsWith("./")) {
          assert.match(match[1], /@[a-f0-9]{40}$/i, `${name}: ${match[1]}`);
        }
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
    assert.deepEqual(release.jobs.stage.permissions, { actions: "read", contents: "write" });

    const signText = JSON.stringify(release.jobs.sign);
    const attestText = JSON.stringify(release.jobs.attest);
    const stageText = JSON.stringify(release.jobs.stage);
    assert.match(signText, /secrets\.AMO_JWT_ISSUER/);
    assert.doesNotMatch(signText, /actions\/checkout|npm ci|npm install/);
    assert.doesNotMatch(attestText, /secrets\.|actions\/checkout|npm ci|npm install|node scripts/);
    assert.doesNotMatch(stageText, /secrets\.|actions\/checkout|npm ci|npm install|node scripts/);
  });

  it("keeps publication nonce-bound, immutable, and outside GitHub Actions", () => {
    const release = workflow("sign-unlisted.yml");
    const text = read(".github/workflows/sign-unlisted.yml");
    const bootstrap = read("scripts/admin-release-bootstrap.js");
    const finalizer = read("scripts/lib/release-finalize.js");
    const updateRunbook = read("docs/UPDATES.md");
    assert.deepEqual(release.on, {
      repository_dispatch: { types: ["chzzk-release-preflight-v1"] },
    });
    assert.match(String(release["run-name"]), /dispatch_nonce/);
    assert.match(JSON.stringify(release.jobs.authorize), /RELEASE_OPERATOR_LOGIN|EXPECTED_OPERATOR/);
    assert.match(text, /reuse_existing/);
    assert.match(text, /draft_signed_ready/);
    assert.match(text, /gh release upload "\$TAG" "\$ASSET"/);
    assert.doesNotMatch(text, /--clobber|gh release edit "\$TAG" --target/);
    assert.match(bootstrap, /repos\/\$\{repository\}\/immutable-releases/);
    assert.match(bootstrap, /randomBytes\(16\)/);
    assert.match(bootstrap, /run\.display_title === expectedTitle/);
    assert.match(bootstrap, /run\?\.workflow_id !== workflowId/);
    assert.doesNotMatch(bootstrap, /run\.name === "Stage unlisted Firefox release"/);
    assert.match(finalizer, /immutableReleasesEnabled/);
    assert.match(finalizer, /"draft=false"/);
    assert.doesNotMatch(finalizer, /GITHUB_TOKEN/);
    assert.match(updateRunbook, /CHZZK_OLD_SIGNED_XPI=/);
    assert.doesNotMatch(updateRunbook, /CHZZK_PREVIOUS_SIGNED_XPI|CHZZK_UPDATE_BASE_URL/);
  });

  it("runs the final signed XPI in stock Firefox before attestation and staging", () => {
    const release = workflow("sign-unlisted.yml");
    const steps = release.jobs["verify-signed"].steps;
    const structural = steps.findIndex(
      (step) => step.name === "Verify signed runtime against immutable release metadata",
    );
    const setup = steps.findIndex((step) => step.run === "npm run setup:firefox-signed-smoke");
    const smoke = steps.findIndex(
      (step) => step.name === "Require stock Firefox to trust and permanently install the signed XPI",
    );
    const upload = steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@"));
    assert.equal(structural >= 0, true);
    assert.equal(setup > structural, true);
    assert.equal(smoke > setup, true);
    assert.equal(upload > smoke, true);
    assert.match(JSON.stringify(release.jobs.attest.needs), /verify-signed/);
    assert.match(JSON.stringify(release.jobs.stage.needs), /verify-signed/);
  });

  it("removes retired, duplicate, and signal-poor automation", () => {
    assert.deepEqual(
      readdirSync(join(rootDir, ".github/workflows"))
        .filter((entry) => /\.ya?ml$/.test(entry))
        .sort(),
      ["ci.yml", "codeql.yml", "dependency-review.yml", "sign-unlisted.yml"],
    );
    for (const path of [
      ".github/dependabot.yml",
      ".github/workflows/generate-package-lock.yml",
      ".github/workflows/exact-head-review.yml",
      ".github/workflows/review-gate.yml",
      ".github/workflows/scorecard.yml",
      ".github/workflows/sync-generated-release-files.yml",
      "docs/AUTO_UPDATE_LOOP.md",
      "ops/chzzk-telemetry-collector.py",
      "ops/chzzk-telemetry-context.py",
      "ops/chzzk-telemetry-summary.py",
      "scripts/check-review-gate.js",
      "scripts/configure-review-gate.js",
      "scripts/lib/review-gate.js",
      "scripts/verify-exact-head-review.js",
    ]) {
      assert.equal(existsSync(join(rootDir, path)), false, path);
    }
    const codeql = read(".github/workflows/codeql.yml");
    assert.match(codeql, /languages:\s*javascript-typescript/);
    assert.doesNotMatch(codeql, /python/i);
  });

  it("pins direct dependencies and ignores local secrets and generated artifacts", () => {
    const packageJson = JSON.parse(read("package.json"));
    for (const [name, version] of Object.entries(packageJson.devDependencies)) {
      assert.doesNotMatch(version, /^[~^]/, `${name} must be exactly pinned`);
    }
    const ignore = read(".gitignore");
    assert.match(ignore, /^\.env$/m);
    assert.match(ignore, /^\.env\.\*$/m);
    assert.match(ignore, /^dist\/$/m);
    assert.match(ignore, /^web-ext-artifacts\/$/m);
  });

  it("deploys only an attested exact release through the protected transactional boundary", () => {
    const bootstrap = read("scripts/internal-update-deploy-bootstrap.js");
    const cli = read("scripts/deploy-internal-updates.js");
    const packageJson = JSON.parse(read("package.json"));
    const transaction = read("scripts/lib/update-deployment.js");
    assert.equal(Object.hasOwn(packageJson.scripts, "deploy:updates:internal"), false);
    assert.match(bootstrap, /\/usr\/bin\/env -i/);
    assert.match(bootstrap, /decodeProtectedDeploymentSource/);
    assert.match(cli, /not memory-sealed by the bootstrap/);
    assert.match(cli, /"attestation",\s*"verify"/);
    assert.match(cli, /--source-digest/);
    assert.match(cli, /isImmutable/);
    assert.match(transaction, /snapshotLink/);
    assert.match(transaction, /restoreLink/);
    assert.match(transaction, /fsyncDirectory/);
  });

  it("keeps extension diagnostics local-only", () => {
    const manifest = JSON.parse(read("manifest.json"));
    const docs = `${read("docs/HARDENING.md")}\n${read("docs/SECURITY.md")}`;
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ["none"]);
    assert.equal(
      manifest.permissions.some((permission) => permission.includes("chzzk-report")),
      false,
    );
    assert.match(docs, /No external telemetry\/data collector/i);
  });
});
