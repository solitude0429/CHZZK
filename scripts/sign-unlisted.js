#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { signPreparedAddon } from "./lib/amo-client.js";

function rejectCredentialArguments(argv) {
  const forbidden =
    /^(?:--?(?:api[-_]?key|api[-_]?secret|amo[-_]?api[-_]?key|amo[-_]?api[-_]?secret))(?:=|$)/i;
  if (argv.some((value) => forbidden.test(value))) {
    throw new Error("AMO credentials must be supplied only through environment variables");
  }
}

try {
  rejectCredentialArguments(process.argv.slice(2));
  const apiKey = process.env.AMO_API_KEY;
  const apiSecret = process.env.AMO_API_SECRET;
  delete process.env.AMO_API_KEY;
  delete process.env.AMO_API_SECRET;

  const metadataPath = resolve(process.env.CHZZK_RELEASE_METADATA ?? "");
  const sourceArchivePath = resolve(process.env.CHZZK_UNSIGNED_XPI ?? "");
  if (!process.env.CHZZK_RELEASE_METADATA || !process.env.CHZZK_UNSIGNED_XPI) {
    throw new Error("CHZZK_RELEASE_METADATA and CHZZK_UNSIGNED_XPI are required");
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const outputDir = resolve(process.env.CHZZK_SIGNED_OUTPUT_DIR ?? dirname(sourceArchivePath));
  const result = await signPreparedAddon({
    apiKey,
    apiSecret,
    metadata,
    outputDir,
    sourceArchivePath,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`AMO signing failed: ${error.message}`);
  process.exitCode = 1;
}
