import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

function normalizeCredential(name) {
  const value = process.env[name];
  if (!value) return null;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

const apiKey = normalizeCredential("WEB_EXT_API_KEY");
const apiSecret = normalizeCredential("WEB_EXT_API_SECRET");
const missing = [
  ["WEB_EXT_API_KEY", apiKey],
  ["WEB_EXT_API_SECRET", apiSecret],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(`Missing required signing environment variable(s): ${missing.join(", ")}`);
  console.error("Create Mozilla Add-ons API credentials and pass WEB_EXT_API_KEY / WEB_EXT_API_SECRET.");
  process.exit(2);
}

if (!/^user:\d+:\d+$/.test(apiKey)) {
  console.error("Invalid WEB_EXT_API_KEY shape.");
  console.error(
    'Use the Mozilla Add-ons "JWT issuer" value only. It normally looks like: user:<digits>:<digits>',
  );
  console.error("Do not paste an email, add-on ID, GitHub token, label text, or KEY=value assignment.");
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
  `--api-key=${apiKey}`,
  `--api-secret=${apiSecret}`,
  "--ignore-files",
  ...ignoreFiles,
];

const result = spawnSync("web-ext", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
