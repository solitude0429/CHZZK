#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${script} exited with status ${result.status ?? "unknown"}`);
  }
}

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);

try {
  run(`${root}scripts/configure-repository.js`, args);
  run(`${root}scripts/configure-exact-head-review.js`, args);
} catch (error) {
  console.error(`Repository configuration failed: ${error.message}`);
  process.exitCode = 1;
}
