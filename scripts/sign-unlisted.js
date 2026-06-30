import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const missing = ["WEB_EXT_API_KEY", "WEB_EXT_API_SECRET"].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required signing environment variable(s): ${missing.join(", ")}`);
  console.error("Create Mozilla Add-ons API credentials and pass WEB_EXT_API_KEY / WEB_EXT_API_SECRET.");
  process.exit(2);
}

mkdirSync("dist/signed", { recursive: true });

const ignoreFiles = [
  ".github",
  ".git",
  ".hermes",
  "docs",
  "node_modules",
  "package-lock.json",
  "package.json",
  "policy",
  "reg",
  "scripts",
  "src",
  "tests",
];

const args = [
  "sign",
  "--channel=unlisted",
  "--source-dir=.",
  "--artifacts-dir=dist/signed",
  `--api-key=${process.env.WEB_EXT_API_KEY}`,
  `--api-secret=${process.env.WEB_EXT_API_SECRET}`,
  "--ignore-files",
  ...ignoreFiles,
];

const result = spawnSync("web-ext", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
