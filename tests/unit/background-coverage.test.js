import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  summarizeBackgroundCoverage,
  verifyBackgroundCoverage,
} from "../../scripts/verify-background-coverage.js";

function syntheticCoverage({ functionCount = 120, uncoveredEvery = 5 } = {}) {
  return [
    {
      functions: Array.from({ length: functionCount }, (_, index) => {
        const startOffset = index * 100;
        const endOffset = startOffset + 100;
        const uncovered = index % uncoveredEvery === 0;
        return {
          functionName: `function${index}`,
          isBlockCoverage: true,
          ranges: [
            { count: 1, endOffset, startOffset },
            { count: uncovered ? 0 : 1, endOffset: endOffset - 10, startOffset: startOffset + 10 },
          ],
        };
      }),
      url: "background.js",
    },
  ];
}

describe("background VM coverage gate", () => {
  it("merges named function and executable byte coverage", () => {
    const summary = summarizeBackgroundCoverage(syntheticCoverage());
    assert.equal(summary.totalFunctions, 120);
    assert.equal(summary.coveredFunctions, 120);
    assert.equal(summary.totalBytes, 12_000);
    assert.equal(summary.coveredBytes, 10_080);
  });

  it("rejects vacuous coverage even when percentages appear high", () => {
    assert.throws(
      () =>
        verifyBackgroundCoverage({
          byteThreshold: 0,
          entries: syntheticCoverage({ functionCount: 2 }),
          functionThreshold: 0,
        }),
      /vacuous/i,
    );
  });

  it("rejects a threshold regression", () => {
    const entries = syntheticCoverage({ functionCount: 600, uncoveredEvery: 2 });
    assert.throws(
      () => verifyBackgroundCoverage({ byteThreshold: 70, entries, functionThreshold: 90 }),
      /executable-byte coverage/i,
    );
  });
});
