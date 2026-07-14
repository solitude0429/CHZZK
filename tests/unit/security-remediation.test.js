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
  });

  it("pins all actions and semantically separates build, secret, attestation, and publish authority", () => {
    const workflowDir = join(rootDir, ".github/workflows");
    for (const name of readdirSync(workflowDir).filter((entry) => /\.ya?ml$/.test(entry))) {
      const text = read(`.github/workflows/${name}`);
      for (const match of text.matchAll(/uses:\s*([^\s#]+)/g)) {
        if (match[1].startsWith("./")) continue;
        assert.match(match[1], /@[a-f0-9]{40}$/i, `${name} contains an unpinned action: ${match[1]}`);
      }
    }

    const release = workflow("sign-unlisted.yml");
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
  });

  it("keeps releases immutable and treats an exact rerun as verified reuse", () => {
    const text = read(".github/workflows/sign-unlisted.yml");
    assert.match(text, /reuse_existing/);
    assert.match(text, /gh release view/);
    assert.match(text, /cmp "\$SOURCE"/);
    assert.match(text, /--draft/);
    assert.match(text, /gh release edit "\$TAG" --draft=false/);
    assert.match(text, /--json isDraft/);
    assert.match(text, /--json isPrerelease/);
    assert.match(text, /git diff --cached --exit-code/);
    assert.doesNotMatch(text, /--clobber|gh release upload|gh release edit "\$TAG" --target/);
    assert.match(text, /github\.ref_protected == true/);
    assert.match(text, /environment:\s*firefox-signing/);

    const prepare = read("scripts/prepare-release.js");
    assert.match(prepare, /--porcelain=v1/);
    assert.match(prepare, /does not match checked-out HEAD/);
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
    assert.match(cli, /deployment client checkout must match/);
    assert.match(transaction, /snapshotLink/);
    assert.match(transaction, /restoreLink/);
    assert.match(transaction, /fsyncDirectory/);
    assert.doesNotMatch(transaction, /chmodSync\(targetDir|chmodSync\(releasesDir/);
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
