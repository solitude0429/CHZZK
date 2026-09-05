import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it("fails with a useful error when the package inspection tool is unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "chzzk-package-audit-"));
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "dist", `chzzk-${pkg.version}.zip`), "synthetic");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
    );
    env.PATH = directory;
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../../scripts/verify-package.js", import.meta.url))],
      { cwd: directory, env, encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Package audit could not run unzip \(ENOENT\)/);
    assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
