#!/usr/bin/env node
import { resolve } from "node:path";

import { runFirefoxSignedSmoke } from "./lib/firefox-signed-smoke.js";

function configuredPath(name) {
  return process.env[name] ? resolve(process.env[name]) : undefined;
}

try {
  const result = await runFirefoxSignedSmoke({
    firefoxBinary: configuredPath("FIREFOX_BINARY"),
    geckodriverBinary: configuredPath("GECKODRIVER_BINARY"),
    metadataPath: configuredPath("CHZZK_RELEASE_METADATA"),
    mode: process.env.CHZZK_SIGNED_SMOKE_MODE ?? "install",
    newSignedXpiPath: configuredPath("CHZZK_SIGNED_XPI"),
    oldSignedXpiPath: configuredPath("CHZZK_OLD_SIGNED_XPI"),
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Stock Firefox signed-release smoke failed: ${error.message}`);
  process.exitCode = 1;
}
