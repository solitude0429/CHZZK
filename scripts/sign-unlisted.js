import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  "codex-security-scans",
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

const tempDir = mkdtempSync(join(tmpdir(), "chzzk-web-ext-sign-"));
const configPath = join(tempDir, "web-ext-config.cjs");
writeFileSync(configPath, `module.exports = ${JSON.stringify({ sign: { apiKey, apiSecret } }, null, 2)};\n`, {
  mode: 0o600,
});
chmodSync(configPath, 0o600);

const args = [
  "sign",
  "--channel=unlisted",
  `--config=${configPath}`,
  "--no-config-discovery",
  "--source-dir=.",
  "--artifacts-dir=dist/signed",
  "--ignore-files",
  ...ignoreFiles,
];

let exitCode = 1;
try {
  const result = spawnSync("web-ext", args, {
    env: {
      ...process.env,
      WEB_EXT_API_KEY: "",
      WEB_EXT_API_SECRET: "",
    },
    stdio: "inherit",
  });
  if (result.error) console.error(result.error.message);
  exitCode = result.status ?? 1;
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}
process.exit(exitCode);
