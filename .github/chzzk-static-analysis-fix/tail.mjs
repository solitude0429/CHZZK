", import.meta.url), "utf8"), context, {
    filename: "background.js",
  });`,
  `  const source = readFileSync(new URL("../../background.js", import.meta.url), "utf8");
  const closureEnd = source.lastIndexOf("})();");
  assert.notEqual(closureEnd, -1, "generated background bundle must end with an IIFE");
  const instrumented = \`${"${source.slice(0, closureEnd)}"}
  globalThis.__chzzkSessionState = () => ({
    active: [...activeTargetsBySession.values()].map((state) => ({
      familyKey: state.familyKey,
      tabId: state.tabId,
    })),
    failed: [...failedTargetsBySession.values()].map((state) => ({
      familyKey: state.familyKey,
      keys: Object.keys(state).sort(),
      tabId: state.tabId,
      targetCount: state.targets instanceof Map ? state.targets.size : 0,
    })),
    resolving: resolutionBySession.size,
  });
${"${source.slice(closureEnd)}"}\`;

  vm.createContext(context);
  vm.runInContext(instrumented, context, { filename: "background.js" });`,
);
replaceOnce(
  "tests/unit/background-runtime.test.js",
  `    responseFilters,
    storage,
    tabQueries,`,
  `    responseFilters,
    sessionState: () => plain(context.__chzzkSessionState()),
    storage,
    tabQueries,`,
);

createTextFile(
  "tests/unit/playlist-evidence.test.js",
  `import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isLikelyHlsPlaylist,
  isUsableHlsPlaylist,
  isUtf8TextWithinByteLimit,
} from "../../src/shared/playlist-evidence.js";

describe("bounded HLS playlist evidence", () => {
  it("keeps header recognition separate from usable playlist evidence", () => {
    const headerOnly = "#EXTM3U\\n#EXT-X-VERSION:3\\n";
    assert.equal(isLikelyHlsPlaylist(headerOnly), true);
    assert.equal(isUsableHlsPlaylist(headerOnly), false);
    assert.equal(isUsableHlsPlaylist("#EXTM3U\\n#EXT-X-ENDLIST\\n"), false);
  });

  it("accepts structurally usable master and media playlists", () => {
    assert.equal(
      isUsableHlsPlaylist(
        "#EXTM3U\\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\\nchunklist_720p.m3u8\\n",
      ),
      true,
    );
    assert.equal(
      isUsableHlsPlaylist(
        "#EXTM3U\\n#EXT-X-TARGETDURATION:6\\n#EXTINF:6.0,\\nsegment-1.ts\\n",
      ),
      true,
    );
  });

  it("accepts usable LL-HLS part evidence", () => {
    assert.equal(
      isUsableHlsPlaylist(
        '#EXTM3U\\n#EXT-X-PART:DURATION=0.333,URI="part-1.m4s"\\n',
      ),
      true,
    );
    assert.equal(
      isUsableHlsPlaylist(
        '#EXTM3U\\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part-next.m4s"\\n',
      ),
      true,
    );
  });

  it("rejects malformed, truncated, and non-HLS bodies", () => {
    for (const body of [
      "<!doctype html>\\n#EXTM3U\\n",
      "#EXTM3U\\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\\n#EXT-X-ENDLIST\\n",
      "#EXTM3U\\n#EXTINF:6.0,\\n",
      '#EXTM3U\\n#EXT-X-PART:DURATION=0.333,URI=""\\n',
      '#EXTM3U\\n#EXT-X-PRELOAD-HINT:TYPE=MAP,URI="part-next.m4s"\\n',
    ]) {
      assert.equal(isUsableHlsPlaylist(body), false, body);
    }
  });

  it("counts UTF-8 bytes rather than JavaScript code units", () => {
    const body = "#EXTM3U\\n#EXTINF:1.0,\\n가.ts\\n";
    const bytes = new TextEncoder().encode(body).byteLength;
    assert.equal(isUtf8TextWithinByteLimit(body, bytes), true);
    assert.equal(isUtf8TextWithinByteLimit(body, bytes - 1), false);
  });
});
`,
);

