#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_DISCOVERY_OUTPUT_BYTES = 4096;
const MAX_EVIDENCE_BYTES = 4096;
const MAX_FAILURE_DETAIL_CHARACTERS = 512;
const EXPECTED_EVIDENCE_KEYS = Object.freeze([
  "extensionVersion",
  "finalUpdateState",
  "firefoxVersion",
  "installedState",
  "mode",
  "schemaVersion",
  "status",
]);

const TOOL_SPECS = Object.freeze({
  firefox: Object.freeze({
    environmentName: "FIREFOX_BINARY",
    executableName: "firefox.exe",
    packageName: "firefox-esr",
  }),
  geckodriver: Object.freeze({
    environmentName: "GECKODRIVER_BINARY",
    executableName: "geckodriver.exe",
    packageName: "geckodriver",
  }),
});

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be one nonempty path`);
  }
  return value;
}

export function parseArguments(argv) {
  const names = new Map([
    ["--metadata", "metadataPath"],
    ["--new-xpi", "newXpiPath"],
    ["--old-xpi", "oldXpiPath"],
    ["--result", "resultPath"],
  ]);
  if (!Array.isArray(argv) || argv.length !== names.size * 2) {
    throw new Error("Expected --metadata, --new-xpi, --old-xpi, and --result path arguments");
  }

  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const property = names.get(name);
    if (!property) throw new Error(`Unknown Windows signed-smoke argument: ${name}`);
    if (Object.hasOwn(parsed, property)) {
      throw new Error(`Duplicate Windows signed-smoke argument: ${name}`);
    }
    parsed[property] = requireText(argv[index + 1], name);
  }
  if (Object.keys(parsed).length !== names.size) {
    throw new Error("All Windows signed-smoke paths are required");
  }
  return parsed;
}

function nativeRealpath(path) {
  return realpathSync.native(path);
}

export function resolveCanonicalRegularFile(
  path,
  label,
  { lstat = lstatSync, realpath = nativeRealpath } = {},
) {
  const absolute = resolve(requireText(path, label));
  const unresolvedMetadata = lstat(absolute);
  if (unresolvedMetadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a reparse point`);
  }
  const canonical = realpath(absolute);
  const metadata = lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw new Error(`${label} must be a nonempty, non-reparse regular file`);
  }
  return canonical;
}

function resolveCanonicalDirectory(
  path,
  label,
  { lstat = lstatSync, realpath = nativeRealpath, rejectOriginalReparse = true } = {},
) {
  const absolute = resolve(requireText(path, label));
  const unresolvedMetadata = lstat(absolute);
  if (rejectOriginalReparse && unresolvedMetadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a reparse point`);
  }
  const canonical = realpath(absolute);
  const metadata = lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a non-reparse directory`);
  }
  return canonical;
}

export function parseScoopPrefix(stdout, packageName) {
  const text = String(stdout ?? "");
  if (Buffer.byteLength(text, "utf8") === 0 || Buffer.byteLength(text, "utf8") > MAX_DISCOVERY_OUTPUT_BYTES) {
    throw new Error(`scoop prefix ${packageName} returned invalid output`);
  }
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1 || !isAbsolute(lines[0]) || lines[0].includes("\0")) {
    throw new Error(`scoop prefix ${packageName} did not return one absolute path`);
  }
  return lines[0];
}

function failureDetail(result) {
  const raw = String(result?.stderr || result?.stdout || result?.error?.message || "command failed");
  return raw.replace(/\s+/gu, " ").trim().slice(0, MAX_FAILURE_DETAIL_CHARACTERS);
}

export function discoverScoopExecutable(
  { executableName, packageName },
  {
    runner = spawnSync,
    env = process.env,
    lstat = lstatSync,
    powershellBinary,
    realpath = nativeRealpath,
  } = {},
) {
  const powershell = requireText(powershellBinary, "Windows PowerShell");
  const result = runner(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", `scoop prefix ${packageName}`],
    {
      encoding: "utf8",
      env,
      maxBuffer: MAX_DISCOVERY_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
    },
  );
  if (result?.error || result?.status !== 0) {
    throw new Error(`scoop prefix ${packageName} failed: ${failureDetail(result)}`);
  }
  const prefix = resolveCanonicalDirectory(
    parseScoopPrefix(result.stdout, packageName),
    `${packageName} prefix`,
    {
      lstat,
      realpath,
      rejectOriginalReparse: false,
    },
  );
  return resolveCanonicalRegularFile(join(prefix, executableName), `${packageName} executable`, {
    lstat,
    realpath,
  });
}

function resolveTool(spec, dependencies) {
  const override = dependencies.env[spec.environmentName];
  if (override !== undefined && override !== "") {
    return resolveCanonicalRegularFile(override, spec.environmentName, dependencies);
  }
  return discoverScoopExecutable(spec, dependencies);
}

function prepareResultPath(path, dependencies) {
  const absolute = resolve(requireText(path, "--result"));
  const parent = resolveCanonicalDirectory(dirname(absolute), "Result parent", dependencies);
  const name = basename(absolute);
  if (name === "." || name === "..") throw new Error("--result must name a file");
  const canonical = join(parent, name);
  try {
    dependencies.lstat(canonical);
  } catch (error) {
    if (error?.code === "ENOENT") return canonical;
    throw error;
  }
  throw new Error("--result must not already exist");
}

