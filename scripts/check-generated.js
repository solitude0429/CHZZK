import { spawnSync } from "node:child_process";

const build = spawnSync("npm", ["run", "build:runtime"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const diff = spawnSync(
  "git",
  ["diff", "--exit-code", "--", "background.js", "diagnostics.js", "site-observer.js"],
  {
    stdio: "inherit",
  },
);
if (diff.status !== 0) {
  console.error("Generated runtime files are stale. Run npm run build:runtime and commit the result.");
  process.exit(diff.status ?? 1);
}