createTextFile(
  "tests/unit/release-package-notices.test.js",
  `import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RELEASE_PACKAGE_FILES as signingPackageFiles } from "../../scripts/lib/amo-client.js";
import { RELEASE_PACKAGE_FILES as finalizerPackageFiles } from "../../scripts/lib/release-finalize-state.js";
import { requiresAutomatedSecurityReview } from "../../scripts/lib/review-gate.js";

describe("release notice packaging", () => {
  it("ships the license and attribution notice through signing and finalization", () => {
    assert.deepEqual(finalizerPackageFiles, signingPackageFiles);
    assert.equal(signingPackageFiles.includes("LICENSE"), true);
    assert.equal(signingPackageFiles.includes("NOTICE"), true);
  });

  it("treats notice changes as release/security-sensitive", () => {
    for (const path of ["LICENSE", "NOTICE"]) {
      assert.equal(
        requiresAutomatedSecurityReview({ files: [path], labels: [] }),
        true,
        path,
      );
    }
  });
});
`,
);

appendText(
  "tests/unit/background-runtime.test.js",
  `describe("static-analysis remediation regressions", () => {
  it("falls back to the highest valid trusted variant in a master playlist", async () => {
    const masterUrl =
      "https://edge.pstatic.net/chzzk/master-fallback/master.m3u8?Policy=synthetic";
    const masterBody = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160,FRAME-RATE=60.0",
      "https://untrusted.example.invalid/chunklist_2160p.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=2560x1440,FRAME-RATE=60.0",
      "chunklist_1440p.m3u8?Policy=synthetic",
      "",
    ].join("\\n");
    const { fetches, listeners } = await loadBackground({
      responsesByUrl: new Map([[masterUrl, { body: masterBody }]]),
    });

    assert.equal(
      await listeners.onBeforeRequest({
        documentUrl: "https://chzzk.naver.com/live/example-channel",
        initiator: "https://chzzk.naver.com",
        method: "GET",
        requestId: "master-fallback",
        tabId: 811,
        type: "xmlhttprequest",
        url: masterUrl,
      }),
      undefined,
    );
    await waitForDiagnosticsQueue(20);

    const redirect = plain(
      await listeners.onBeforeRequest(familyRequest(811, "master-fallback", "master-low")),
    );
    assert.match(redirect.redirectUrl, /master-fallback\\/chunklist_1440p\\.m3u8/);
    assert.deepEqual(fetches, [masterUrl]);
  });

  it("rejects an EXTM3U-only candidate and downgrades to usable evidence", async () => {
    const requested2160 =
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/example/2160p/segment/chunklist_2160p.m3u8?Policy=redacted";
    const { listeners } = await loadBackground({
      availableQualities: new Set(["1080p"]),
      responsesByUrl: new Map([[requested2160, { body: "#EXTM3U\\n#EXT-X-VERSION:3\\n" }]]),
    });

    const redirect = plain(await listeners.onBeforeRequest(firstLowQualityRequest(812)));
    assert.match(redirect.redirectUrl, /chunklist_1080p\\.m3u8/);
  });

  it("prewarms the exact /live route during startup scans", async () => {
    const { listeners, storage, tabQueries } = await loadBackground({
      existingLiveTabs: [{ id: 813, url: "https://chzzk.naver.com/live" }],
    });

    listeners.onStartup();
    await waitForDiagnosticsQueue();
    assert.deepEqual(new Set(tabQueries[0].url), new Set([
      "https://*.chzzk.naver.com/live",
      "https://*.chzzk.naver.com/live/*",
    ]));
    assert.deepEqual(plain(storage.chzzkDiagnostics.runtimeRedirects.activeTabIds), [813]);
  });

  it("bounds session families and keeps failure suppression free of signed request URLs", async () => {
    const runtime = await loadBackground({ availableQualities: new Set(["2160p"]) });
    const counts = [80, 50, 50, 50, 50];
    for (const [offset, count] of counts.entries()) {
      for (let index = 0; index < count; index += 1) {
        await runtime.listeners.onBeforeRequest(
          familyRequest(900 + offset, "bounded-" + offset + "-" + index),
        );
      }
    }

    let snapshot = runtime.sessionState();
    assert.equal(snapshot.active.length <= 256, true);
    const activeCounts = new Map();
    for (const state of snapshot.active) {
      activeCounts.set(state.tabId, (activeCounts.get(state.tabId) ?? 0) + 1);
    }
    assert.equal([...activeCounts.values()].every((count) => count <= 64), true);

    const failureRequest = familyRequest(999, "failure-minimal", "failure-minimal-request");
    const first = plain(await runtime.listeners.onBeforeRequest(failureRequest));
    runtime.listeners.onCompleted({
      requestId: failureRequest.requestId,
      statusCode: 404,
      tabId: failureRequest.tabId,
      url: first.redirectUrl,
    });
    snapshot = runtime.sessionState();
    const failure = snapshot.failed.find((state) => state.familyKey.includes("failure-minimal"));
    assert.ok(failure);
    assert.equal(failure.targetCount, 1);
    for (const forbidden of [
      "bodyEvidence",
      "redirectNetworkUrl",
      "redirectUrl",
      "requestId",
      "statusCode",
    ]) {
      assert.equal(failure.keys.includes(forbidden), false, forbidden);
    }
  });
});`,
);

