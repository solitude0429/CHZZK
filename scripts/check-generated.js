import { spawnSync } from "node:child_process";

const build = spawnSync("npm", ["run", "build:runtime"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const diff = spawnSync(
  "git",
  ["diff", "--name-only", "--", "background.js", "diagnostics.js", "site-observer.js"],
  {
    encoding: "utf8",
  },
);
if (diff.status !== 0) {
  process.stderr.write(diff.stderr);
  process.exit(diff.status ?? 1);
}

const changed = diff.stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (changed.length > 0) {
  console.warn(
    `Generated runtime files were refreshed by build:runtime: ${changed.join(", ")}. ` +
      "Commit regenerated artifacts before manual distribution.",
  );
}
