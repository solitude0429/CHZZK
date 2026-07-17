#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import JSZip from "jszip";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const addOnId = "chzzk@solitude0429.local";
const fixtureDomains = ["nvelop-livecloud.pstatic.net", "updates.chzzk.test", "www.chzzk.naver.com"];
const fixedZipDate = new Date("1980-01-01T00:00:00.000Z");
const testPolicy = {
  blockingProbeBudgetMs: 500,
  chzzkDomains: ["chzzk.naver.com"],
  defaultTarget: "highest-supported",
  directRewriteMaxQuality: "highest-supported",
  knownChzzkHlsPathMarkers: ["/chzzk/"],
  knownChzzkHlsRequestDomains: ["pstatic.net"],
  probeMaxBytes: 256000,
  probeResolutionBudgetMs: 3000,
  probeTimeoutMs: 1000,
  qualityCandidates: ["2160p", "1440p", "1080p", "720p", "480p", "360p"],
  redirectMethods: ["get"],
  redirectResourceTypes: ["media", "other", "xmlhttprequest"],
  strategy: "prefer-highest-supported",
  trustedInitiatorDomains: ["chzzk.naver.com"],
  trustedRequestDomains: ["pstatic.net"],
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function poll(action, { intervalMs = 100, timeoutMs = 15000 } = {}) {
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
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function makeExtensionXpi({ outputPath, port, runtimeDir, version }) {
  const productionManifest = JSON.parse(readFileSync(join(repoRoot, "manifest.json"), "utf8"));
  const manifest = {
    ...productionManifest,
    version,
    permissions: [
      "storage",
      "tabs",
      "webRequest",
      "webRequestBlocking",
      "https://*.chzzk.naver.com/live/*",
      "https://*.pstatic.net/*",
    ],
    content_scripts: [
      {
        js: ["site-observer.js"],
        matches: ["https://*.chzzk.naver.com/live/*"],
        run_at: "document_start",
      },
    ],
    browser_specific_settings: {
      gecko: {
        ...productionManifest.browser_specific_settings.gecko,
        strict_min_version: "140.0",
        update_url: `https://updates.chzzk.test:${port}/updates.json`,
      },
    },
  };

  const zip = new JSZip();
  const files = [
    ["background.js", join(runtimeDir, "background.js")],
    ["diagnostics.html", join(repoRoot, "diagnostics.html")],
    ["diagnostics.js", join(runtimeDir, "diagnostics.js")],
    ["icon-32.png", join(repoRoot, "icon-32.png")],
    ["icon-48.png", join(repoRoot, "icon-48.png")],
    ["icon-96.png", join(repoRoot, "icon-96.png")],
    ["icon.png", join(repoRoot, "icon.png")],
    ["site-observer.js", join(runtimeDir, "site-observer.js")],
  ];
  zip.file("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), {
    date: fixedZipDate,
    unixPermissions: 0o100644,
  });
  for (const [name, path] of files) {
    zip.file(name, readFileSync(path), { date: fixedZipDate, unixPermissions: 0o100644 });
  }
  const bytes = await zip.generateAsync({
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    type: "nodebuffer",
  });
  writeFileSync(outputPath, bytes, { mode: 0o600 });
  return bytes;
}

async function buildFixtureRuntime(outputDir) {
  await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryNames: "[name]",
    entryPoints: {
      background: "src/runtime/background.js",
      diagnostics: "src/runtime/diagnostics-page.js",
      "site-observer": "src/runtime/site-observer.js",
    },
    format: "iife",
    logLevel: "silent",
    outdir: outputDir,
    platform: "browser",
    plugins: [
      {
        name: "fixture-policy",
        setup(esbuild) {
          esbuild.onResolve({ filter: /quality-policy\.json$/ }, () => ({
            namespace: "fixture-policy",
            path: "quality-policy.json",
          }));
          esbuild.onLoad({ filter: /.*/, namespace: "fixture-policy" }, () => ({
            contents: JSON.stringify(testPolicy),
            loader: "json",
          }));
        },
      },
    ],
    sourcemap: false,
    target: ["firefox140"],
  });
}

