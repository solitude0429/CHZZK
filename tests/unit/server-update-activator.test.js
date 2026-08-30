import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { validateServerActivation, validateServerTransition } from "../../scripts/server-update-activator.js";

describe("server update activation validation", () => {
  it("enforces deploy and rollback direction inside the server activation lock", () => {
    const dependencies = { readCurrentVersion: () => "26.8.29" };
    assert.doesNotThrow(() =>
      validateServerTransition(
        { mode: "deploy", targetDir: "/srv/admin/chzzk-updates", version: "26.8.30" },
        dependencies,
      ),
    );
    assert.doesNotThrow(() =>
      validateServerTransition(
        { mode: "rollback", targetDir: "/srv/admin/chzzk-updates", version: "0.1.23" },
        dependencies,
      ),
    );
    assert.throws(
      () =>
        validateServerTransition(
          { mode: "deploy", targetDir: "/srv/admin/chzzk-updates", version: "0.1.23" },
          dependencies,
        ),
      /explicit rollback/i,
    );
    assert.throws(
      () =>
        validateServerTransition(
          { mode: "rollback", targetDir: "/srv/admin/chzzk-updates", version: "26.8.30" },
          dependencies,
        ),
      /older than/i,
    );
  });

  it("checks loopback and Caddy representations before committing a deployment", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "chzzk-server-activation-"));
    const currentDir = join(targetDir, "current");
    const xpiBytes = Buffer.from("signed xpi bytes");
    const metadata = { version: "26.8.30" };
    mkdirSync(currentDir);
    writeFileSync(join(targetDir, "updates.json"), '{"version":"26.8.30"}\n');
    writeFileSync(join(currentDir, "chzzk-26.8.30-signed.xpi"), xpiBytes);
    const calls = [];

    try {
      await validateServerActivation(
        {
          metadata,
          signedXpiSha256: "1c4c5642ce44122a3caddb0efe8662583bfeb15a369a1b51244d24191f6ba69e",
          targetDir,
        },
        {
          curlPath: "/synthetic/curl",
          request(...args) {
            calls.push(args);
          },
        },
      );

      assert.deepEqual(
        calls.map(([, baseUrl, path, , mime]) => ({ baseUrl, mime, path })),
        [
          { baseUrl: "http://127.0.0.1:18082", mime: "application/json", path: "/updates.json" },
          {
            baseUrl: "http://127.0.0.1:18082",
            mime: "application/x-xpinstall",
            path: "/releases/26.8.30/chzzk-26.8.30-signed.xpi",
          },
          {
            baseUrl: "https://chzzk.home.arpa:8443",
            mime: "application/json",
            path: "/updates.json",
          },
          {
            baseUrl: "https://chzzk.home.arpa:8443",
            mime: "application/x-xpinstall",
            path: "/releases/26.8.30/chzzk-26.8.30-signed.xpi",
          },
        ],
      );
    } finally {
      rmSync(targetDir, { force: true, recursive: true });
    }
  });

  it("rejects an activated XPI whose bytes differ from the verified release", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "chzzk-server-activation-"));
    const currentDir = join(targetDir, "current");
    mkdirSync(currentDir);
    writeFileSync(join(targetDir, "updates.json"), "{}\n");
    writeFileSync(join(currentDir, "chzzk-26.8.30-signed.xpi"), "different bytes");

    try {
      await assert.rejects(
        validateServerActivation(
          { metadata: { version: "26.8.30" }, signedXpiSha256: "0".repeat(64), targetDir },
          { curlPath: "/synthetic/curl", request: () => assert.fail("HTTP must not run") },
        ),
        /digest differs/i,
      );
    } finally {
      rmSync(targetDir, { force: true, recursive: true });
    }
  });
});
