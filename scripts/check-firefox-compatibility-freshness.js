#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { loadCompatibilityPolicy } from "./lib/compatibility-policy.js";
import { readBoundedResponse } from "./lib/live-update-health.js";

const FIREFOX_VERSIONS_URL = new URL("https://product-details.mozilla.org/1.0/firefox_versions.json");
const MAX_FIREFOX_VERSIONS_BYTES = 64 * 1024;
const RELEASE_VERSION_RE = /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})(?:\.(?:0|[1-9]\d{0,3}))?$/;
const ESR_VERSION_RE = /^((?:0|[1-9]\d{0,3}))\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})esr$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requiredString(document, name) {
  const value = document?.[name];
  if (typeof value !== "string" || !value) {
    throw new Error(`Mozilla Firefox versions response is missing ${name}`);
  }
  return value;
}

function optionalString(document, name) {
  const value = document?.[name];
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new Error(`Mozilla Firefox versions response has invalid ${name}`);
  }
  return value;
}

function isCanonicalIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseEsrMajor(value, label) {
  const match = ESR_VERSION_RE.exec(value);
  if (!match) throw new Error(`Mozilla ${label} version is not canonical`);
  return Number(match[1]);
}

export function validateFirefoxCompatibilityFreshness(document, policy) {
  const latest = requiredString(document, "LATEST_FIREFOX_VERSION");
  const esr = requiredString(document, "FIREFOX_ESR");
  const esrNext = optionalString(document, "FIREFOX_ESR_NEXT");
  const nextReleaseDate = requiredString(document, "NEXT_RELEASE_DATE");
  if (!RELEASE_VERSION_RE.test(latest)) {
    throw new Error("Mozilla latest Firefox version is not canonical");
  }
  const activeEsrMajors = new Set([parseEsrMajor(esr, "Firefox ESR")]);
  if (esrNext) activeEsrMajors.add(parseEsrMajor(esrNext, "Firefox ESR next"));
  if (!isCanonicalIsoDate(nextReleaseDate)) {
    throw new Error("Mozilla next Firefox release date is not canonical");
  }

  const current = policy.desktop.signedSmokeProfiles.current.firefoxVersion;
  const minimum = policy.desktop.minimumVersion;
  const minimumMajor = Number(minimum.split(".", 1)[0]);
  if (current !== latest) {
    throw new Error(`Pinned current Firefox ${current} is stale; Mozilla latest is ${latest}`);
  }
  if (!activeEsrMajors.has(minimumMajor)) {
    const activeEsrVersions = [esr, esrNext].filter(Boolean).join(", ");
    throw new Error(`Declared minimum Firefox ${minimum} is outside Mozilla ESR ${activeEsrVersions}`);
  }

  return Object.freeze({
    current,
    esr,
    esrNext: esrNext || null,
    minimum,
    nextReleaseDate,
  });
}

export async function checkFirefoxCompatibilityFreshness({ fetchImpl = fetch, policy }) {
  let response;
  try {
    response = await fetchImpl(FIREFOX_VERSIONS_URL, {
      cache: "no-store",
      headers: { "user-agent": "CHZZK-Firefox-compatibility-freshness/1" },
      redirect: "error",
    });
  } catch (error) {
    const cause = error?.cause;
    const code = typeof cause?.code === "string" && cause.code ? ` [${cause.code}]` : "";
    const detail = String(cause?.message ?? error?.message ?? error)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    throw new Error(`Mozilla Firefox versions request failed${code}: ${detail || "unknown error"}`);
  }
  const bytes = await readBoundedResponse(response, {
    expectedMediaType: "application/json",
    label: "Mozilla Firefox versions",
    maxBytes: MAX_FIREFOX_VERSIONS_BYTES,
  });
  let document;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Mozilla Firefox versions response is not valid UTF-8 JSON");
  }
  return validateFirefoxCompatibilityFreshness(document, policy);
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const policy = loadCompatibilityPolicy();
    const result = await checkFirefoxCompatibilityFreshness({ policy });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Firefox compatibility freshness check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
