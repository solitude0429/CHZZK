import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { MAX_AMO_JSON_BYTES, MAX_SIGNED_XPI_BYTES, assertReleaseMetadata } from "./amo-client.js";

const SIGNED_XPI_NAME_RE = /^chzzk-(\d+\.\d+\.\d+)-signed\.xpi$/;

function assertRegularInput(path, environmentName, { executable = false, maxBytes = null } = {}) {
  if (typeof path !== "string" || !path) throw new Error(`${environmentName} is required`);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${environmentName} is not readable: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${environmentName} must name a regular file`);
  }
  if (stat.size <= 0 || (maxBytes !== null && stat.size > maxBytes)) {
    throw new Error(`${environmentName} has an invalid size`);
  }
  if (executable && (stat.mode & 0o111) === 0) {
    throw new Error(`${environmentName} must be executable`);
  }
  return stat;
}

function signedXpiVersion(path, environmentName) {
  const match = basename(path).match(SIGNED_XPI_NAME_RE);
  if (!match) throw new Error(`${environmentName} does not use the canonical signed XPI name`);
  return match[1];
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

export function validateSignedSmokeInputs({
  firefoxBinary,
  geckodriverBinary,
  metadataPath,
  mode,
  newSignedXpiPath,
  oldSignedXpiPath,
}) {
  if (!new Set(["install", "update"]).has(mode)) {
    throw new Error("CHZZK_SIGNED_SMOKE_MODE must be install or update");
  }
  assertRegularInput(firefoxBinary, "FIREFOX_BINARY", { executable: true });
  assertRegularInput(geckodriverBinary, "GECKODRIVER_BINARY", { executable: true });
  assertRegularInput(metadataPath, "CHZZK_RELEASE_METADATA", { maxBytes: MAX_AMO_JSON_BYTES });
  assertRegularInput(newSignedXpiPath, "CHZZK_SIGNED_XPI", { maxBytes: MAX_SIGNED_XPI_BYTES });

  let metadata;
  try {
    metadata = assertReleaseMetadata(JSON.parse(readFileSync(metadataPath, "utf8")));
  } catch (error) {
    throw new Error(`CHZZK_RELEASE_METADATA is invalid: ${error.message}`);
  }
  if (basename(metadataPath) !== `chzzk-${metadata.version}-release-metadata.json`) {
    throw new Error("CHZZK_RELEASE_METADATA does not use the canonical release metadata name");
  }
  const newVersion = signedXpiVersion(newSignedXpiPath, "CHZZK_SIGNED_XPI");
  if (newVersion !== metadata.version) {
    throw new Error("CHZZK_SIGNED_XPI version does not match release metadata");
  }

  let oldVersion = null;
  if (mode === "update") {
    assertRegularInput(oldSignedXpiPath, "CHZZK_OLD_SIGNED_XPI", {
      maxBytes: MAX_SIGNED_XPI_BYTES,
    });
    oldVersion = signedXpiVersion(oldSignedXpiPath, "CHZZK_OLD_SIGNED_XPI");
    if (compareVersions(oldVersion, newVersion) >= 0) {
      throw new Error("CHZZK_OLD_SIGNED_XPI must have an older version than the final signed XPI");
    }
  }

  return {
    firefoxBinary,
    geckodriverBinary,
    metadata,
    metadataPath,
    mode,
    newSignedXpiPath,
    oldSignedXpiPath: mode === "update" ? oldSignedXpiPath : null,
    oldVersion,
  };
}

export function buildProductionFirefoxCapabilities({ firefoxBinary, profileDir }) {
  return {
    alwaysMatch: {
      browserName: "firefox",
      pageLoadStrategy: "normal",
      "moz:firefoxOptions": {
        args: ["-headless", "--no-remote", "-remote-allow-system-access", "-profile", profileDir],
        binary: firefoxBinary,
      },
    },
  };
}

export function assertTrustedPermanentAddon({
  addon,
  expectedAddOnId,
  expectedUpdateUrl,
  expectedVersion,
  securityState,
}) {
  if (securityState?.appName !== "Firefox") throw new Error("Smoke gate requires stock Firefox");
  if (securityState.signaturesRequired !== true) {
    throw new Error("Firefox signature enforcement is not enabled");
  }
  if (securityState.signaturePreferenceHasUserValue !== false) {
    throw new Error("Firefox signature enforcement preference is not at its production default");
  }
  if (!addon || typeof addon !== "object") throw new Error("Expected add-on is not installed");
  if (addon.id !== expectedAddOnId) throw new Error("Installed add-on ID does not match release metadata");
  if (addon.version !== expectedVersion) {
    throw new Error("Installed add-on version does not match the expected release");
  }
  if (addon.temporarilyInstalled !== false) throw new Error("Installed add-on is not permanent");
  if (addon.signedState !== securityState.expectedSignedState) {
    throw new Error("Installed add-on does not have the expected Mozilla signed state");
  }
  if (addon.active !== true || addon.appDisabled !== false || addon.userDisabled !== false) {
    throw new Error("Installed add-on is not active and enabled");
  }
  if (addon.updateURL !== expectedUpdateUrl) {
    throw new Error("Installed add-on update URL does not match release metadata");
  }
  return addon;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function poll(action, { intervalMs = 100, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  if (lastError) throw lastError;
  throw new Error(`Firefox smoke gate timed out after ${timeoutMs}ms`);
}

class WebDriver {
  constructor(port) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.sessionId = null;
  }

  async request(method, path, body = undefined) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      method,
    });
    const payload = await response.json();
    if (!response.ok || payload.value?.error) {
      throw new Error(`WebDriver ${method} ${path} failed: ${JSON.stringify(payload.value ?? payload)}`);
    }
    return payload.value;
  }

  async createSession({ firefoxBinary, profileDir }) {
    const value = await this.request("POST", "/session", {
      capabilities: buildProductionFirefoxCapabilities({ firefoxBinary, profileDir }),
    });
    this.sessionId = value.sessionId ?? value.capabilities?.["moz:sessionId"];
    if (!this.sessionId) throw new Error("WebDriver did not return a Firefox session ID");
    await this.command("POST", "/timeouts", { script: 90_000 });
  }

  async command(method, suffix, body = undefined) {
    if (!this.sessionId) throw new Error("WebDriver session is not initialized");
    return this.request(method, `/session/${this.sessionId}${suffix}`, body);
  }

  async setContext(context) {
    return this.command("POST", "/moz/context", { context });
  }

  async executeAsync(script, args = []) {
    return this.command("POST", "/execute/async", { args, script });
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await this.request("DELETE", `/session/${this.sessionId}`);
    } finally {
      this.sessionId = null;
    }
  }
}

async function inspectAddon(driver, addOnId) {
  await driver.setContext("chrome");
  return driver.executeAsync(
    `const addonId = arguments[0];
const done = arguments[arguments.length - 1];
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const signaturePreference = "xpinstall.signatures.required";
AddonManager.getAddonByID(addonId).then((addon) => done({
  addon: addon ? {
    active: addon.isActive,
    appDisabled: addon.appDisabled,
    id: addon.id,
    signedState: addon.signedState,
    temporarilyInstalled: addon.temporarilyInstalled,
    updateURL: addon.updateURL,
    userDisabled: addon.userDisabled,
    version: addon.version,
  } : null,
  securityState: {
    appName: Services.appinfo.name,
    expectedSignedState: AddonManager.SIGNEDSTATE_SIGNED,
    signaturePreferenceHasUserValue: Services.prefs.prefHasUserValue(signaturePreference),
    signaturesRequired: Services.prefs.getBoolPref(signaturePreference, false),
  },
}), (error) => done({ error: String(error) }));`,
    [addOnId],
  );
}

async function installAndInspect(driver, xpiPath, expected) {
  await driver.command("POST", "/moz/addon/install", { path: xpiPath, temporary: false });
  const result = await poll(async () => {
    const inspected = await inspectAddon(driver, expected.expectedAddOnId);
    if (inspected?.error) throw new Error(`Firefox add-on inspection failed: ${inspected.error}`);
    return inspected?.addon ? inspected : null;
  });
  return assertTrustedPermanentAddon({ ...expected, ...result });
}

async function triggerAddonUpdate(driver, addOnId) {
  await driver.setContext("chrome");
  return driver.executeAsync(
    `const addonId = arguments[0];
const done = arguments[arguments.length - 1];
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
let finished = false;
const finish = (value) => { if (!finished) { finished = true; done(value); } };
setTimeout(() => finish({ status: "timeout" }), 60000);
AddonManager.getAddonByID(addonId).then((addon) => {
  if (!addon) return finish({ status: "missing" });
  addon.findUpdates({
    onNoUpdateAvailable() { finish({ current: addon.version, status: "no-update" }); },
    onUpdateAvailable(_addon, install) {
      install.addListener({
        onDownloadFailed(_install) { finish({ error: String(_install.error), status: "download-failed" }); },
        onInstallEnded(_install, installedAddon) {
          finish({ status: "installed", version: installedAddon.version });
        },
        onInstallFailed(_install) { finish({ error: String(_install.error), status: "install-failed" }); },
      });
      install.install();
    },
    onUpdateFinished(_addon, error) {
      if (error) finish({ error: String(error), status: "update-failed" });
    },
  }, AddonManager.UPDATE_WHEN_USER_REQUESTED);
}, (error) => finish({ error: String(error), status: "lookup-failed" }));`,
    [addOnId],
  );
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function startGeckodriver(binary) {
  const port = await reservePort();
  const logs = [];
  const child = spawn(binary, ["--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let processError = null;
  child.once("error", (error) => {
    processError = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => logs.push(chunk));
  }
  await poll(
    async () => {
      if (processError) throw processError;
      if (child.exitCode !== null) throw new Error(`geckodriver exited with status ${child.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`);
        return response.ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 10_000 },
  );
  return { child, logs, port };
}

async function stopGeckodriver(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function withDisposableFirefox({ firefoxBinary, port }, action) {
  const profileDir = mkdtempSync(join(tmpdir(), "chzzk-signed-firefox-profile-"));
  chmodSync(profileDir, 0o700);
  const driver = new WebDriver(port);
  try {
    await driver.createSession({ firefoxBinary, profileDir });
    return await action(driver);
  } finally {
    try {
      await driver.close();
    } finally {
      rmSync(profileDir, { force: true, recursive: true });
    }
  }
}

export async function runFirefoxSignedSmoke(rawInput) {
  const input = validateSignedSmokeInputs(rawInput);
  const service = await startGeckodriver(input.geckodriverBinary);
  const expectedFinal = {
    expectedAddOnId: input.metadata.addOnId,
    expectedUpdateUrl: input.metadata.updateManifestUrl,
    expectedVersion: input.metadata.version,
  };
  try {
    const finalInstall = await withDisposableFirefox(input, (driver) =>
      installAndInspect(driver, input.newSignedXpiPath, expectedFinal),
    );
    let update = null;
    if (input.mode === "update") {
      update = await withDisposableFirefox(input, async (driver) => {
        const before = await installAndInspect(driver, input.oldSignedXpiPath, {
          ...expectedFinal,
          expectedVersion: input.oldVersion,
        });
        const updateResult = await triggerAddonUpdate(driver, input.metadata.addOnId);
        if (updateResult?.status !== "installed" || updateResult.version !== input.metadata.version) {
          throw new Error(
            `Firefox old-to-new signed update failed: ${JSON.stringify({ before: before.version, updateResult })}`,
          );
        }
        const inspected = await poll(async () => {
          const state = await inspectAddon(driver, input.metadata.addOnId);
          return state?.addon?.version === input.metadata.version ? state : null;
        });
        const after = assertTrustedPermanentAddon({ ...expectedFinal, ...inspected });
        return { after: after.version, before: before.version, updateResult };
      });
    }
    return {
      addOnId: finalInstall.id,
      finalVersion: finalInstall.version,
      mode: input.mode,
      permanent: !finalInstall.temporarilyInstalled,
      signedState: finalInstall.signedState,
      update,
    };
  } catch (error) {
    const safeLogTail = service.logs.join("").split("\n").slice(-80).join("\n");
    throw new Error(`${error.message}\n--- geckodriver tail ---\n${safeLogTail}`);
  } finally {
    await stopGeckodriver(service.child);
  }
}
