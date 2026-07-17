import { readFileSync } from "node:fs";

const FIREFOX_VERSION_RE = /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})(?:\.(?:0|[1-9]\d{0,3}))?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SHA512_RE = /^[a-f0-9]{128}$/;
const ARCHITECTURES = Object.freeze({
  arm64: "linux-aarch64",
  x64: "linux-x86_64",
});
const SIGNED_SMOKE_PROFILES = Object.freeze(["current", "minimum"]);

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const desired = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(desired)) {
    throw new Error(`${label} has invalid schema keys: ${actual.join(", ")}`);
  }
}

function firefoxVersionParts(value, label) {
  if (typeof value !== "string" || !FIREFOX_VERSION_RE.test(value)) {
    throw new Error(`${label} must be a canonical Firefox version`);
  }
  return value.split(".").map(Number);
}

function compareFirefoxVersions(left, right) {
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function validateArchitectureMap(architectures, { digestKey, digestPattern, label, valueKeys }) {
  assertExactKeys(architectures, Object.keys(ARCHITECTURES), `${label} architectures`);
  for (const [architecture, expectedArchiveArchitecture] of Object.entries(ARCHITECTURES)) {
    const record = architectures[architecture];
    assertExactKeys(record, valueKeys, `${label} ${architecture}`);
    if (digestPattern.test(String(record[digestKey] ?? "")) === false) {
      throw new Error(`${label} ${architecture} ${digestKey} is invalid`);
    }
    if (
      Object.hasOwn(record, "archiveArchitecture") &&
      record.archiveArchitecture !== expectedArchiveArchitecture
    ) {
      throw new Error(`${label} ${architecture} archive architecture is invalid`);
    }
  }
}

function validateManifestCompatibility(manifest, policy) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest.json must be an object");
  }
  const browserSettings = manifest.browser_specific_settings;
  const desktopMinimum = browserSettings?.gecko?.strict_min_version;
  const androidMinimum = browserSettings?.gecko_android?.strict_min_version;
  if (desktopMinimum !== policy.desktop.minimumVersion) {
    throw new Error("Desktop minimum Firefox version does not match manifest.json");
  }
  if (androidMinimum !== policy.android.minimumVersion) {
    throw new Error("Android minimum Firefox version does not match manifest.json");
  }
}

export function validateCompatibilityPolicy(policy, { manifest = null } = {}) {
  assertExactKeys(policy, ["android", "desktop", "geckodriver", "schemaVersion"], "Compatibility policy");
  if (policy.schemaVersion !== 1) throw new Error("Compatibility policy schemaVersion must be 1");

  assertExactKeys(policy.android, ["minimumVersion", "releaseGate"], "Android compatibility policy");
  firefoxVersionParts(policy.android.minimumVersion, "Android minimum version");
  if (policy.android.releaseGate !== "manual-smoke") {
    throw new Error("Android release gate must be manual-smoke");
  }

  assertExactKeys(policy.desktop, ["minimumVersion", "signedSmokeProfiles"], "Desktop compatibility policy");
  const desktopMinimumParts = firefoxVersionParts(policy.desktop.minimumVersion, "Desktop minimum version");
  assertExactKeys(policy.desktop.signedSmokeProfiles, SIGNED_SMOKE_PROFILES, "Desktop signed-smoke profiles");
  for (const profileName of SIGNED_SMOKE_PROFILES) {
    const profile = policy.desktop.signedSmokeProfiles[profileName];
    assertExactKeys(profile, ["architectures", "firefoxVersion"], `${profileName} Firefox profile`);
    firefoxVersionParts(profile.firefoxVersion, `${profileName} Firefox version`);
    validateArchitectureMap(profile.architectures, {
      digestKey: "sha512",
      digestPattern: SHA512_RE,
      label: `${profileName} Firefox profile`,
      valueKeys: ["archiveArchitecture", "sha512"],
    });
  }
  if (policy.desktop.signedSmokeProfiles.minimum.firefoxVersion !== policy.desktop.minimumVersion) {
    throw new Error("Minimum signed-smoke profile must equal the declared desktop minimum");
  }
  const currentParts = firefoxVersionParts(
    policy.desktop.signedSmokeProfiles.current.firefoxVersion,
    "Current Firefox profile version",
  );
  if (compareFirefoxVersions(currentParts, desktopMinimumParts) < 0) {
    throw new Error("Current signed-smoke Firefox must not be older than the minimum profile");
  }

  assertExactKeys(policy.geckodriver, ["architectures", "version"], "geckodriver policy");
  firefoxVersionParts(policy.geckodriver.version, "geckodriver version");
  validateArchitectureMap(policy.geckodriver.architectures, {
    digestKey: "sha256",
    digestPattern: SHA256_RE,
    label: "geckodriver policy",
    valueKeys: ["asset", "sha256"],
  });
  for (const architecture of Object.keys(ARCHITECTURES)) {
    const asset = policy.geckodriver.architectures[architecture].asset;
    if (
      asset !==
      `geckodriver-v${policy.geckodriver.version}-${architecture === "arm64" ? "linux-aarch64" : "linux64"}.tar.gz`
    ) {
      throw new Error(`geckodriver ${architecture} asset is not canonical for the configured version`);
    }
  }

  if (manifest !== null) validateManifestCompatibility(manifest, policy);
  return policy;
}

export function loadCompatibilityPolicy({ manifest = null, path } = {}) {
  const policyPath = path ?? new URL("../../policy/compatibility-policy.json", import.meta.url);
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (error) {
    throw new Error(`Compatibility policy could not be loaded: ${error.message}`);
  }
  return validateCompatibilityPolicy(policy, { manifest });
}

export function resolveSignedSmokeToolchain(
  policy,
  { architecture = process.arch, profileName = "current" } = {},
) {
  validateCompatibilityPolicy(policy);
  if (!SIGNED_SMOKE_PROFILES.includes(profileName)) {
    throw new Error(`Unknown signed-smoke Firefox profile: ${profileName}`);
  }
  if (!Object.hasOwn(ARCHITECTURES, architecture)) {
    throw new Error(`Unsupported signed-smoke architecture: ${architecture}`);
  }

  const profile = policy.desktop.signedSmokeProfiles[profileName];
  const firefox = profile.architectures[architecture];
  const geckodriver = policy.geckodriver.architectures[architecture];
  return Object.freeze({
    firefoxArch: firefox.archiveArchitecture,
    firefoxSha512: firefox.sha512,
    firefoxUrl: `https://archive.mozilla.org/pub/firefox/releases/${profile.firefoxVersion}/${firefox.archiveArchitecture}/en-US/firefox-${profile.firefoxVersion}.tar.xz`,
    firefoxVersion: profile.firefoxVersion,
    geckodriverAsset: geckodriver.asset,
    geckodriverSha256: geckodriver.sha256,
    geckodriverUrl: `https://github.com/mozilla/geckodriver/releases/download/v${policy.geckodriver.version}/${geckodriver.asset}`,
    geckodriverVersion: policy.geckodriver.version,
    profileName,
  });
}