function assertAbsoluteInvocationPath(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return path;
}

export function buildPowerShellArguments({
  firefoxBinary,
  geckodriverBinary,
  metadataPath,
  newXpiPath,
  nodeBinary,
  oldXpiPath,
  resultPath,
  wrapperPath,
}) {
  const paths = {
    firefoxBinary: assertAbsoluteInvocationPath(firefoxBinary, "FirefoxBinary"),
    geckodriverBinary: assertAbsoluteInvocationPath(geckodriverBinary, "GeckodriverBinary"),
    metadataPath: assertAbsoluteInvocationPath(metadataPath, "ReleaseMetadata"),
    newXpiPath: assertAbsoluteInvocationPath(newXpiPath, "SignedXpi"),
    nodeBinary: assertAbsoluteInvocationPath(nodeBinary, "NodeBinary"),
    oldXpiPath: assertAbsoluteInvocationPath(oldXpiPath, "OldSignedXpi"),
    resultPath: assertAbsoluteInvocationPath(resultPath, "ResultPath"),
    wrapperPath: assertAbsoluteInvocationPath(wrapperPath, "PowerShell wrapper"),
  };
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    paths.wrapperPath,
    "-NodeBinary",
    paths.nodeBinary,
    "-FirefoxBinary",
    paths.firefoxBinary,
    "-GeckodriverBinary",
    paths.geckodriverBinary,
    "-ReleaseMetadata",
    paths.metadataPath,
    "-SignedXpi",
    paths.newXpiPath,
    "-OldSignedXpi",
    paths.oldXpiPath,
    "-ResultPath",
    paths.resultPath,
  ];
}

export function parseBoundedEvidence(bytes, label = "Windows signed-smoke evidence") {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes ?? "");
  const size = Buffer.byteLength(text, "utf8");
  if (size === 0 || size > MAX_EVIDENCE_BYTES) throw new Error(`${label} is not bounded JSON`);
  let evidence;
  try {
    evidence = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error(`${label} schema is invalid`);
  }
  const keys = Object.keys(evidence).sort();
  if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_EVIDENCE_KEYS)) {
    throw new Error(`${label} schema is invalid`);
  }
  if (
    evidence.schemaVersion !== 1 ||
    evidence.status !== "passed" ||
    evidence.mode !== "update" ||
    evidence.installedState !== "permanent-signed-active" ||
    evidence.finalUpdateState !== "none-found" ||
    !/^[0-9][0-9A-Za-z.+-]{0,31}$/u.test(evidence.firefoxVersion) ||
    !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/u.test(evidence.extensionVersion)
  ) {
    throw new Error(`${label} values are invalid`);
  }
  return evidence;
}

export function runWindowsSignedUpdateSmoke(
  input,
  {
    env = process.env,
    lstat = lstatSync,
    platform = process.platform,
    processPath = process.execPath,
    readFile = readFileSync,
    realpath = nativeRealpath,
    runner = spawnSync,
    systemRoot = env.SystemRoot,
    wrapperPath = fileURLToPath(new URL("./firefox-signed-smoke.windows.ps1", import.meta.url)),
  } = {},
) {
  if (platform !== "win32") throw new Error("The Windows signed-update smoke requires Windows");
  const dependencies = { env, lstat, realpath, runner };
  const root = requireText(systemRoot, "SystemRoot");
  const powershellBinary = resolveCanonicalRegularFile(
    join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "Windows PowerShell",
    dependencies,
  );
  dependencies.powershellBinary = powershellBinary;
  const paths = {
    firefoxBinary: resolveTool(TOOL_SPECS.firefox, dependencies),
    geckodriverBinary: resolveTool(TOOL_SPECS.geckodriver, dependencies),
    metadataPath: resolveCanonicalRegularFile(input.metadataPath, "Release metadata", dependencies),
    newXpiPath: resolveCanonicalRegularFile(input.newXpiPath, "New signed XPI", dependencies),
    nodeBinary: resolveCanonicalRegularFile(processPath, "process.execPath", dependencies),
    oldXpiPath: resolveCanonicalRegularFile(input.oldXpiPath, "Old signed XPI", dependencies),
    resultPath: prepareResultPath(input.resultPath, dependencies),
    wrapperPath: resolveCanonicalRegularFile(wrapperPath, "PowerShell wrapper", dependencies),
  };
  const args = buildPowerShellArguments(paths);
  const result = runner(powershellBinary, args, {
    encoding: "utf8",
    env,
    maxBuffer: MAX_EVIDENCE_BYTES,
    shell: false,
    windowsHide: true,
  });
  if (result?.error || result?.status !== 0) {
    throw new Error(`Windows signed-update smoke failed: ${failureDetail(result)}`);
  }

  const persistedPath = resolveCanonicalRegularFile(paths.resultPath, "Signed-smoke result", dependencies);
  const persisted = parseBoundedEvidence(readFile(persistedPath), "Persisted signed-smoke evidence");
  const reported = parseBoundedEvidence(result.stdout, "PowerShell signed-smoke evidence");
  if (EXPECTED_EVIDENCE_KEYS.some((key) => reported[key] !== persisted[key])) {
    throw new Error("PowerShell evidence differs from the persisted signed-smoke result");
  }
  return persisted;
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    const evidence = runWindowsSignedUpdateSmoke(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify(evidence));
  } catch (error) {
    console.error(`Windows signed-update smoke orchestration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
