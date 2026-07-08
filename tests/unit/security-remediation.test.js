import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function workflowFiles() {
  return readdirSync(new URL("../../.github/workflows/", import.meta.url))
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .sort();
}

function workflowText(path) {
  return read(`.github/workflows/${path}`);
}

function runSignScriptWithStubbedWebExt(exitCode) {
  const tempRoot = mkdtempSync(join(repoRoot, ".tmp-chzzk-sign-test-"));
  const binDir = join(tempRoot, "bin");
  const webExtPath = join(binDir, "web-ext");
  mkdirSync(binDir);
  writeFileSync(
    webExtPath,
    `#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const configArg = args.find((arg) => arg.startsWith("--config="));
const artifactsArg = args.find((arg) => arg.startsWith("--artifacts-dir="));
assert.ok(configArg, "web-ext config path is required");
assert.ok(artifactsArg, "web-ext artifacts dir is required");
assert.equal(args.some((arg) => arg.startsWith("--api-key")), false);
assert.equal(args.some((arg) => arg.startsWith("--api-secret")), false);
assert.equal(args.includes("ops"), true);
assert.equal(Object.hasOwn(process.env, "WEB_EXT_API_KEY"), false);
assert.equal(Object.hasOwn(process.env, "WEB_EXT_API_SECRET"), false);
const config = readFileSync(configArg.slice("--config=".length), "utf8");
assert.match(config, /apiKey/);
assert.match(config, /apiSecret/);
process.exit(${exitCode});
`,
  );
  chmodSync(webExtPath, 0o700);

  const result = spawnSync(process.execPath, ["scripts/sign-unlisted.js"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      TMPDIR: tempRoot,
      WEB_EXT_API_KEY: "user:123:456",
      WEB_EXT_API_SECRET: "synthetic-secret-for-cleanup-test",
      CHZZK_REUSE_EXISTING_AMO_VERSION: "0",
      CHZZK_SKIP_SIGNED_XPI_VERIFY: "1",
      CHZZK_WEB_EXT_BIN: webExtPath,
    },
  });
  const leftovers = readdirSync(tempRoot).filter((entry) => entry.startsWith("chzzk-web-ext-sign-"));
  rmSync(tempRoot, { force: true, recursive: true });
  return { leftovers, result };
}

