#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import JSZip from "jszip";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const addOnId = "chzzk@solitude0429.local";
const fixtureDomains = ["livecloud.akamaized.net", "updates.chzzk.test", "www.chzzk.naver.com"];
const fixedZipDate = new Date("1980-01-01T00:00:00.000Z");
const fixturePlaylistPollIntervalMs = 700;
const serverArrivalToleranceMs = 250;
const historicalControllerlessVersion = "0.1.18";
const productionManifest = JSON.parse(readFileSync(join(repoRoot, "manifest.json"), "utf8"));
const productionPolicy = JSON.parse(readFileSync(join(repoRoot, "policy/quality-policy.json"), "utf8"));
const testPolicy = {
  ...productionPolicy,
  // Accelerate only idle-evidence expiry; request/probe/failure timing stays
  // byte-for-byte aligned with the production policy.
  markerEvidenceTtlMs: 1000,
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

async function makeExtensionXpi({ includePlayerController = true, outputPath, port, runtimeDir, version }) {
  const manifest = {
    ...productionManifest,
    version,
    permissions: includePlayerController
      ? productionManifest.permissions
      : productionManifest.permissions.filter((permission) => permission !== "scripting"),
    content_scripts: includePlayerController
      ? productionManifest.content_scripts
      : [
          {
            js: ["site-observer.js"],
            matches: ["https://*.chzzk.naver.com/live", "https://*.chzzk.naver.com/live/*"],
            run_at: "document_start",
          },
        ],
    background: {
      persistent: true,
      scripts: ["background.js", "e2e-error-observer.js"],
    },
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
  ];
  if (includePlayerController) {
    files.push(["player-controller.js", join(runtimeDir, "player-controller.js")]);
  }
  files.push(["site-observer.js", join(runtimeDir, "site-observer.js")]);
  zip.file("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), {
    date: fixedZipDate,
    unixPermissions: 0o100644,
  });
  zip.file(
    "e2e-error-observer.js",
    Buffer.from(`browser.webRequest.onErrorOccurred.addListener(
  (details) => {
    browser.storage.local.set({
      chzzkE2eLastWebRequestError: String(details.error ?? ""),
    });
  },
  {
    types: ["media", "other", "xmlhttprequest"],
    urls: ["https://*.akamaized.net/*"],
  },
);
browser.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  let updatedUrl;
  try {
    updatedUrl = new URL(changeInfo && changeInfo.url);
  } catch {
    return;
  }
  if (
    updatedUrl.hostname !== "www.chzzk.naver.com" ||
    updatedUrl.pathname !== "/lives" ||
    updatedUrl.searchParams.get("keyword") !== "another-channel-live-to-mini"
  ) {
    return;
  }
  Promise.resolve()
    .then(() =>
      fetch(
        "https://livecloud.akamaized.net:" +
          updatedUrl.port +
          "/chzzk/fixture/transition-ack",
        { cache: "no-store" },
      ),
    )
    .catch(() => {});
});
`),
    { date: fixedZipDate, unixPermissions: 0o100644 },
  );
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
      "player-controller": "src/runtime/player-controller.js",
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

function releaseConcurrentProbeBatch(state) {
  const upperQualities = new Set(state.pendingProbeUpper.map(({ quality }) => quality));
  if (!state.pendingProbe1080 || !upperQualities.has("2160p") || !upperQualities.has("1440p")) {
    return;
  }

  state.probeBatchConcurrent = true;
  for (const pending of state.pendingProbeUpper.splice(0)) {
    if (pending.response.destroyed || pending.response.writableEnded) continue;
    pending.requestRecord.fixturePlaylistKind = "unavailable-upper-probe";
    pending.response.statusCode = 404;
    pending.response.end("not available");
  }
  const pending1080 = state.pendingProbe1080;
  state.pendingProbe1080 = null;
  pending1080.finishPlaylist();
}

function createFixtureServer({ certificatePath, keyPath, requests, state }) {
  return https.createServer(
    { cert: readFileSync(certificatePath), key: readFileSync(keyPath) },
    (request, response) => {
      const host = String(request.headers.host ?? "").split(":")[0];
      const requestUrl = new URL(request.url ?? "/", `https://${host}`);
      const requestRecord = {
        cacheRevalidation: false,
        host,
        method: request.method,
        path: requestUrl.pathname,
        search: requestUrl.search,
      };
      requests.push(requestRecord);
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("cache-control", "no-store");

      if (host === "livecloud.akamaized.net" && requestUrl.pathname === "/chzzk/fixture/transition-ack") {
        state.transitionAckCount += 1;
        const pendingMaster = state.pendingTransitionMaster;
        if (pendingMaster) {
          state.pendingTransitionMaster = null;
          state.transitionMasterReleasedByAck = true;
          pendingMaster.response.end(pendingMaster.body);
        }
        response.statusCode = 204;
        response.end();
        return;
      }

      if (host === "www.chzzk.naver.com" && requestUrl.pathname === "/") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(
          '<!doctype html><meta charset="utf-8"><title>CHZZK SPA entry</title><div id="result">home</div>',
        );
        return;
      }

      if (host === "www.chzzk.naver.com" && requestUrl.pathname === "/live/update-open") {
        state.updateOpenDocumentCount += 1;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(`<!doctype html><meta charset="utf-8"><title>CHZZK open-update E2E</title>
<div id="live_player_layout">
  <pzp-pc-layout></pzp-pc-layout>
  <pzp-pc-setting-quality-pane></pzp-pc-setting-quality-pane>
</div>
<script>
(() => {
  Object.defineProperty(window, "__chzzkUpdateDocumentToken", {
    configurable: false,
    value: "update-open-${state.updateOpenDocumentCount}",
    writable: false,
  });
  const player = document.querySelector("#live_player_layout > pzp-pc-layout");
  const pane = document.querySelector("#live_player_layout pzp-pc-setting-quality-pane");
  const trackEvents = new EventTarget();
  const tracks = [];
  tracks.addEventListener = trackEvents.addEventListener.bind(trackEvents);
  tracks.removeEventListener = trackEvents.removeEventListener.bind(trackEvents);
  tracks.dispatchEvent = trackEvents.dispatchEvent.bind(trackEvents);
  const addTrack = (value) => {
    const index = tracks.length;
    let selected = value.selected === true;
    const track = { label: value.label, width: value.width, height: value.height };
    Object.defineProperty(track, "selected", {
      get() { return selected; },
      set(next) {
        selected = next === true;
        if (!selected) return;
        tracks.selectedIndex = index;
        for (const [otherIndex, otherTrack] of tracks.entries()) {
          if (otherIndex !== index) otherTrack.selected = false;
        }
      },
    });
    tracks.push(track);
  };
  addTrack({ label: "ABR", width: 1920, height: 1080, selected: true });
  addTrack({ label: "720p", width: 1280, height: 720 });
  addTrack({ label: "1080p", width: 1920, height: 1080 });
  tracks.selectedIndex = 0;
  player.videoTracks = tracks;
  pane.filter = (track) => track.label !== "ABR";
  player.dispatchEvent(new Event("loadedmetadata"));
})();
</script>`);
        return;
      }

      if (
        host === "www.chzzk.naver.com" &&
        (requestUrl.pathname === "/live/test" ||
          requestUrl.pathname === "/live/gap-test" ||
          requestUrl.pathname === "/live/probe-test" ||
          requestUrl.pathname === "/lives")
      ) {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(`<!doctype html><meta charset="utf-8"><title>CHZZK E2E</title>
<div id="live_player_layout">
  <pzp-pc-layout></pzp-pc-layout>
  <pzp-pc-setting-quality-pane></pzp-pc-setting-quality-pane>
</div>
<div id="result">pending</div>
<script>
(() => {
  const player = document.querySelector("#live_player_layout > pzp-pc-layout");
  const pane = document.querySelector("#live_player_layout pzp-pc-setting-quality-pane");
  const trackEvents = new EventTarget();
  const tracks = [];
  tracks.addEventListener = trackEvents.addEventListener.bind(trackEvents);
  tracks.removeEventListener = trackEvents.removeEventListener.bind(trackEvents);
  tracks.dispatchEvent = trackEvents.dispatchEvent.bind(trackEvents);
  const addTrack = (value) => {
    const index = tracks.length;
    let selected = value.selected;
    const track = { label: value.label, width: value.width, height: value.height };
    Object.defineProperty(track, "selected", {
      get() { return selected; },
      set(next) {
        selected = next === true;
        if (!selected) return;
        tracks.selectedIndex = index;
        for (const [otherIndex, otherTrack] of tracks.entries()) {
          if (otherIndex !== index) otherTrack.selected = false;
        }
      },
    });
    tracks.push(track);
    return track;
  };
  addTrack({ label: "ABR", width: 1920, height: 1080, selected: true });
  addTrack({ label: "720p", width: 1280, height: 720, selected: false });
  tracks.selectedIndex = 0;
  player.videoTracks = tracks;
  pane.filter = (track) => track.label !== "ABR";
  player.dispatchEvent(new Event("loadedmetadata"));
  setTimeout(() => {
    addTrack({ label: "1080p", width: 1920, height: 1080, selected: false });
    tracks.dispatchEvent(new Event("addtrack"));
  }, 500);
})();
(async () => {
  try {
    const liveToMiniTransition = location.pathname === "/live/test";
    const gapScenario = location.pathname === "/live/gap-test";
    const probeScenario = location.pathname === "/live/probe-test";
    const fixtureName = probeScenario ? "probe-fixture" : gapScenario ? "gap-fixture" : "fixture";
    if (!probeScenario) {
      const masterUrl =
        "https://livecloud.akamaized.net:${state.port}/chzzk/" +
        fixtureName +
        "/stream_hls_playlist.m3u8?Policy=synthetic-master" +
        (liveToMiniTransition ? "&transition=live-to-mini" : "");
      const masterResponse = await fetch(masterUrl);
      if (liveToMiniTransition) {
        history.pushState({}, "", "/lives?keyword=another-channel-live-to-mini");
      }
      const masterBody = await masterResponse.text();
      if (!masterResponse.ok || !masterBody.startsWith("#EXTM3U")) {
        throw new Error("master fixture failed");
      }
    }
    const mediaPolicy = probeScenario
      ? "synthetic-probe-current"
      : gapScenario
        ? "synthetic-gap-current"
        : "synthetic";
    const mediaUrl =
      "https://livecloud.akamaized.net:${state.port}/chzzk/" +
      fixtureName +
      "/480p/segment/stream_hls_chunklist.m3u8?Policy=" +
      mediaPolicy +
      "&next=%2F480p%2F#client-only-fragment";
    let finalBody = "";
    let finalStatus = 0;
    const qualityHistory = [];
    const requestLimit = gapScenario ? 48 : probeScenario ? 20 : 4;
    for (let index = 0; index < requestLimit; index += 1) {
      const response = await fetch(mediaUrl);
      finalStatus = response.status;
      finalBody = await response.text();
      const observedQuality = finalBody.match(/# fixture-quality=(\\d{3,4}p)(?:-gap)?/)?.[1];
      if (observedQuality) qualityHistory.push(observedQuality);
      if (!liveToMiniTransition && location.pathname === "/lives" && index < 3) {
        history.pushState({}, "", "/lives?keyword=another-channel-" + (index + 1));
      }
      const recoveredAfterFallback =
        gapScenario &&
        qualityHistory.includes("720p") &&
        qualityHistory[qualityHistory.length - 1] === "1080p";
      if (recoveredAfterFallback || (probeScenario && observedQuality === "1080p")) break;
      if (index < requestLimit - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, probeScenario ? 100 : ${fixturePlaylistPollIntervalMs}),
        );
      }
    }
    const result = document.getElementById("result");
    result.dataset.qualityHistory = qualityHistory.join(",");
    result.textContent = finalStatus + ":" + finalBody;
  } catch (error) {
    document.getElementById("result").textContent = "error:" + error.name + ":" + error.message;
  }
})();
</script>`);
        return;
      }

      if (host === "livecloud.akamaized.net" && requestUrl.pathname.endsWith(".m3u8")) {
        if (requestUrl.pathname.endsWith("/stream_hls_playlist.m3u8")) {
          response.statusCode = 200;
          response.setHeader("content-type", "application/vnd.apple.mpegurl");
          const variantQuery = requestUrl.pathname.includes("/gap-fixture/")
            ? "Policy=synthetic-gap-master&next=%2Fmaster%2F"
            : "Policy=synthetic&next=%2F480p%2F";
          const masterBody = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8384000,RESOLUTION=1920x1080,FRAME-RATE=60.00
1080p/segment/stream_hls_chunklist.m3u8?${variantQuery}
#EXT-X-STREAM-INF:BANDWIDTH=3192000,RESOLUTION=1280x720,FRAME-RATE=60.00
720p/segment/stream_hls_chunklist.m3u8?${variantQuery}
`;
          if (requestUrl.searchParams.get("transition") === "live-to-mini") {
            const initialMasterChunk = "#EXTM3U\n";
            response.flushHeaders();
            response.write(initialMasterChunk);
            state.pendingTransitionMaster = {
              body: masterBody.slice(initialMasterChunk.length),
              response,
            };
          } else {
            response.end(masterBody);
          }
          return;
        }
        const quality = requestUrl.pathname.match(
          /(?:chunklist_|\/)(\d{3,4}p)(?=(?:[_-][^/]*)?\.m3u8$|\/)/i,
        )?.[1];
        if (quality === "1080p" || quality === "720p" || quality === "480p") {
          const finishPlaylist = () => {
            if (response.destroyed || response.writableEnded) return;
            const gapFixtureHigh = requestUrl.pathname.includes("/gap-fixture/") && quality === "1080p";
            const gapAttempt = state.gap1080ResponseCount;
            const gapOnly = gapFixtureHigh && gapAttempt < 2;
            if (gapFixtureHigh) {
              requestRecord.fixtureObservedAt = Date.now();
              state.gap1080ResponseCount += 1;
            }
            requestRecord.fixturePlaylistKind = gapFixtureHigh
              ? gapAttempt === 0
                ? "initial-gap"
                : gapAttempt === 1
                  ? "retry-gap"
                  : "usable"
              : "usable";
            const etag = `"fixture-${quality}-${requestRecord.fixturePlaylistKind}"`;
            response.setHeader("cache-control", "no-cache");
            response.setHeader("etag", etag);
            if (request.headers["if-none-match"] === etag) {
              requestRecord.cacheRevalidation = true;
              response.statusCode = 304;
              response.end();
              return;
            }
            response.statusCode = 200;
            response.setHeader("content-type", "application/vnd.apple.mpegurl");
            response.end(
              gapOnly
                ? `#EXTM3U\n# fixture-quality=${quality}-gap\n#EXT-X-TARGETDURATION:6\n#EXT-X-GAP\n#EXTINF:6.0,\nmissing-${quality}.ts\n`
                : `#EXTM3U\n# fixture-quality=${quality}\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment-${quality}.ts\n`,
            );
          };
          if (requestUrl.pathname.includes("/probe-fixture/")) {
            if (quality === "1080p" && !state.probeBatchConcurrent) {
              state.pendingProbe1080 = { finishPlaylist };
              releaseConcurrentProbeBatch(state);
              return;
            }
          }
          finishPlaylist();
        } else if (
          requestUrl.pathname.includes("/probe-fixture/") &&
          (quality === "2160p" || quality === "1440p")
        ) {
          if (state.probeBatchConcurrent) {
            requestRecord.fixturePlaylistKind = "unavailable-upper-probe";
            response.statusCode = 404;
            response.end("not available");
            return;
          }
          state.pendingProbeUpper.push({ quality, requestRecord, response });
          releaseConcurrentProbeBatch(state);
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
              // The >25-second recovery fixture must not race the explicit
              // AddonManager.UPDATE_WHEN_USER_REQUESTED update proof below.
              "extensions.update.autoUpdateDefault": false,
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

async function selectedPlayerQuality(driver) {
  return poll(
    async () =>
      driver.execute(`const player = document.querySelector("#live_player_layout > pzp-pc-layout");
const tracks = player && player.videoTracks;
const selectedIndex = Number(tracks && tracks.selectedIndex);
const selected = Number.isSafeInteger(selectedIndex) ? tracks[selectedIndex] : null;
let stored = null;
try {
  stored = JSON.parse(localStorage.getItem("live-player-video-track"));
} catch {}
if (!selected || selected.label !== "1080p" || selected.height !== 1080 || stored?.height !== 1080) {
  return null;
}
return {
  selected: { label: selected.label, width: selected.width, height: selected.height },
  stored,
};`),
    { intervalMs: 50, timeoutMs: 5000 },
  );
}

async function mountSpaPlayerFromHome(driver) {
  return driver.execute(`history.pushState({}, "", "/live/spa-entry?from=home");
const layout = document.createElement("div");
layout.id = "live_player_layout";
const player = document.createElement("pzp-pc-layout");
const pane = document.createElement("pzp-pc-setting-quality-pane");
layout.append(player, pane);
document.body.append(layout);
const trackEvents = new EventTarget();
const tracks = [];
tracks.addEventListener = trackEvents.addEventListener.bind(trackEvents);
tracks.removeEventListener = trackEvents.removeEventListener.bind(trackEvents);
tracks.dispatchEvent = trackEvents.dispatchEvent.bind(trackEvents);
const addTrack = (value) => {
  const index = tracks.length;
  let selected = value.selected === true;
  const track = { label: value.label, width: value.width, height: value.height };
  Object.defineProperty(track, "selected", {
    get() { return selected; },
    set(next) {
      selected = next === true;
      if (!selected) return;
      tracks.selectedIndex = index;
      for (const [otherIndex, otherTrack] of tracks.entries()) {
        if (otherIndex !== index) otherTrack.selected = false;
      }
    },
  });
  tracks.push(track);
};
addTrack({ label: "ABR", width: 1920, height: 1080, selected: true });
addTrack({ label: "720p", width: 1280, height: 720 });
addTrack({ label: "1080p", width: 1920, height: 1080 });
tracks.selectedIndex = 0;
player.videoTracks = tracks;
pane.filter = (track) => track.label !== "ABR";
player.dispatchEvent(new Event("loadedmetadata"));
return location.pathname;`);
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
  const state = {
    gap1080ResponseCount: 0,
    pendingProbe1080: null,
    pendingProbeUpper: [],
    pendingTransitionMaster: null,
    port: null,
    probeBatchConcurrent: false,
    transitionAckCount: 0,
    transitionMasterReleasedByAck: false,
    updateManifest: null,
    updateXpiBytes: null,
    updateXpiPath: null,
    updateOpenDocumentCount: 0,
  };
  const { certificatePath, keyPath } = generateCertificate(workDir);
  const server = createFixtureServer({ certificatePath, keyPath, requests, state });
  let geckodriverProcess = null;
  const driverPort = 20000 + Math.floor(Math.random() * 20000);
  const driver = new WebDriver(driverPort);

  try {
    state.port = await listen(server);
    await buildFixtureRuntime(runtimeDir);
    const updateVersion = productionManifest.version;
    const oldXpiPath = join(workDir, `chzzk-${historicalControllerlessVersion}.xpi`);
    const updateXpiPath = join(workDir, `chzzk-${updateVersion}.xpi`);
    const oldXpiBytes = await makeExtensionXpi({
      includePlayerController: false,
      outputPath: oldXpiPath,
      port: state.port,
      runtimeDir,
      version: historicalControllerlessVersion,
    });
    state.updateXpiBytes = await makeExtensionXpi({
      outputPath: updateXpiPath,
      port: state.port,
      runtimeDir,
      version: updateVersion,
    });
    const oldArchive = await JSZip.loadAsync(oldXpiBytes);
    const oldManifestEntry = oldArchive.file("manifest.json");
    assert.ok(oldManifestEntry, "the controller-less XPI must contain a manifest");
    const oldManifest = JSON.parse(await oldManifestEntry.async("string"));
    assert.equal(
      oldManifest.permissions.includes("scripting"),
      false,
      "the synthetic 0.1.18 XPI must not inherit the later scripting permission",
    );
    assert.deepEqual(oldManifest.content_scripts, [
      {
        js: ["site-observer.js"],
        matches: ["https://*.chzzk.naver.com/live", "https://*.chzzk.naver.com/live/*"],
        run_at: "document_start",
      },
    ]);
    assert.equal(
      oldArchive.file("player-controller.js"),
      null,
      "the synthetic 0.1.18 XPI must not contain the later player controller",
    );
    const updateArchive = await JSZip.loadAsync(state.updateXpiBytes);
    assert.ok(
      updateArchive.file("player-controller.js"),
      "the update XPI must package the MAIN-world player controller",
    );
    assert.equal(
      JSON.parse(await updateArchive.file("manifest.json").async("string")).content_scripts.some(
        (contentScript) =>
          contentScript.world === "MAIN" && contentScript.js?.includes("player-controller.js"),
      ),
      true,
      "the update manifest must register the packaged player controller in MAIN world",
    );
    state.updateXpiPath = `/releases/${updateVersion}/chzzk-${updateVersion}.xpi`;
    state.updateManifest = {
      addons: {
        [addOnId]: {
          updates: [
            {
              applications: { gecko: { strict_min_version: "140.0" } },
              update_hash: `sha256:${sha256(state.updateXpiBytes)}`,
              update_link: `https://updates.chzzk.test:${state.port}${state.updateXpiPath}`,
              version: updateVersion,
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
    assert.equal(before?.version, historicalControllerlessVersion);
    assert.match(before?.baseUrl ?? "", /^moz-extension:\/\//);

    await driver.setContext("content");
    await driver.command("POST", "/url", { url: `${before.baseUrl}diagnostics.html` });
    await poll(
      async () => {
        const payload = await driver.execute("return document.getElementById('payload')?.value || null;");
        return payload ? true : null;
      },
      { timeoutMs: 5000 },
    );

    const updateOpenUrl = `https://www.chzzk.naver.com:${state.port}/live/update-open`;
    await driver.setContext("content");
    await driver.command("POST", "/url", { url: updateOpenUrl });
    const updateOpenRequestsBefore = requests.filter(
      (request) => request.host === "www.chzzk.naver.com" && request.path === "/live/update-open",
    ).length;
    assert.equal(updateOpenRequestsBefore, 1);
    const updateOpenBefore = await driver.execute(`const player =
  document.querySelector("#live_player_layout > pzp-pc-layout");
const tracks = player && player.videoTracks;
return {
  documentToken: window.__chzzkUpdateDocumentToken ?? null,
  navigationEntryCount: performance.getEntriesByType("navigation").length,
  selectedLabel: tracks?.[tracks.selectedIndex]?.label ?? null,
  storageValue: localStorage.getItem("live-player-video-track"),
  timeOrigin: performance.timeOrigin,
  url: location.href,
};`);
    assert.deepEqual(updateOpenBefore, {
      documentToken: "update-open-1",
      navigationEntryCount: 1,
      selectedLabel: "ABR",
      storageValue: null,
      timeOrigin: updateOpenBefore.timeOrigin,
      url: updateOpenUrl,
    });

    const updateResult = await triggerAddonUpdate(driver);
    if (updateResult?.status !== "installed" || updateResult?.version !== updateVersion) {
      throw new Error(`Firefox update failed: ${JSON.stringify({ before, updateResult })}`);
    }
    const after = await poll(async () => {
      const addon = await installedAddon(driver);
      return addon?.version === updateVersion ? addon : null;
    });
    assert.equal(after.active, true);
    assert.equal(after.id, addOnId);
    assert.equal(after.version, updateVersion);
    assert.match(after.baseUrl ?? "", /^moz-extension:\/\//);
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

    await driver.setContext("content");
    const updatedOpenPlayerState = await selectedPlayerQuality(driver);
    assert.deepEqual(updatedOpenPlayerState, {
      selected: { label: "1080p", width: 1920, height: 1080 },
      stored: { label: "1080p", width: 1920, height: 1080 },
    });
    const updateOpenAfter = await driver.execute(`return {
  documentToken: window.__chzzkUpdateDocumentToken ?? null,
  navigationEntryCount: performance.getEntriesByType("navigation").length,
  timeOrigin: performance.timeOrigin,
  url: location.href,
};`);
    assert.deepEqual(updateOpenAfter, {
      documentToken: updateOpenBefore.documentToken,
      navigationEntryCount: updateOpenBefore.navigationEntryCount,
      timeOrigin: updateOpenBefore.timeOrigin,
      url: updateOpenBefore.url,
    });
    assert.equal(
      requests.filter(
        (request) => request.host === "www.chzzk.naver.com" && request.path === "/live/update-open",
      ).length,
      updateOpenRequestsBefore,
      "the open CHZZK document must not navigate or reload during the extension update",
    );
    assert.equal(
      await driver.execute(`const tracks =
  document.querySelector("#live_player_layout > pzp-pc-layout").videoTracks;
tracks[0].selected = true;
tracks.dispatchEvent(new Event("change"));
return tracks[tracks.selectedIndex].label;`),
      "ABR",
      "the fixture must expose a real post-update ABR reversion before controller recovery",
    );
    assert.equal((await selectedPlayerQuality(driver)).selected.label, "1080p");

    await driver.setContext("content");
    await driver.command("POST", "/url", {
      url: `https://www.chzzk.naver.com:${state.port}/`,
    });
    assert.equal(await mountSpaPlayerFromHome(driver), "/live/spa-entry");
    const spaEntryPlayerState = await selectedPlayerQuality(driver);
    assert.equal(spaEntryPlayerState.selected.label, "1080p");
    const ineligibleSelection = await driver.execute(`history.pushState({}, "", "/following");
const tracks = document.querySelector("#live_player_layout > pzp-pc-layout").videoTracks;
tracks[0].selected = true;
tracks.dispatchEvent(new Event("change"));
return tracks.selectedIndex;`);
    assert.equal(ineligibleSelection, 0);
    await delay(400);
    assert.equal(
      await driver.execute(`const tracks =
  document.querySelector("#live_player_layout > pzp-pc-layout").videoTracks;
return tracks[tracks.selectedIndex].label;`),
      "ABR",
      "the MAIN-world controller must not force a track after leaving an eligible player route",
    );
    await driver.execute(`history.pushState({}, "", "/live/spa-return?from=following");
document
  .querySelector("#live_player_layout > pzp-pc-layout")
  .videoTracks.dispatchEvent(new Event("change"));`);
    const spaReturnPlayerState = await selectedPlayerQuality(driver);
    assert.equal(spaReturnPlayerState.selected.label, "1080p");

    const requestCountBeforePlayback = requests.length;
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
      await driver.command("POST", "/url", { url: `${after.baseUrl}diagnostics.html` });
      const diagnosticsPayload = await poll(
        async () => {
          const value = await driver.execute("return document.getElementById('payload')?.value || null;");
          return value ? value : null;
        },
        { timeoutMs: 5000 },
      );
      const observedWebRequestError = await driver.executeAsync(
        `const done = arguments[arguments.length - 1];
browser.storage.local.get("chzzkE2eLastWebRequestError").then(
  (stored) => done(stored.chzzkE2eLastWebRequestError ?? null),
  (error) => done("storage-error:" + String(error)),
);`,
      );
      throw new Error(
        `Firefox playback stayed below 1080p: ${playbackResult}\nObserved webRequest error: ${observedWebRequestError}\nDiagnostics: ${diagnosticsPayload}`,
      );
    }
    const livePlayerState = await selectedPlayerQuality(driver);
    assert.deepEqual(livePlayerState, {
      selected: { label: "1080p", width: 1920, height: 1080 },
      stored: { label: "1080p", width: 1920, height: 1080 },
    });
    await driver.command("POST", "/url", { url: `${after.baseUrl}diagnostics.html` });
    const playbackDiagnostics = await poll(
      async () => {
        const value = await driver.execute("return document.getElementById('payload')?.value || null;");
        return value ? value : null;
      },
      { timeoutMs: 5000 },
    );
    const redirectedRequest = requests.find(
      (request) =>
        request.host === "livecloud.akamaized.net" &&
        request.path.includes("/1080p/") &&
        request.path.includes("stream_hls_chunklist.m3u8"),
    );
    assert.ok(redirectedRequest, "Firefox did not issue the redirected 1080p playlist request");
    assert.equal(
      redirectedRequest.search,
      "?Policy=synthetic&next=%2F480p%2F",
      "runtime redirect must preserve the signed query byte-for-byte",
    );
    const liveToMiniRequests = requests.slice(requestCountBeforePlayback);
    for (const unavailableQuality of ["2160p", "1440p"]) {
      const fallbackProbeCount = liveToMiniRequests.filter(
        (request) =>
          request.host === "livecloud.akamaized.net" && request.path.includes(`/${unavailableQuality}/`),
      ).length;
      if (fallbackProbeCount !== 0) {
        throw new Error(
          `Observed master evidence triggered ${fallbackProbeCount} ${unavailableQuality} fallback probe(s): ${playbackDiagnostics}`,
        );
      }
    }
    assert.equal(
      liveToMiniRequests.some(
        (request) =>
          request.host === "livecloud.akamaized.net" &&
          request.path.endsWith("/stream_hls_playlist.m3u8") &&
          request.search.includes("transition=live-to-mini"),
      ),
      true,
      "Firefox did not exercise a master response that crossed the live-to-mini transition",
    );
    assert.equal(
      state.transitionAckCount > 0 && state.transitionMasterReleasedByAck,
      true,
      "the master body was not gated on a background-observed live-to-mini transition",
    );

    const requestCountBeforeProbeScenario = requests.length;
    await driver.setContext("content");
    await driver.command("POST", "/url", {
      url: `https://www.chzzk.naver.com:${state.port}/live/probe-test`,
    });
    const probePlaybackResult = await poll(
      async () => {
        const text = await driver.execute(
          "return document.getElementById('result') && document.getElementById('result').textContent;",
        );
        return text && text !== "pending" ? text : null;
      },
      { intervalMs: 50, timeoutMs: 5000 },
    );
    assert.match(
      probePlaybackResult,
      /^200:#EXTM3U\n# fixture-quality=1080p/m,
      "the masterless numeric path did not converge to the concurrently proven 1080p rendition",
    );
    const probeScenarioRequests = requests.slice(requestCountBeforeProbeScenario);
    assert.equal(
      probeScenarioRequests.some(
        (request) =>
          request.host === "livecloud.akamaized.net" && request.path.includes("/probe-fixture/1080p/"),
      ),
      true,
      "the masterless Firefox scenario never probed 1080p",
    );
    for (const upperQuality of ["2160p", "1440p"]) {
      assert.equal(
        probeScenarioRequests.some(
          (request) =>
            request.host === "livecloud.akamaized.net" &&
            request.path.includes(`/probe-fixture/${upperQuality}/`),
        ),
        true,
        `the masterless Firefox scenario never started the ${upperQuality} probe`,
      );
    }
    assert.equal(
      probeScenarioRequests.some(
        (request) =>
          request.host === "livecloud.akamaized.net" &&
          request.path.includes("/probe-fixture/stream_hls_playlist.m3u8"),
      ),
      false,
      "the numeric-probe scenario unexpectedly received master evidence",
    );
    assert.equal(
      state.probeBatchConcurrent,
      true,
      "1080p was not requested while both unavailable upper-tier probes were still pending",
    );

    const requestCountBeforeGapScenario = requests.length;
    await driver.setContext("content");
    await driver.command("POST", "/url", {
      url: `https://www.chzzk.naver.com:${state.port}/live/gap-test`,
    });
    const gapPlaybackResult = await poll(
      async () => {
        const text = await driver.execute(
          "return document.getElementById('result') && document.getElementById('result').textContent;",
        );
        return text && text !== "pending" ? text : null;
      },
      { intervalMs: 100, timeoutMs: 40000 },
    );
    assert.match(
      gapPlaybackResult,
      /^200:#EXTM3U\n# fixture-quality=1080p\n/m,
      "Firefox did not automatically return to usable 1080p after the GAP fallback backoff",
    );
    const gapQualityHistory = await driver.execute(
      "return document.getElementById('result')?.dataset.qualityHistory || '';",
    );
    assert.match(
      gapQualityHistory,
      /(?:^|,)720p(?:,|$)/,
      "Firefox did not expose usable 720p playback while 1080p was GAP-only",
    );
    const gapQualities = gapQualityHistory.split(",");
    assert.equal(gapQualities[0], "1080p");
    assert.equal(gapQualities.at(-1), "1080p");
    const recoveryQualities = gapQualities.slice(1, -1);
    assert.equal(
      recoveryQualities.every((quality) => quality === "720p" || quality === "480p"),
      true,
      "GAP recovery exposed an unexpected quality outside the 720p fallback and original 480p request",
    );
    assert.equal(
      recoveryQualities.filter((quality) => quality === "480p").length <= 1,
      true,
      "the production 50ms fail-open budget exposed more than one original 480p request",
    );
    const gapScenarioRequests = requests.slice(requestCountBeforeGapScenario);
    const exactHighPath = "/chzzk/gap-fixture/1080p/segment/stream_hls_chunklist.m3u8";
    const highRequests = gapScenarioRequests.filter(
      (request) => request.host === "livecloud.akamaized.net" && request.path === exactHighPath,
    );
    const initialGap = highRequests.find((request) => request.fixturePlaylistKind === "initial-gap");
    const failedFirstRecovery = highRequests.find((request) => request.fixturePlaylistKind === "retry-gap");
    const usableRecoveries = highRequests.filter((request) => request.fixturePlaylistKind === "usable");
    const verifiedRecovery = usableRecoveries[0];
    const playerRecovery = usableRecoveries[1];
    assert.ok(initialGap, "Firefox did not exercise the initial 1080p GAP response");
    assert.ok(failedFirstRecovery, "Firefox did not exercise the first failed 1080p recovery");
    assert.equal(
      usableRecoveries.length,
      2,
      "Firefox must make one successful background verification and one later 1080p player request",
    );
    assert.ok(verifiedRecovery, "Firefox did not verify the recovered 1080p response");
    assert.ok(playerRecovery, "Firefox did not fetch 1080p after background verification");
    const initialGapIndex = gapScenarioRequests.indexOf(initialGap);
    const usableFallbackIndex = gapScenarioRequests.findIndex(
      (request) =>
        request.host === "livecloud.akamaized.net" &&
        request.path.includes("/gap-fixture/720p/") &&
        request.fixturePlaylistKind === "usable",
    );
    const failedFirstRecoveryIndex = gapScenarioRequests.indexOf(failedFirstRecovery);
    const verifiedRecoveryIndex = gapScenarioRequests.indexOf(verifiedRecovery);
    const playerRecoveryIndex = gapScenarioRequests.indexOf(playerRecovery);
    assert.equal(
      usableFallbackIndex > initialGapIndex,
      true,
      "Firefox did not request usable 720p media after the 1080p GAP response",
    );
    assert.equal(
      failedFirstRecoveryIndex > usableFallbackIndex,
      true,
      "Firefox did not attempt exact 1080p recovery after serving the 720p fallback",
    );
    assert.equal(
      verifiedRecoveryIndex > failedFirstRecoveryIndex,
      true,
      "Firefox did not verify 1080p after the first exact recovery failed",
    );
    assert.equal(
      playerRecoveryIndex > verifiedRecoveryIndex,
      true,
      "Firefox promoted 1080p without a distinct successful background verification",
    );
    assert.equal(
      gapScenarioRequests.some(
        (request) =>
          request.host === "livecloud.akamaized.net" && /\/gap-fixture\/(?:1440p|2160p)\//.test(request.path),
      ),
      false,
      "master recovery must not launch generic 1440p or 2160p probes",
    );
    const expectedRecoverySearch = "?Policy=synthetic-gap-current&next=%2F480p%2F";
    for (const recoveryRequest of [failedFirstRecovery, verifiedRecovery, playerRecovery]) {
      assert.equal(recoveryRequest.path, exactHighPath);
      assert.equal(
        recoveryRequest.search,
        expectedRecoverySearch,
        "recovery must use the current media query rather than a retained master URL",
      );
    }
    assert.equal(
      failedFirstRecovery.fixtureObservedAt - initialGap.fixtureObservedAt >=
        testPolicy.redirectFailureBackoffMs,
      true,
      "Firefox retried 1080p before the bounded failure backoff elapsed",
    );
    assert.equal(
      failedFirstRecovery.fixtureObservedAt - initialGap.fixtureObservedAt <=
        testPolicy.redirectFailureBackoffMs + fixturePlaylistPollIntervalMs * 3,
      true,
      "Firefox waited too long before the first 1080p recovery attempt",
    );
    assert.equal(
      verifiedRecovery.fixtureObservedAt - failedFirstRecovery.fixtureObservedAt >=
        testPolicy.failedTargetRecoveryProbeIntervalMs - serverArrivalToleranceMs,
      true,
      "Firefox repeated failed 1080p recovery before the fifteen-second interval, allowing only server-arrival skew",
    );
    assert.equal(
      verifiedRecovery.fixtureObservedAt - failedFirstRecovery.fixtureObservedAt <=
        testPolicy.failedTargetRecoveryProbeIntervalMs + fixturePlaylistPollIntervalMs * 3,
      true,
      "Firefox waited too long before repeating the 1080p recovery attempt",
    );
    await driver.command("POST", "/url", { url: `${after.baseUrl}diagnostics.html` });
    const gapDiagnostics = await poll(
      async () => {
        const stored = await driver.executeAsync(
          `const done = arguments[arguments.length - 1];
browser.storage.local.get("chzzkDiagnostics").then(
  ({ chzzkDiagnostics }) => done(chzzkDiagnostics ?? null),
  (error) => done({ storageError: String(error) }),
);`,
        );
        const transitions = stored?.runtimeTransitions;
        if (!Array.isArray(transitions)) return null;
        const observedInvalidation = transitions.some(
          (transition) =>
            transition.action === "invalidated" &&
            transition.fromQuality === "1080p" &&
            transition.reason === "response-body" &&
            transition.source === "redirect-response",
        );
        return observedInvalidation ? stored : null;
      },
      { timeoutMs: 5000 },
    );
    assert.equal(
      gapDiagnostics.runtimeTransitions.some(
        (transition) =>
          transition.action === "invalidated" &&
          transition.fromQuality === "1080p" &&
          transition.reason === "response-body" &&
          transition.source === "redirect-response",
      ),
      true,
      "the GAP-only response did not invalidate the selected 1080p target",
    );

    const redirectedCountBeforeMiniPlayer = requests.filter(
      (request) =>
        request.host === "livecloud.akamaized.net" &&
        request.path.includes("/1080p/") &&
        request.path.includes("stream_hls_chunklist.m3u8"),
    ).length;
    const requestCountBeforeMiniPlayer = requests.length;
    await driver.setContext("content");
    await driver.command("POST", "/url", {
      url: `https://www.chzzk.naver.com:${state.port}/lives?keyword=another-channel`,
    });
    const miniPlayerResult = await poll(
      async () => {
        const text = await driver.execute(
          "return document.getElementById('result') && document.getElementById('result').textContent;",
        );
        return text && text !== "pending" ? text : null;
      },
      { intervalMs: 100, timeoutMs: 15000 },
    );
    assert.match(
      miniPlayerResult,
      /^200:#EXTM3U\n# fixture-quality=1080p/m,
      "same-origin list/search page did not retain redirected mini-player quality",
    );
    const miniPlayerState = await selectedPlayerQuality(driver);
    assert.deepEqual(miniPlayerState, {
      selected: { label: "1080p", width: 1920, height: 1080 },
      stored: { label: "1080p", width: 1920, height: 1080 },
    });
    assert.equal(
      requests.filter(
        (request) =>
          request.host === "livecloud.akamaized.net" &&
          request.path.includes("/1080p/") &&
          request.path.includes("stream_hls_chunklist.m3u8"),
      ).length > redirectedCountBeforeMiniPlayer,
      true,
      "Firefox did not expose the /lives-initiated playlist to the extension",
    );
    const miniPlayerRequests = requests.slice(requestCountBeforeMiniPlayer);
    for (const unavailableQuality of ["2160p", "1440p"]) {
      assert.equal(
        miniPlayerRequests.filter(
          (request) =>
            request.host === "livecloud.akamaized.net" && request.path.includes(`/${unavailableQuality}/`),
        ).length,
        0,
        `observed mini-player master evidence triggered a ${unavailableQuality} fallback probe`,
      );
    }
    assert.equal(
      miniPlayerRequests.some(
        (request) =>
          request.cacheRevalidation &&
          request.host === "livecloud.akamaized.net" &&
          request.path.includes("/1080p/"),
      ),
      true,
      "Firefox did not exercise the 304 cached-playlist revalidation path",
    );

    console.log(
      JSON.stringify({
        cacheRevalidation: "304",
        clientFragmentNormalized: true,
        firefox: basename(firefoxBinary),
        functionalOnly: true,
        gapSegmentRecovery: "1080p-gap-to-720p-to-1080p",
        manifestScope: "production-required-permissions",
        installedAfter: after.version,
        installedBefore: before.version,
        liveToMiniTransition: "background-acknowledged-in-flight-master-pushState",
        masterResponsePreselection: true,
        miniPlayerCycles: 4,
        miniPlayerPage: "/lives",
        miniPlayerRouteChanges: 3,
        numericProbeBatch: "2160p+1440p+1080p-concurrent",
        playbackQuality: "1080p",
        playerLateTrackUpgrade: "720p-to-1080p-addtrack",
        playerSelectedQuality: miniPlayerState.selected.label,
        playerSpaLifecycle: "home-to-live-to-ineligible-to-live",
        playerStorageQuality: miniPlayerState.stored.label,
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
    } catch {
      // Cleanup continues even when the disposable browser is already gone.
    }
    if (geckodriverProcess && geckodriverProcess.exitCode === null) {
      geckodriverProcess.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => geckodriverProcess.once("exit", resolve)), delay(3000)]);
      if (geckodriverProcess.exitCode === null) geckodriverProcess.kill("SIGKILL");
    }
    if (state.pendingTransitionMaster) {
      state.pendingTransitionMaster.response.destroy();
      state.pendingTransitionMaster = null;
    }
    for (const pending of state.pendingProbeUpper.splice(0)) {
      pending.response.destroy();
    }
    state.pendingProbe1080 = null;
    await closeServer(server);
    rmSync(workDir, { force: true, recursive: true });
  }
}

await main();
