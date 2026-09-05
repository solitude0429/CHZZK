import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("rejects image-size findings instead of treating them as a tooling exception", () => {
  const directory = mkdtempSync(join(tmpdir(), "chzzk-audit-reject-"));
  try {
    const npmCli = join(directory, "npm.cjs");
    writeFileSync(
      npmCli,
      'console.log(JSON.stringify({vulnerabilities: {"image-size": {severity: "high"}}})); process.exitCode = 1;',
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../../scripts/audit-dependencies.js", import.meta.url))],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, npm_execpath: npmCli },
        windowsHide: true,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm audit found vulnerabilities: image-size:high/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("reports unavailable registry audits as unverified without exposing the raw response", () => {
  const directory = mkdtempSync(join(tmpdir(), "chzzk-audit-error-"));
  try {
    const npmCli = join(directory, "npm.cjs");
    writeFileSync(
      npmCli,
      'console.log(JSON.stringify({error: {}, message: "synthetic-private-detail"})); process.exitCode = 1;',
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../../scripts/audit-dependencies.js", import.meta.url))],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, npm_execpath: npmCli },
        windowsHide: true,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /registry request failed; vulnerability status is unverified/);
    assert.doesNotMatch(result.stderr, /synthetic-private-detail/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