describe("Codex Security remediation guardrails", () => {
  it("rejects command-line delivery of AMO signing secrets", () => {
    const script = read("scripts/sign-unlisted.js");

    assert.equal(script.includes("--api-secret=${apiSecret}"), false);
    assert.equal(script.includes("--api-key=${apiKey}"), false);
    assert.match(script, /mkdtempSync|writeFileSync/);
    assert.match(script, /chmodSync\([^,]+,\s*0o600\)/);
    assert.match(script, /--config=/);
    assert.match(script, /delete\s+webExtEnv\.WEB_EXT_API_KEY/);
    assert.match(script, /delete\s+webExtEnv\.WEB_EXT_API_SECRET/);
  });

  it("removes temporary AMO signing config on web-ext success and failure", () => {
    for (const exitCode of [0, 7]) {
      const { leftovers, result } = runSignScriptWithStubbedWebExt(exitCode);

      assert.equal(result.status, exitCode, result.stderr || result.stdout);
      assert.deepEqual(leftovers, []);
    }
  });

  it("requires every size-matched runtime icon in signed XPI verification", () => {
    const script = read("scripts/sign-unlisted.js");

    for (const icon of ["icon-32.png", "icon-48.png", "icon-96.png", "icon.png"]) {
      assert.match(script, new RegExp(`"${icon.replace(".", "\\.")}"`));
    }
  });

  it("pins every GitHub Action reference to a full-length commit SHA", () => {
    for (const file of workflowFiles()) {
      const workflow = workflowText(file);
      for (const [lineNumber, line] of workflow.split(/\r?\n/).entries()) {
        const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/);
        if (!match || match[1].startsWith("./")) continue;
        assert.match(
          match[1],
          /^[^@]+@[a-f0-9]{40}$/,
          `${file}:${lineNumber + 1} must pin ${match[1]} to a full commit SHA`,
        );
      }
    }
  });

  it("keeps generated-file PR checks read-only and auto-commit on trusted events only", () => {
    const workflow = workflowText("sync-generated-release-files.yml");

    assert.match(workflow, /pull_request:/);
    assert.match(workflow, /permissions:\s*\n\s+contents: read/);
    assert.match(workflow, /if:\s*\$\{\{ github\.event_name == 'pull_request' \}\}/);
    assert.match(workflow, /if:\s*\$\{\{ github\.event_name != 'pull_request' \}\}/);
    assert.match(workflow, /permissions:\s*\n\s+contents: write/);
  });

  it("enables baseline repository security automation", () => {
    const dependabot = read(".github/dependabot.yml");
    const codeql = workflowText("codeql.yml");
    const scorecard = workflowText("scorecard.yml");

    assert.match(dependabot, /package-ecosystem:\s*npm/);
    assert.match(dependabot, /package-ecosystem:\s*github-actions/);
    assert.match(codeql, /github\/codeql-action\/init@[a-f0-9]{40}/);
    assert.match(codeql, /github\/codeql-action\/analyze@[a-f0-9]{40}/);
    assert.match(scorecard, /ossf\/scorecard-action@[a-f0-9]{40}/);
  });

  it("redacts URL userinfo before collector storage", () => {
    const code = String.raw`
import importlib.util
from pathlib import Path

module_path = Path("ops/chzzk-telemetry-collector.py")
spec = importlib.util.spec_from_file_location("collector", module_path)
collector = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(collector)
sanitized = collector.sanitize_url("https://user:pass@media.example:8443/private/live/1080p/seg.m3u8?Policy=secret")
assert "user" not in sanitized, sanitized
assert "pass" not in sanitized, sanitized
assert "@" not in sanitized, sanitized
assert sanitized == "https://media.example:8443/[redacted-path]/1080p.m3u8", sanitized
`;
    const result = spawnSync("python3", ["-c", code], { cwd: repoRoot, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it("requires protected signing gates, fresh AMO signing, and provenance attestation in the workflow", () => {
    const workflow = read(".github/workflows/sign-unlisted.yml");

    assert.match(workflow, /environment:\s*firefox-signing/);
    assert.match(workflow, /attestations:\s*write/);
    assert.match(workflow, /id-token:\s*write/);
    assert.match(workflow, /Enforce protected signing ref/);
    assert.match(workflow, /attest-build-provenance@[a-f0-9]{40}/);
    assert.match(workflow, /CHZZK_REUSE_EXISTING_AMO_VERSION:\s*["']0["']/);
    assert.equal(workflow.includes("Reuse existing release XPI"), false);
  });

  it("strictly validates AMO download hosts before reusing signed XPIs", () => {
    const script = read("scripts/sign-unlisted.js");

    assert.match(script, /hostname === "addons\.mozilla\.org"/);
    assert.match(script, /hostname\.endsWith\("\.addons\.mozilla\.org"\)/);
    assert.doesNotMatch(script, /hostname\.endsWith\("addons\.mozilla\.org"\)/);
  });

  it("requires update deployment provenance, explicit repo selection, and a clean worktree", () => {
    const deploy = read("scripts/deploy-internal-updates.js");

    assert.match(deploy, /run\("gh",\s*\[\s*"attestation",\s*"verify"/);
    assert.match(deploy, /CHZZK_SOURCE_COMMIT/);
    assert.match(deploy, /sourceDigest|sourceRepository|workflowRef/);
    assert.match(deploy, /const signerWorkflow = `\$\{sourceRepository\}\/\$\{workflowRef\}`/);
    assert.match(deploy, /"release",\s*"download",\s*tag,\s*"--repo",\s*sourceRepository/);
    assert.match(deploy, /git",\s*\["status",\s*"--porcelain"\]/);
    assert.match(deploy, /releasesDir|releaseDir/);
  });

  it("ignores local secrets and release artifacts outside dist", () => {
    const gitignore = read(".gitignore");

    for (const pattern of [
      ".env",
      ".env.*",
      "*.key",
      "*.pem",
      "*.p12",
      "*.xpi",
      "updates.json",
      "provenance.json",
    ]) {
      assert.match(gitignore, new RegExp(`(^|\\n)${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\n)`));
    }
  });

  it("keeps the hardening checklist aligned with local-only diagnostics", () => {
    const template = read(".github/PULL_REQUEST_TEMPLATE/hardening.md");

    assert.match(template, /No external telemetry endpoint is added to packaged runtime/);
    assert.match(template, /No new host permission is added without explicit review/);
    assert.doesNotMatch(template, /Collector telemetry is opt-in/);
  });

  it("requires collector authentication, quotas, and operator-context sanitization", () => {
    const collector = read("ops/chzzk-telemetry-collector.py");
    const summary = read("ops/chzzk-telemetry-summary.py");
    const context = read("ops/chzzk-telemetry-context.py");

    assert.match(collector, /CHZZK_TELEMETRY_HMAC_SECRET/);
    assert.match(collector, /verify_request_auth/);
    assert.match(collector, /MAX_REPORTS_PER_MINUTE/);
    assert.match(collector, /MAX_REPORT_FILE_BYTES/);
    assert.match(collector, /trust_proxy/);
    assert.match(summary, /errorCategories/);
    assert.equal(summary.includes('"lastErrors": last_errors'), false);
    assert.match(context, /untrusted_values_are_data_only/);
    assert.doesNotMatch(context, /"collectorHealth"\s*:/);
  });
});