// Documentation now matches the hardened behavior.
replaceOnce(
  "docs/HARDENING.md",
  "`https://*.chzzk.naver.com/live/*`",
  "`https://*.chzzk.naver.com/live` and `https://*.chzzk.naver.com/live/*`",
);
replaceOnce(
  "docs/HARDENING.md",
  "`https://chzzk.naver.com/live/*`",
  "`https://chzzk.naver.com/live` and `https://chzzk.naver.com/live/*`",
);
replaceOnce(
  "docs/HARDENING.md",
  "A response must have an exact first meaningful `#EXTM3U` line, must not declare an obvious HTML/JSON content type, and is capped in UTF-8 bytes.",
  "A response must have an exact first meaningful `#EXTM3U` line plus a structurally usable master variant, media segment, or LL-HLS part reference; it must not declare an obvious HTML/JSON content type and is capped in UTF-8 bytes.",
);
replaceOnce(
  "docs/HARDENING.md",
  "Target state, resolved state, and in-flight work are independently keyed by tab, live context, and a secret-free playlist family; query, fragment, quality markers, and recognized signed path-tail segments are excluded from that family key, and the key is never persisted in diagnostics.",
  "Target state, resolved state, and in-flight work are independently keyed by tab, live context, and a secret-free playlist family; query, fragment, quality markers, and recognized signed path-tail segments are excluded from that family key, and the key is never persisted in diagnostics. Expired state is swept and the combined target/failure/resolution set is LRU-bounded per tab and globally.",
);
replaceOnce(
  "docs/HARDENING.md",
  "- Node unit/security/transaction tests\n- dependency audit",
  "- Node unit/security/transaction tests\n- built-in V8 line/function/branch coverage thresholds\n- dependency audit",
);
replaceOnce(
  "docs/HARDENING.md",
  "AMO receives only the deterministic exact-allowlist ZIP; local untracked files and symlinks cannot enter the signing input.",
  "AMO receives only the deterministic exact-allowlist ZIP, including `LICENSE` and `NOTICE`; local untracked files and symlinks cannot enter the signing input.",
);
replaceAtLeast(
  "docs/SECURITY.md",
  "`https://*.chzzk.naver.com/live/*`",
  "`https://*.chzzk.naver.com/live` and `https://*.chzzk.naver.com/live/*`",
  1,
);
replaceOnce(
  "docs/SECURITY.md",
  "Target state, resolved evidence, and in-flight work are keyed by tab, live context, and secret-free playlist family. Independent families cannot share results.",
  "Target state, resolved evidence, and in-flight work are keyed by tab, live context, and secret-free playlist family. Independent families cannot share results, expired entries are swept, and the combined state is LRU-bounded per tab and globally.",
);
replaceOnce(
  "docs/SECURITY.md",
  "Probe bodies require `#EXTM3U` as the exact first meaningful line, reject obvious HTML/JSON MIME types, and are capped in UTF-8 bytes.",
  "Probe bodies require `#EXTM3U` as the exact first meaningful line plus a usable master variant, media segment, or LL-HLS part reference; they reject obvious HTML/JSON MIME types and are capped in UTF-8 bytes.",
);
replaceOnce(
  "docs/SECURITY.md",
  "`npm run verify` includes formatting, generated-runtime drift checks, manifest/project/semantic-workflow validation, lint, web-ext lint, unit/security behavior tests, dependency audit, deterministic build, and package-content audit.",
  "`npm run verify` includes formatting, generated-runtime drift checks, manifest/project/semantic-workflow validation, lint, web-ext lint, unit/security behavior tests, built-in V8 coverage thresholds, dependency audit, deterministic build, and package-content audit. Signed release allowlists also require `LICENSE` and `NOTICE`.",
);

console.log("Applied all static-analysis remediations and regression tests.");