function generateCertificate(directory) {
  const keyPath = join(directory, "server.key");
  const certificatePath = join(directory, "server.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-subj",
      "/CN=chzzk.test",
      "-addext",
      `subjectAltName=${fixtureDomains.map((domain) => `DNS:${domain}`).join(",")}`,
    ],
    { stdio: "ignore" },
  );
  chmodSync(keyPath, 0o600);
  return { certificatePath, keyPath };
}

function createFixtureServer({ certificatePath, keyPath, requests, state }) {
  return https.createServer(
    { cert: readFileSync(certificatePath), key: readFileSync(keyPath) },
    (request, response) => {
      const host = String(request.headers.host ?? "").split(":")[0];
      const requestUrl = new URL(request.url ?? "/", `https://${host}`);
      requests.push({ host, method: request.method, path: requestUrl.pathname, search: requestUrl.search });
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("cache-control", "no-store");

      if (host === "www.chzzk.naver.com" && requestUrl.pathname === "/live/test") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(`<!doctype html><meta charset="utf-8"><title>CHZZK E2E</title>
<div id="result">pending</div>
<script>
(async () => {
  try {
    const mediaUrl =
      "https://nvelop-livecloud.pstatic.net:${state.port}/chzzk/fixture/480p/segment/chunklist_480p_highbitrate.m3u8?Policy=synthetic&next=%2F480p%2F";
    await fetch(mediaUrl);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await fetch(mediaUrl);
    document.getElementById("result").textContent = response.status + ":" + (await response.text());
  } catch (error) {
    document.getElementById("result").textContent = "error:" + error.name + ":" + error.message;
  }
})();
</script>`);
        return;
      }

      if (host === "nvelop-livecloud.pstatic.net" && requestUrl.pathname.endsWith(".m3u8")) {
        const quality = requestUrl.pathname.match(
          /(?:chunklist_|\/)(\d{3,4}p)(?=(?:[_-][^/]*)?\.m3u8$|\/)/i,
        )?.[1];
        if (quality === "1080p" || quality === "720p" || quality === "480p") {
          response.statusCode = 200;
          response.setHeader("content-type", "application/vnd.apple.mpegurl");
          response.end(`#EXTM3U\n# fixture-quality=${quality}\n`);
        } else {
          response.statusCode = 404;
          response.end("not available");
        }
        return;
      }

      if (host === "updates.chzzk.test" && requestUrl.pathname === "/updates.json") {
        response.setHeader("content-type", "application/json");
        response.end(`${JSON.stringify(state.updateManifest)}\n`);
        return;
      }

      if (host === "updates.chzzk.test" && requestUrl.pathname === state.updateXpiPath) {
        response.setHeader("content-type", "application/x-xpinstall");
        response.end(state.updateXpiBytes);
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    },
  );
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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

  async createSession(firefoxBinary) {
    const value = await this.request("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          acceptInsecureCerts: true,
          browserName: "firefox",
          pageLoadStrategy: "normal",
          "moz:firefoxOptions": {
            args: ["-headless", "--no-remote", "-remote-allow-system-access"],
            binary: firefoxBinary,
            prefs: {
              "app.update.auto": false,
              "browser.shell.checkDefaultBrowser": false,
              "datareporting.policy.dataSubmissionPolicyBypassNotification": true,
              "devtools.chrome.enabled": true,
              "extensions.checkUpdateSecurity": false,
              "extensions.installDistroAddons": false,
              "extensions.install.requireBuiltInCerts": false,
              "extensions.update.autoUpdateDefault": true,
              "extensions.update.enabled": true,
              "extensions.update.interval": 1,
              "extensions.update.requireBuiltInCerts": false,
              "network.dns.disableIPv6": true,
              "network.dns.localDomains": fixtureDomains.join(","),
              "network.proxy.type": 0,
              "toolkit.telemetry.reportingpolicy.firstRun": false,
              "xpinstall.signatures.required": false,
            },
          },
        },
      },
    });
    this.sessionId = value.sessionId ?? value.capabilities?.["moz:sessionId"];
    if (!this.sessionId) throw new Error(`WebDriver did not return a session id: ${JSON.stringify(value)}`);
    return value;
  }

  async command(method, suffix, body = undefined) {
    if (!this.sessionId) throw new Error("WebDriver session is not initialized");
    return this.request(method, `/session/${this.sessionId}${suffix}`, body);
  }

  async setContext(context) {
    return this.command("POST", "/moz/context", { context });
  }

  async execute(script, args = []) {
    return this.command("POST", "/execute/sync", { args, script });
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

async function waitForGeckodriver(port, process, logLines) {
  return poll(
    async () => {
      if (process.exitCode !== null) {
        throw new Error(`geckodriver exited early: ${logLines.slice(-30).join("")}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`);
        return response.ok;
      } catch {
        return false;
      }
    },
    { intervalMs: 100, timeoutMs: 10000 },
  );
}

async function installedAddon(driver) {
  await driver.setContext("chrome");
  return driver.executeAsync(
    `const addonId = arguments[0];
const done = arguments[arguments.length - 1];
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
AddonManager.getAddonByID(addonId).then((addon) => {
  const policy = WebExtensionPolicy.getByID(addonId);
  done(addon ? {
    active: addon.isActive,
    baseUrl: policy ? policy.getURL("") : null,
    id: addon.id,
    signedState: addon.signedState,
    temporarilyInstalled: addon.temporarilyInstalled,
    updateURL: addon.updateURL,
    version: addon.version,
  } : null);
}, (error) => done({ error: String(error) }));`,
    [addOnId],
  );
}

async function triggerAddonUpdate(driver) {
  await driver.setContext("chrome");
  return driver.executeAsync(
    `const addonId = arguments[0];
const done = arguments[arguments.length - 1];
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
let finished = false;
const finish = (value) => { if (!finished) { finished = true; done(value); } };
setTimeout(() => finish({ status: "timeout" }), 20000);
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

async function main() {
  const firefoxBinary = process.env.FIREFOX_BINARY;
  const geckodriverBinary = process.env.GECKODRIVER_BINARY;
  assert.ok(firefoxBinary, "FIREFOX_BINARY is required");
  assert.ok(geckodriverBinary, "GECKODRIVER_BINARY is required");

  const workDir = mkdtempSync(join(tmpdir(), "chzzk-firefox-e2e-"));
  const runtimeDir = join(workDir, "runtime");
  const logs = [];
  const requests = [];
  const state = { port: null, updateManifest: null, updateXpiBytes: null, updateXpiPath: null };
  const { certificatePath, keyPath } = generateCertificate(workDir);
  const server = createFixtureServer({ certificatePath, keyPath, requests, state });
  let geckodriverProcess = null;
  const driverPort = 20000 + Math.floor(Math.random() * 20000);
  const driver = new WebDriver(driverPort);

  try {
    state.port = await listen(server);
    await buildFixtureRuntime(runtimeDir);
    const oldXpiPath = join(workDir, "chzzk-0.1.3.xpi");
    const updateXpiPath = join(workDir, "chzzk-0.1.4.xpi");
    await makeExtensionXpi({ outputPath: oldXpiPath, port: state.port, runtimeDir, version: "0.1.3" });
    state.updateXpiBytes = await makeExtensionXpi({
      outputPath: updateXpiPath,
      port: state.port,
      runtimeDir,
      version: "0.1.4",
    });
    state.updateXpiPath = "/releases/0.1.4/chzzk-0.1.4.xpi";
    state.updateManifest = {
      addons: {
        [addOnId]: {
          updates: [
            {
              applications: { gecko: { strict_min_version: "140.0" } },
              update_hash: `sha256:${sha256(state.updateXpiBytes)}`,
              update_link: `https://updates.chzzk.test:${state.port}${state.updateXpiPath}`,
              version: "0.1.4",
            },
          ],
        },
      },
    };

    geckodriverProcess = spawn(geckodriverBinary, ["--host", "127.0.0.1", "--port", String(driverPort)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [geckodriverProcess.stdout, geckodriverProcess.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => logs.push(chunk));
    }
    await waitForGeckodriver(driverPort, geckodriverProcess, logs);
    await driver.createSession(firefoxBinary);
    await driver.command("POST", "/moz/addon/install", { path: oldXpiPath, temporary: false });

    const before = await installedAddon(driver);
    assert.equal(before?.active, true);
    assert.equal(before?.id, addOnId);
    assert.equal(before?.version, "0.1.3");
    assert.match(before?.baseUrl ?? "", /^moz-extension:\/\//);

    await driver.setContext("content");
    await driver.command("POST", "/url", { url: `https://www.chzzk.naver.com:${state.port}/live/test` });
    const playbackResult = await poll(
      async () => {
        const text = await driver.execute(
          "return document.getElementById('result') && document.getElementById('result').textContent;",
        );
        return text && text !== "pending" ? text : null;
      },
      { intervalMs: 100, timeoutMs: 15000 },
    );
    if (!/^200:#EXTM3U\n# fixture-quality=1080p/m.test(playbackResult)) {
      await driver.command("POST", "/url", { url: `${before.baseUrl}diagnostics.html` });
      const diagnosticsPayload = await poll(
        async () => {
          const value = await driver.execute("return document.getElementById('payload')?.value || null;");
          return value ? value : null;
        },
        { timeoutMs: 5000 },
      );
      throw new Error(
        `Firefox playback stayed below 1080p: ${playbackResult}\nDiagnostics: ${diagnosticsPayload}`,
      );
    }
    const redirectedRequest = requests.find(
      (request) =>
        request.host === "nvelop-livecloud.pstatic.net" &&
        request.path.includes("/1080p/") &&
        request.path.includes("chunklist_1080p_highbitrate.m3u8"),
    );
    assert.ok(redirectedRequest, "Firefox did not issue the redirected 1080p playlist request");
    assert.equal(
      redirectedRequest.search,
      "?Policy=synthetic&next=%2F480p%2F",
      "runtime redirect must preserve the signed query byte-for-byte",
    );

    const updateResult = await triggerAddonUpdate(driver);
    if (updateResult?.status !== "installed" || updateResult?.version !== "0.1.4") {
      throw new Error(`Firefox update failed: ${JSON.stringify({ before, updateResult })}`);
    }
    const after = await poll(async () => {
      const addon = await installedAddon(driver);
      return addon?.version === "0.1.4" ? addon : null;
    });
    assert.equal(after.active, true);
    assert.equal(after.id, addOnId);
    assert.equal(after.version, "0.1.4");
    assert.equal(
      requests.some((request) => request.host === "updates.chzzk.test" && request.path === "/updates.json"),
      true,
    );
    assert.equal(
      requests.some(
        (request) => request.host === "updates.chzzk.test" && request.path === state.updateXpiPath,
      ),
      true,
    );

    console.log(
      JSON.stringify({
        firefox: basename(firefoxBinary),
        functionalOnly: true,
        installedAfter: after.version,
        installedBefore: before.version,
        playbackQuality: "1080p",
        queryPreserved: true,
        updatePath: "AddonManager.findUpdates",
      }),
    );
  } catch (error) {
    const safeLogs = logs.join("").split("\n").slice(-80).join("\n");
    console.error(
      `${error.stack ?? error.message}\n--- fixture requests ---\n${JSON.stringify(requests, null, 2)}\n--- geckodriver tail ---\n${safeLogs}`,
    );
    process.exitCode = 1;
  } finally {
    try {
      await driver.close();
    } catch {}
    if (geckodriverProcess && geckodriverProcess.exitCode === null) {
      geckodriverProcess.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => geckodriverProcess.once("exit", resolve)), delay(3000)]);
      if (geckodriverProcess.exitCode === null) geckodriverProcess.kill("SIGKILL");
    }
    await closeServer(server);
    rmSync(workDir, { force: true, recursive: true });
  }
}

await main();
