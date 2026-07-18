import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

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

  it("pins all actions and semantically separates build, secret, attestation, and staging authority", () => {
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
    assert.deepEqual(release.jobs.stage.permissions, { actions: "read", contents: "write" });

    const signText = JSON.stringify(release.jobs.sign);
    const attestText = JSON.stringify(release.jobs.attest);
    const stageText = JSON.stringify(release.jobs.stage);
    assert.match(signText, /secrets\.AMO_JWT_ISSUER/);
    assert.doesNotMatch(signText, /actions\/checkout|npm ci|npm install/);
    assert.doesNotMatch(attestText, /secrets\.|actions\/checkout|npm ci|npm install|node scripts/);
    assert.doesNotMatch(stageText, /secrets\.|actions\/checkout|npm ci|npm install|node scripts/);

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

  it("stages exact release assets and leaves immutable publication to the out-of-band administrator", () => {
    const text = read(".github/workflows/sign-unlisted.yml");
    const release = workflow("sign-unlisted.yml");
    const prepareRelease = release.jobs.prepare.steps.find((step) => step.id === "release").run;
    const packageJson = JSON.parse(read("package.json"));
    const bootstrap = read("scripts/admin-release-bootstrap.js");
    const finalizer = read("scripts/lib/release-finalize.js");
    const signing = read("docs/SIGNING.md");
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
    assert.equal(Object.hasOwn(packageJson.scripts, "release:dispatch"), false);
    assert.doesNotMatch(signing, /npm run release:dispatch/);
    assert.match(bootstrap, /\/immutable-releases/);
    assert.match(bootstrap, /enabled\s*!==\s*true/);
    assert.match(bootstrap, /repos\/\$\{repository\}\/dispatches/);
    assert.match(text, /reuse_existing/);
    assert.match(text, /draft_signed_ready/);
    assert.match(text, /gh release view/);
    assert.match(text, /cmp "\$SOURCE"/);
    assert.match(text, /--draft/);
    assert.doesNotMatch(text, /gh release edit "\$TAG" --draft=false/);
    assert.doesNotMatch(text, /\/immutable-releases/);
    assert.match(text, /sync_draft_assets/);
    assert.match(text, /gh release upload "\$TAG" "\$ASSET"/);
    assert.match(text, /--json isDraft/);
    assert.match(text, /--json isPrerelease/);
    assert.match(finalizer, /\/immutable-releases/);
    assert.match(finalizer, /"attestation",\s*"verify"/);
    assert.match(finalizer, /repos\/\$\{repository\}\/releases\/\$\{releaseId\}/);
    assert.match(finalizer, /"--method",\s*"PATCH"[\s\S]*"draft=false"/);
    assert.doesNotMatch(finalizer, /"release",\s*"edit"/);
    assert.doesNotMatch(signing, /node scripts\/finalize-release\.js/);
    assert.match(signing, /\.local\/libexec\/chzzk-release-bootstrap\.mjs/);
    assert.match(signing, /contents\/scripts\/admin-release-bootstrap\.js/);
    assert.match(signing, /GH_BINARY="\/usr\/local\/bin\/gh"/);
    assert.match(signing, /CHZZK_BOOTSTRAP_TOKEN/);
    assert.match(signing, /GH_CONFIG_DIR/);
    assert.match(signing, /XDG_CACHE_HOME/);
    assert.match(signing, /"\$GH_BINARY" api/);
    assert.doesNotMatch(signing, /\n\s*gh api/);
    assert.match(signing, /unset ALL_PROXY[\s\S]*NODE_EXTRA_CA_CERTS/);
    assert.match(bootstrap, /branches\/\$\{encodeURIComponent\(defaultBranch\)\}/);
    assert.match(bootstrap, /branchState\?\.protected !== true/);
    assert.match(bootstrap, /contents\/scripts\/finalize-release\.js\?ref=\$\{sourceSha\}/);
    assert.match(bootstrap, /data:text\/javascript;base64/);
    assert.match(bootstrap, /gitBlobSha/);
    assert.match(bootstrap, /CHZZK_RELEASE_TRUSTED_GH/);
    assert.match(bootstrap, /CHZZK_RELEASE_TRUSTED_GIT/);
    assert.match(bootstrap, /CHZZK_RELEASE_TRUSTED_GH_HOME/);
    assert.match(bootstrap, /GH_CONFIG_DIR/);
    assert.match(bootstrap, /XDG_CACHE_HOME/);
    assert.doesNotMatch(bootstrap, /HOME:\s*process\.env\.HOME/);
    for (const name of [
      "ALL_PROXY",
      "CURL_CA_BUNDLE",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "LD_AUDIT",
      "LD_LIBRARY_PATH",
      "LD_PRELOAD",
      "NODE_EXTRA_CA_CERTS",
      "NODE_OPTIONS",
      "NODE_PATH",
      "REQUESTS_CA_BUNDLE",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
      "XDG_CONFIG_HOME",
    ]) {
      assert.match(bootstrap, new RegExp(name));
    }
    assert.match(bootstrap, /env:\s*environments\[command\]/);
    assert.ok(
      bootstrap.indexOf("branchState?.protected !== true") < bootstrap.indexOf("await import"),
      "protected-head verification must precede repository entrypoint execution",
    );
    assert.doesNotMatch(signing, /(?:npm (?:run|exec)|npx)[^\n]*release:finalize/);
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

  it("runs the final AMO-signed XPI through stock Firefox before attestation and draft staging", () => {
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
    const functionalSetup = read("scripts/setup-firefox-e2e.js");
    assert.match(functionalSetup, /MAX_FIREFOX_ARCHIVE_BYTES/);
    assert.match(functionalSetup, /body\.getReader\(\)/);
    assert.doesNotMatch(functionalSetup, /response\.arrayBuffer\(\)/);
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
    assert.match(JSON.stringify(release.jobs.stage.needs), /verify-signed/);
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

  it("pins dependencies and ignores local secrets and generated release artifacts", () => {
    const packageJson = JSON.parse(read("package.json"));
    for (const [name, version] of Object.entries(packageJson.devDependencies)) {
      assert.doesNotMatch(version, /^[~^]/, `${name} must be exactly pinned`);
    }
    for (const [name, version] of Object.entries(packageJson.overrides)) {
      assert.equal(typeof version, "string", `${name} override must be a simple exact version`);
      assert.doesNotMatch(version, /^[~^]/, `${name} override must be exactly pinned`);
    }
    assert.equal(packageJson.overrides["adm-zip"], "0.6.0");
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

  it("requires trusted exact-head reviewer evidence with sole-owner branch protection", () => {
    const gate = workflow("review-gate.yml");
    const text = read(".github/workflows/review-gate.yml");
    const checker = read("scripts/check-review-gate.js");
    const settings = read("scripts/configure-review-gate.js");
    assert.equal(Object.hasOwn(gate.on, "pull_request_target"), true);
    assert.equal(Object.hasOwn(gate.on, "pull_request_review"), true);
    assert.equal(Object.hasOwn(gate.on, "pull_request_review_comment"), true);
    assert.equal(Object.hasOwn(gate.on, "issue_comment"), true);
    assert.equal(Object.hasOwn(gate.on, "workflow_dispatch"), true);
    assert.equal(gate.on.workflow_dispatch.inputs.force_generation.type, "string");
    assert.equal(gate.on.workflow_dispatch.inputs.force_generation.required, false);
    assert.deepEqual(gate.on.schedule, [{ cron: "*/15 * * * *" }]);
    assert.equal(Object.hasOwn(gate.on, "check_run"), false);
    assert.match(
      gate.concurrency.group,
      /workflow_dispatch[\s\S]*force_review[\s\S]*inputs\.pr_number[\s\S]*github\.run_id/,
      "durable force-review writes must use a unique non-cancelable concurrency group",
    );
    assert.match(
      gate.concurrency["cancel-in-progress"],
      /!.*workflow_dispatch.*force_review/,
      "ordinary PR evaluations must cancel stale in-progress runs",
    );
    assert.deepEqual(gate.jobs.evaluate.permissions, {
      contents: "read",
      issues: "read",
      "pull-requests": "read",
    });
    assert.deepEqual(gate.jobs["persist-force-review"].permissions, {
      actions: "write",
      checks: "write",
      issues: "write",
      "pull-requests": "read",
    });
    assert.match(gate.jobs["persist-force-review"].if, /workflow_dispatch.*force_review/);
    assert.match(String(gate["run-name"]), /force_review[\s\S]*force_generation[\s\S]*ordinary/);
    const persistForceText = JSON.stringify(gate.jobs["persist-force-review"]);
    const persistForceRun = gate.jobs["persist-force-review"].steps[0].run;
    assert.match(persistForceText, /security-review-required/);
    assert.match(persistForceText, /issues\/\$\{PR_NUMBER\}\/labels/);
    assert.match(persistForceText, /check-runs/);
    assert.match(persistForceText, /Forced automated review is pending/);
    assert.match(persistForceText, /external_id/);
    assert.match(persistForceText, /gh workflow run/);
    assert.match(persistForceText, /actions\/workflows\/review-gate\.yml\/runs/);
    assert.match(persistForceText, /actions\/runs\/\$\{RUN_ID\}\/cancel/);
    assert.match(persistForceRun, /display_title == \\"Review gate PR #\$\{PR_NUMBER\} ordinary\\"/);
    assert.match(persistForceRun, /\.event != \\"workflow_dispatch\\"/);
    const activeRunFilterLine = persistForceRun.split("\n").find((line) => line.includes('--jq "'));
    assert.ok(activeRunFilterLine, "the active-run jq filter must remain extractable for behavior tests");
    const trimmedFilterLine = activeRunFilterLine.trimEnd();
    assert.equal(trimmedFilterLine.endsWith('"'), true);
    const filterStart = trimmedFilterLine.indexOf('--jq "') + '--jq "'.length;
    const activeRunFilter = trimmedFilterLine
      .slice(filterStart, -1)
      .replaceAll('\\"', '"')
      .replaceAll("${GITHUB_RUN_ID}", "1000")
      .replaceAll("${PR_NUMBER}", "65");
    const cancelSelection = spawnSync("/usr/bin/jq", ["-r", activeRunFilter], {
      encoding: "utf8",
      input: JSON.stringify({
        workflow_runs: [
          {
            display_title: "Review gate PR #65 ordinary",
            event: "workflow_dispatch",
            id: 10,
            pull_requests: [],
            status: "in_progress",
          },
          {
            display_title: "Review gate PR #65 force",
            event: "workflow_dispatch",
            id: 11,
            pull_requests: [],
            status: "in_progress",
          },
          {
            display_title: "Review gate PR #65 forced-evaluation",
            event: "workflow_dispatch",
            id: 12,
            pull_requests: [],
            status: "in_progress",
          },
          {
            display_title: "legacy event title",
            event: "pull_request_review",
            id: 13,
            pull_requests: [{ number: 65 }],
            status: "queued",
          },
          {
            display_title: "Review gate PR #66 ordinary",
            event: "workflow_dispatch",
            id: 14,
            pull_requests: [],
            status: "in_progress",
          },
          {
            display_title: "Review gate PR #65 ordinary",
            event: "workflow_dispatch",
            id: 1000,
            pull_requests: [],
            status: "in_progress",
          },
        ],
      }),
    });
    assert.equal(cancelSelection.status, 0, cancelSelection.stderr);
    assert.deepEqual(cancelSelection.stdout.trim().split("\n"), ["10", "13"]);
    assert.match(persistForceText, /force_review=false/);
    assert.match(persistForceText, /force_generation/);
    assert.match(persistForceText, /reconcile=true/);
    assert.doesNotMatch(persistForceText, /actions\/checkout|npm\s|node scripts\//);
    assert.deepEqual(gate.jobs.evaluate.needs, ["persist-force-review"]);
    assert.match(JSON.stringify(gate.jobs.evaluate), /CHZZK_FORCE_REVIEW[\s\S]*force_generation/);
    assert.match(
      gate.jobs.evaluate.if,
      /!\(github\.event_name == 'workflow_dispatch' && inputs\.force_review\)/,
      "the non-cancelable label-persistence run must not publish a cached review result",
    );
    assert.deepEqual(gate.jobs.status.permissions, { checks: "write" });
    assert.deepEqual(gate.jobs.reconcile.permissions, {
      actions: "write",
      "pull-requests": "read",
    });
    const reconcileText = JSON.stringify(gate.jobs.reconcile);
    assert.match(reconcileText, /pulls\?state=open/);
    assert.match(reconcileText, /gh workflow run/);
    assert.match(reconcileText, /reconcile=true/);
    assert.doesNotMatch(reconcileText, /actions\/checkout|npm\s|node scripts\//);
    assert.match(JSON.stringify(gate.jobs.status), /check-runs\?check_name=/);
    assert.match(JSON.stringify(gate.jobs.status), /inputs\.reconcile/);
    const statusRun = gate.jobs.status.steps.find((step) =>
      String(step.name ?? "").includes("review completion check"),
    ).run;
    assert.match(statusRun, /select\(\.app\.slug == "github-actions"\)/);
    assert.match(statusRun, /CURRENT_EXTERNAL_ID/);
    assert.match(statusRun, /FORCE_GENERATION/);
    assert.match(statusRun, /max_by\(\.id\)/);
    assert.equal(statusRun.match(/gh api "\$CHECKS_ENDPOINT"/g)?.length, 1);
    const harness = mkdtempSync(join(dirname(rootDir), "chzzk-review-status-race-"));
    const fakeGh = join(harness, "gh");
    const staleMarker = join(harness, "stale-posted");
    const raceMarker = join(harness, "race-posted");
    const tieMarker = join(harness, "tie-posted");
    const matchingMarker = join(harness, "matching-posted");
    const getCount = join(harness, "get-count");
    try {
      writeFileSync(
        fakeGh,
        `#!/bin/sh\ncase " $* " in *" --method POST "*) : > "$TEST_POST_MARKER"; exit 0 ;; esac\nif [ "$TEST_TIE_MODE" = "true" ]; then\n  /usr/bin/printf '%s\\n' '{"check_runs":[{"id":200,"app":{"slug":"github-actions"},"conclusion":"failure","external_id":"force-review-123","output":{"summary":"Forced automated review is pending"},"started_at":"2026-07-16T23:00:00Z"},{"id":100,"app":{"slug":"github-actions"},"conclusion":"success","external_id":"review-gate-1","output":{"summary":"stale success"},"started_at":"2026-07-16T23:00:00Z"}]}'\n  exit 0\nfi\nif [ "$TEST_RACE_MODE" = "true" ]; then\n  COUNT=0\n  test ! -f "$TEST_GET_COUNT" || COUNT=$(/usr/bin/cat "$TEST_GET_COUNT")\n  COUNT=$((COUNT + 1))\n  /usr/bin/printf '%s\\n' "$COUNT" > "$TEST_GET_COUNT"\n  if [ "$COUNT" = "1" ]; then\n    /usr/bin/printf '%s\\n' '{"check_runs":[{"id":100,"app":{"slug":"github-actions"},"conclusion":"failure","external_id":"review-gate-1","output":{"summary":"old"},"started_at":"2026-07-16T22:59:00Z"}]}'\n    exit 0\n  fi\nfi\n/usr/bin/printf '%s\\n' '{"check_runs":[{"id":200,"app":{"slug":"github-actions"},"conclusion":"failure","external_id":"force-review-123","output":{"summary":"Forced automated review is pending"},"started_at":"2026-07-16T23:00:00Z"}]}'\n`,
      );
      chmodSync(fakeGh, 0o755);
      const runStatus = (forceGeneration, marker, raceMode = false, tieMode = false) =>
        spawnSync("/bin/bash", ["-c", statusRun], {
          encoding: "utf8",
          env: {
            DESCRIPTION: "No release/security-sensitive path, label, or force input",
            FORCE_GENERATION: forceGeneration,
            GH_TOKEN: "synthetic",
            GITHUB_REPOSITORY: "solitude0429/CHZZK",
            GITHUB_RUN_ID: "456",
            HEAD_SHA: "a".repeat(40),
            PATH: `${harness}:/usr/bin:/bin`,
            RECONCILE: "false",
            RUNNER_TEMP: harness,
            STATE: "success",
            TEST_POST_MARKER: marker,
            TEST_GET_COUNT: getCount,
            TEST_RACE_MODE: String(raceMode),
            TEST_TIE_MODE: String(tieMode),
          },
        });
      const stale = runStatus("", staleMarker);
      assert.notEqual(stale.status, 0, "an older run must not override a force-review failure marker");
      assert.equal(existsSync(staleMarker), false, "an older run must not post cached success");
      const tied = runStatus("", tieMarker, false, true);
      assert.notEqual(tied.status, 0, "check creation IDs must break same-second timestamp ties");
      assert.equal(existsSync(tieMarker), false, "a tied stale success must not outrank the force marker");
      const raced = runStatus("", raceMarker, true);
      assert.notEqual(raced.status, 0, "a force marker created after the first read must win");
      assert.equal(existsSync(raceMarker), false, "a stale run must recheck before posting success");
      const matching = runStatus("123", matchingMarker);
      assert.equal(matching.status, 0, matching.stderr);
      assert.equal(existsSync(matchingMarker), true, "the matching forced reevaluation must unlock status");
    } finally {
      rmSync(harness, { force: true, recursive: true });
    }
    const checkout = gate.jobs.evaluate.steps.find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    assert.equal(checkout.with.ref, "${{ github.event.repository.default_branch }}");
    assert.doesNotMatch(JSON.stringify(gate.jobs.status), /actions\/checkout|node scripts\/|npm\s/);
    assert.match(text, /AUTOMATED_REVIEW_LOGIN/);
    assert.match(text, /RELEASE_OPERATOR_LOGIN/);
    assert.match(text, /CHZZK_POLL_SECONDS/);
    assert.match(text, /CHZZK review completion/);
    assert.match(checker, /pulls\/\$\{pullNumber\}\/reviews/);
    assert.doesNotMatch(checker, /issues\/\$\{pullNumber\}\/reactions/);
    assert.match(checker, /issues\/comments\/\$\{comment\.id\}\/reactions/);
    assert.match(checker, /reviewerCompletionComments/);
    const commentEvidenceIndex = checker.lastIndexOf("const commentEvidence = listReviewCommentEvidence(");
    const revalidationStartIndex = checker.indexOf(
      "const reviewStateBefore = getJson(",
      commentEvidenceIndex,
    );
    const revalidatedReviewsIndex = checker.indexOf("reviews = paginatedArrays(", revalidationStartIndex);
    const revalidatedThreadsIndex = checker.indexOf(
      "reviewThreads = listReviewThreads(",
      revalidatedReviewsIndex,
    );
    const revalidationEndIndex = checker.indexOf(
      "const reviewStateAfter = getJson(",
      revalidatedThreadsIndex,
    );
    const stableSnapshotIndex = checker.indexOf("assertStablePullRequestSnapshot(", revalidationEndIndex);
    assert.ok(commentEvidenceIndex >= 0, "review comments must be collected");
    assert.ok(
      commentEvidenceIndex < revalidationStartIndex &&
        revalidationStartIndex < revalidatedReviewsIndex &&
        revalidatedReviewsIndex < revalidatedThreadsIndex &&
        revalidatedThreadsIndex < revalidationEndIndex &&
        revalidationEndIndex < stableSnapshotIndex,
      "head/activity/reviews/threads must be rebound after completion-comment collection",
    );
    assert.doesNotMatch(checker, /commits\/\$\{currentHeadSha\}/);
    const reviewGateLibrary = read("scripts/lib/review-gate.js");
    assert.match(reviewGateLibrary, /pullRequest\?\.updated_at/);
    assert.match(reviewGateLibrary, /Didn't find any major issues/);
    assert.match(reviewGateLibrary, /\{10,40\}/);
    assert.match(reviewGateLibrary, /normalizedBody !== core/);
    assert.match(reviewGateLibrary, /assertStablePullRequestSnapshot/);
    assert.match(settings, /required_status_checks/);
    assert.match(settings, /apps\/github-actions/);
    assert.match(settings, /required_conversation_resolution/);
    assert.match(settings, /protection\/enforce_admins/);
    assert.match(settings, /--apply/);
    assert.doesNotMatch(
      `${text}\n${checker}\n${settings}`,
      /AUTOMATED_REVIEW_APP_SLUG|AUTOMATED_REVIEW_CHECK_NAME/,
    );
    assert.doesNotMatch(settings, /required_approving_review_count|require_last_push_approval/);
    assert.match(settings, /required_pull_request_reviews:\s*null/);
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
