import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildProductionFirefoxCapabilities,
  startGeckodriver,
  stopGeckodriver,
} from "../../scripts/lib/firefox-signed-smoke.js";

const UPDATE_URL = "https://chzzk.home.arpa:8443/updates.json";

class Driver {
  constructor(port) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.sessionId = null;
  }

  async request(method, path, body) {
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
    const session = await this.request("POST", "/session", {
      capabilities: buildProductionFirefoxCapabilities({ firefoxBinary, profileDir }),
    });
    this.sessionId = session.sessionId ?? session.capabilities?.["moz:sessionId"];
    assert.ok(this.sessionId, "WebDriver did not return a Firefox session ID");
  }

  command(method, suffix, body) {
    assert.ok(this.sessionId, "Firefox session is not initialized");
    return this.request(method, `/session/${this.sessionId}${suffix}`, body);
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

const firefoxBinary = resolve(process.env.FIREFOX_BINARY ?? "");
const geckodriverBinary = resolve(process.env.GECKODRIVER_BINARY ?? "");
assert.ok(process.env.FIREFOX_BINARY, "FIREFOX_BINARY is required");
assert.ok(process.env.GECKODRIVER_BINARY, "GECKODRIVER_BINARY is required");

const service = await startGeckodriver(geckodriverBinary);
const profileDir = mkdtempSync(join(tmpdir(), "chzzk-router-firefox-profile-"));
chmodSync(profileDir, 0o700);
const driver = new Driver(service.port);
try {
  await driver.createSession({ firefoxBinary, profileDir });
  await driver.command("POST", "/url", { url: UPDATE_URL });
  const result = await driver.command("POST", "/execute/sync", {
    args: [],
    script: `return {
  body: document.body?.textContent ?? "",
  contentType: document.contentType,
  readyState: document.readyState,
  title: document.title,
  url: document.location.href,
};`,
  });
  assert.equal(result.url, UPDATE_URL);
  assert.equal(result.readyState, "complete");
  assert.equal(result.title, "404 Not Found");
  assert.match(result.body, /404 Not Found/);
  assert.notEqual(new URL(result.url).protocol, "about:");
  console.log(
    JSON.stringify({
      certificate: "trusted-by-stock-firefox",
      contentType: result.contentType,
      host: new URL(result.url).host,
      statusPage: result.title,
    }),
  );
} finally {
  try {
    await driver.close();
  } finally {
    await stopGeckodriver(service.child);
    rmSync(profileDir, { force: true, recursive: true });
  }
}
