import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  checkFirefoxCompatibilityFreshness,
  validateFirefoxCompatibilityFreshness,
} from "../../scripts/check-firefox-compatibility-freshness.js";
import { validateCompatibilityPolicy } from "../../scripts/lib/compatibility-policy.js";

const policy = validateCompatibilityPolicy(
  JSON.parse(readFileSync(new URL("../../policy/compatibility-policy.json", import.meta.url), "utf8")),
);

function versionsDocument(overrides = {}) {
  return {
    FIREFOX_ESR: "140.12.0esr",
    FIREFOX_ESR_NEXT: "",
    LATEST_FIREFOX_VERSION: "152.0.6",
    NEXT_RELEASE_DATE: "2026-07-21",
    ...overrides,
  };
}

function jsonResponse(document, contentType = "application/json") {
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  return new Response(bytes, {
    headers: {
      "content-length": String(bytes.length),
      "content-type": contentType,
    },
    status: 200,
  });
}

describe("Firefox compatibility freshness", () => {
  it("accepts the pinned current release and declared ESR major", () => {
    assert.deepEqual(validateFirefoxCompatibilityFreshness(versionsDocument(), policy), {
      current: "152.0.6",
      esr: "140.12.0esr",
      esrNext: null,
      minimum: "140.0",
      nextReleaseDate: "2026-07-21",
    });
  });

  it("accepts the minimum during a Mozilla ESR transition", () => {
    const result = validateFirefoxCompatibilityFreshness(
      versionsDocument({
        FIREFOX_ESR: "139.12.0esr",
        FIREFOX_ESR_NEXT: "140.0.0esr",
      }),
      policy,
    );
    assert.equal(result.esr, "139.12.0esr");
    assert.equal(result.esrNext, "140.0.0esr");
  });

  it("rejects stale current and inactive ESR minimum profiles", () => {
    assert.throws(
      () =>
        validateFirefoxCompatibilityFreshness(versionsDocument({ LATEST_FIREFOX_VERSION: "153.0" }), policy),
      /stale.*153\.0/i,
    );
    assert.throws(
      () =>
        validateFirefoxCompatibilityFreshness(
          versionsDocument({
            FIREFOX_ESR: "141.1.0esr",
            FIREFOX_ESR_NEXT: "142.0.0esr",
          }),
          policy,
        ),
      /outside Mozilla ESR/i,
    );
  });

  it("rejects malformed official version metadata", () => {
    for (const document of [
      versionsDocument({ LATEST_FIREFOX_VERSION: "152.0.6b1" }),
      versionsDocument({ FIREFOX_ESR: "140.12" }),
      versionsDocument({ FIREFOX_ESR_NEXT: "141.0" }),
      versionsDocument({ FIREFOX_ESR_NEXT: null }),
      versionsDocument({ NEXT_RELEASE_DATE: "July 21, 2026" }),
      versionsDocument({ NEXT_RELEASE_DATE: "2026-02-30" }),
      { FIREFOX_ESR: "140.12.0esr", LATEST_FIREFOX_VERSION: "152.0.6" },
    ]) {
      assert.throws(
        () => validateFirefoxCompatibilityFreshness(document, policy),
        /canonical|invalid FIREFOX_ESR_NEXT|missing NEXT_RELEASE_DATE/i,
      );
    }
  });

  it("fetches the official response without redirects and validates bounded JSON", async () => {
    let request = null;
    const result = await checkFirefoxCompatibilityFreshness({
      fetchImpl: async (url, options) => {
        request = { options, url: String(url) };
        return jsonResponse(versionsDocument());
      },
      policy,
    });
    assert.equal(request.url, "https://product-details.mozilla.org/1.0/firefox_versions.json");
    assert.equal(request.options.redirect, "error");
    assert.equal(request.options.cache, "no-store");
    assert.equal(result.current, "152.0.6");
  });

  it("rejects wrong media types and exposes bounded network causes", async () => {
    await assert.rejects(
      () =>
        checkFirefoxCompatibilityFreshness({
          fetchImpl: async () => jsonResponse(versionsDocument(), "text/plain"),
          policy,
        }),
      /Content-Type/i,
    );

    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND product-details.mozilla.org"), {
      code: "ENOTFOUND",
    });
    await assert.rejects(
      () =>
        checkFirefoxCompatibilityFreshness({
          fetchImpl: async () => {
            throw Object.assign(new Error("fetch failed"), { cause });
          },
          policy,
        }),
      /request failed \[ENOTFOUND\].*product-details\.mozilla\.org/i,
    );
  });
});
