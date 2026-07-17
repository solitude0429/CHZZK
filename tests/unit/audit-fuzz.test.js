import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  AUDIT_FUZZ_CASE_COUNT,
  AUDIT_FUZZ_CATEGORY_COUNTS,
  AUDIT_FUZZ_LIMITS,
  AUDIT_FUZZ_SEED,
  AuditFuzzFailure,
  runAuditFuzz,
} from "../../scripts/audit-fuzz.js";

const categoryNames = Object.keys(AUDIT_FUZZ_CATEGORY_COUNTS);

function reducedCounts(overrides = {}) {
  return Object.fromEntries(categoryNames.map((category) => [category, overrides[category] ?? 0]));
}

describe("audit fuzz harness", () => {
  it("defines a balanced, bounded, deterministic 100,000-case contract", () => {
    const counts = Object.values(AUDIT_FUZZ_CATEGORY_COUNTS);
    assert.equal(
      counts.reduce((total, count) => total + count, 0),
      AUDIT_FUZZ_CASE_COUNT,
    );
    assert.equal(AUDIT_FUZZ_CASE_COUNT, 100_000);
    assert.equal(Math.max(...counts) - Math.min(...counts), 1);
    assert.deepEqual(categoryNames, [
      "url_rewrites",
      "quality_markers",
      "playlist_families",
      "hls_master_parsing",
      "playlist_evidence",
      "request_policy",
      "diagnostics",
    ]);
    assert.deepEqual(AUDIT_FUZZ_LIMITS, {
      maxCases: 100_000,
      maxCollectionItems: 64,
      maxInputCharacters: 8192,
    });

    const countsForUnitTest = reducedCounts({
      diagnostics: 4,
      hls_master_parsing: 10,
      playlist_evidence: 10,
      playlist_families: 8,
      quality_markers: 8,
      request_policy: 12,
      url_rewrites: 8,
    });
    const first = runAuditFuzz({ categoryCounts: countsForUnitTest, seed: AUDIT_FUZZ_SEED });
    const second = runAuditFuzz({ categoryCounts: countsForUnitTest, seed: AUDIT_FUZZ_SEED });

    assert.deepEqual(first, second);
    assert.equal(first.seed, "0x5a17c0de");
    assert.equal(first.caseCount, 60);
    assert.deepEqual(first.categories, countsForUnitTest);
    assert.equal(first.assertionCount > first.caseCount, true);
    assert.equal(first.maxInputCharacters <= AUDIT_FUZZ_LIMITS.maxInputCharacters, true);
  });

  it("reports the reproducible case coordinates when a runtime regression is injected", () => {
    assert.throws(
      () =>
        runAuditFuzz({
          categoryCounts: reducedCounts({ url_rewrites: 1 }),
          implementation: {
            replaceQualityInUrl() {
              return null;
            },
          },
        }),
      (error) => {
        assert.equal(error instanceof AuditFuzzFailure, true);
        assert.equal(error.code, "AUDIT_FUZZ_INVARIANT");
        assert.equal(error.seed, "0x5a17c0de");
        assert.equal(error.caseNumber, 1);
        assert.equal(error.category, "url_rewrites");
        assert.equal(error.categoryCase, 1);
        assert.match(error.message, /valid pathname rewrite returned no URL/);
        return true;
      },
    );
  });

  it("wires the full harness into the standalone script and verify gate", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

    assert.equal(packageJson.scripts["test:audit-fuzz"], "node scripts/audit-fuzz.js");
    assert.match(packageJson.scripts.verify, /npm run test:audit-fuzz/);
  });
});
