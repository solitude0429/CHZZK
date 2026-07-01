import { spawnSync } from "node:child_process";

const generatedFiles = ["background.js", "diagnostics.js", "site-observer.js"];

function generatedDiff() {
  const result = spawnSync("git", ["diff", "--", ...generatedFiles], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

const before = generatedDiff();
const build = spawnSync("npm", ["run", "build:runtime"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const after = generatedDiff();

if (before !== after) {
  process.stdout.write(after);
  console.error("Generated runtime files are stale. Run npm run build:runtime and commit the result.");
  process.exit(1);
}
