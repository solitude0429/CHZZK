import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const expectedZip = `chzzk-${packageJson.version}.zip`;

const allowedFiles = new Set([
  "LICENSE",
  "NOTICE",
  "README.md",
  "background.js",
  "diagnostics.html",
  "diagnostics.js",
  "icon.png",
  "manifest.json",
]);

const zip = readdirSync("dist").find((name) => name === expectedZip);
assert.ok(zip, `dist/${expectedZip} must exist`);

const result = spawnSync("unzip", ["-Z1", `dist/${zip}`], { encoding: "utf8" });
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const files = result.stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .sort();

assert.deepEqual(files, [...allowedFiles].sort(), "package must contain only approved runtime files");

for (const forbidden of [
  "rules.json",
  "policy/",
  "scripts/",
  "src/",
  "tests/",
  "reg/",
  "package-lock.json",
]) {
  assert.equal(
    files.some((file) => file === forbidden || file.startsWith(forbidden)),
    false,
    `${forbidden} must not be packaged`,
  );
}

console.log(`package ${zip} contains only approved runtime files`);
