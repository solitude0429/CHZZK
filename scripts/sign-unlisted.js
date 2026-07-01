import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import JSZip from "jszip";

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
for (const entry of readdirSync("dist/signed")) {
  if (entry.endsWith(".xpi")) rmSync(join("dist", "signed", entry), { force: true });
}

const optionalSignedPackageFiles = ["LICENSE", "NOTICE", "README.md"];
const requiredSignedRuntimeFiles = [
  "background.js",
  "diagnostics.html",
  "diagnostics.js",
  "icon-32.png",
  "icon-48.png",
  "icon-96.png",
  "icon.png",
  "manifest.json",
];
const allowedRuntimeFiles = [...optionalSignedPackageFiles, ...requiredSignedRuntimeFiles];

const ignoreFiles = [
  ".github",
  ".git",
  ".hermes",
  "codex-security-scans",
  "docs",
  "node_modules",
  "ops",
  "package-lock.json",
  "package.json",
  "policy",
  "reg",
  "scripts",
  "src",
  "tests",
];

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function amoAuthHeader() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: apiKey,
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
  };
  const encoded = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", Buffer.from(apiSecret, "utf8")).update(encoded).digest("base64url");
  return `JWT ${encoded}.${signature}`;
}

async function amoFetch(url, options = {}) {
  const headers = {
    Accept: "application/json",
    "User-Agent": "chzzk-sign-unlisted",
    ...(options.headers || {}),
  };
  headers["Author" + "ization"] = amoAuthHeader();
  return fetch(url, {
    ...options,
    headers,
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])]),
    );
  }
  return value;
}

function buffersMatchSource(file, actual, expected) {
  if (file !== "manifest.json") return actual.equals(expected);
  return (
    JSON.stringify(stableJson(JSON.parse(actual.toString("utf8")))) ===
    JSON.stringify(stableJson(JSON.parse(expected.toString("utf8"))))
  );
}

async function verifySignedXpiMatchesSource(xpiPath) {
  const zip = await JSZip.loadAsync(await readFile(xpiPath));
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .sort();
  const runtimeEntries = entries.filter((entry) => !entry.startsWith("META-INF/")).sort();
  const allowedEntries = [...allowedRuntimeFiles].sort();
  const requiredEntries = [...requiredSignedRuntimeFiles].sort();
  const extraEntries = runtimeEntries.filter((entry) => !allowedEntries.includes(entry));
  const missingRequiredEntries = requiredEntries.filter((entry) => !runtimeEntries.includes(entry));

  if (extraEntries.length > 0 || missingRequiredEntries.length > 0) {
    throw new Error(
      `Signed XPI runtime files do not match expectations. Missing required: ${missingRequiredEntries.join(", ") || "none"}. Extra: ${extraEntries.join(", ") || "none"}.`,
    );
  }

  const comparableEntries = runtimeEntries.filter((entry) => allowedEntries.includes(entry));
  for (const file of comparableEntries) {
    const zipEntry = zip.file(file);
    if (!zipEntry) throw new Error(`Signed XPI is missing ${file}.`);
    const [actual, expected] = await Promise.all([zipEntry.async("nodebuffer"), readFile(file)]);
    if (!buffersMatchSource(file, actual, expected)) {
      throw new Error(`Signed XPI ${file} does not match the current source file.`);
    }
  }
}

function singleSignedXpiPath() {
  const files = readdirSync("dist/signed")
    .filter((entry) => entry.endsWith(".xpi"))
    .sort();
  if (files.length !== 1) {
    throw new Error(`Expected exactly one signed XPI in dist/signed, found ${files.length}.`);
  }
  return join("dist", "signed", files[0]);
}

async function downloadExistingSignedVersionIfPresent() {
  if (process.env.CHZZK_REUSE_EXISTING_AMO_VERSION === "0") return false;

  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  const addonId = manifest.browser_specific_settings?.gecko?.id;
  const version = manifest.version;
  if (!addonId || !version) return false;

  const versionUrl = new URL(
    `addon/${encodeURIComponent(addonId)}/versions/${encodeURIComponent(version)}/`,
    "https://addons.mozilla.org/api/v5/addons/",
  );
  const response = await amoFetch(versionUrl);
  if (response.status === 404) return false;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Checking existing AMO version failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  const versionData = await response.json();
  const file = versionData.file || {};
  if (file.status !== "public" || !file.url) {
    throw new Error("Existing AMO version is not yet public/downloadable; cannot safely reuse it.");
  }
  if (versionData.channel && versionData.channel !== "unlisted") {
    throw new Error(`Existing AMO version channel is ${versionData.channel}, expected unlisted.`);
  }

  const fileUrl = new URL(file.url, "https://addons.mozilla.org");
  if (fileUrl.protocol !== "https:" || !fileUrl.hostname.endsWith("addons.mozilla.org")) {
    throw new Error("Existing AMO signed XPI URL is not on addons.mozilla.org.");
  }

  const xpiResponse = await amoFetch(fileUrl);
  if (!xpiResponse.ok) {
    throw new Error(`Downloading existing AMO signed XPI failed: HTTP ${xpiResponse.status}`);
  }

  const fileName = basename(fileUrl.pathname) || `chzzk-${version}-signed.xpi`;
  const destination = join(
    "dist",
    "signed",
    fileName.endsWith(".xpi") ? fileName : `chzzk-${version}-signed.xpi`,
  );
  await writeFile(destination, Buffer.from(await xpiResponse.arrayBuffer()), { mode: 0o600 });
  await verifySignedXpiMatchesSource(destination);
  console.log(`Existing AMO signed XPI for version ${version} matches current source and was downloaded.`);
  return true;
}

if (await downloadExistingSignedVersionIfPresent()) {
  process.exit(0);
}

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

const webExtEnv = { ...process.env };
delete webExtEnv.WEB_EXT_API_KEY;
delete webExtEnv.WEB_EXT_API_SECRET;

let exitCode = 1;
try {
  const result = spawnSync("web-ext", args, {
    env: webExtEnv,
    stdio: "inherit",
  });
  if (result.error) console.error(result.error.message);
  exitCode = result.status ?? 1;
  if (exitCode === 0 && process.env.CHZZK_SKIP_SIGNED_XPI_VERIFY !== "1") {
    await verifySignedXpiMatchesSource(singleSignedXpiPath());
  }
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}
process.exit(exitCode);
