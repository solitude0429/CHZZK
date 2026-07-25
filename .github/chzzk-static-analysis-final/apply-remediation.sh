#!/usr/bin/env bash
set -euo pipefail
TRANSFORM="$RUNNER_TEMP/chzzk-static-analysis-fix.mjs"
cp .github/chzzk-static-analysis-candidate-package.json "$RUNNER_TEMP/package.json"
rm -rf "$RUNNER_TEMP/final-files"
cp -R .github/chzzk-static-analysis-final "$RUNNER_TEMP/final-files"
cat .github/chzzk-static-analysis-fix/part-00.b64 \
    .github/chzzk-static-analysis-fix/part-01.b64 \
    .github/chzzk-static-analysis-fix/part-02.b64 \
    .github/chzzk-static-analysis-fix/part-03.b64 | base64 -d > "$TRANSFORM"
cat .github/chzzk-static-analysis-fix/tail.mjs >> "$TRANSFORM"
test "$(sha256sum "$TRANSFORM" | cut -d ' ' -f1)" = "09c9e982461f362b6f77a24ec92d8faf76dcd2c554a6a5f6cd3438955d50eb1d"
node --check "$TRANSFORM"
git switch --detach origin/main
node "$TRANSFORM"
node <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");

function replaceExactly(path, before, after, expected = 1) {
  const source = readFileSync(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`${path}: expected ${expected} replacements, found ${count}`);
  writeFileSync(path, source.split(before).join(after), "utf8");
}

const playlistPath = "src/shared/playlist-evidence.js";
const playlistSource = readFileSync(playlistPath, "utf8");
const playlistStart = playlistSource.indexOf("function isPlaylistUri(value) {");
const playlistEndMarker = "\n}\n\nexport function isLikelyHlsPlaylist";
const playlistEnd = playlistSource.indexOf(playlistEndMarker, playlistStart);
if (playlistStart < 0 || playlistEnd < 0) throw new Error("playlist URI helper boundary is missing");
writeFileSync(
  playlistPath,
  `${playlistSource.slice(0, playlistStart)}function isPlaylistUri(value) {
    if (typeof value !== "string" || value === "" || value.startsWith("#")) return false;
    for (let index = 0; index < value.length; index += 1) {
      const codePoint = value.charCodeAt(index);
      if (codePoint <= 0x1f || codePoint === 0x7f) return false;
    }
    return true;
  }${playlistSource.slice(playlistEnd + 2)}`,
  "utf8",
);

for (const path of [
  "tests/unit/update-manifest.test.js",
  "tests/unit/release-metadata.test.js",
  "tests/unit/firefox-signed-smoke.test.js",
  "tests/unit/release-pipeline.test.js",
]) {
  replaceExactly(
    path,
    "sha256: String(index + 1).repeat(64),",
    'sha256: (index + 1).toString(16).padStart(64, "0"),',
  );
}

replaceExactly(
  "tests/unit/background-runtime.test.js",
  'assert.deepEqual(plain(tabQueries), [{ url: ["https://*.chzzk.naver.com/live/*"] }]);',
  `assert.deepEqual(plain(tabQueries), [
    {
      url: [
        "https://*.chzzk.naver.com/live",
        "https://*.chzzk.naver.com/live/*",
      ],
    },
  ]);`,
  2,
);
replaceExactly(
  "tests/unit/background-runtime.test.js",
  String.raw`body: "\uFEFF \t\r\n\r\n  #EXTM3U  \r\n#EXT-X-VERSION:3\r\n",`,
  String.raw`body: "\uFEFF \t\r\n\r\n  #EXTM3U  \r\n#EXT-X-TARGETDURATION:6\r\n#EXTINF:6.0,\r\nsegment.ts\r\n",`,
);

replaceExactly("docs/HARDENING.md", "ESLint and web-ext lint", "ESLint and extension-source validation");
replaceExactly(
  "docs/SECURITY.md",
  "lint, web-ext lint, unit/security behavior tests, built-in V8 coverage thresholds, dependency audit, deterministic build, and package-content audit.",
  "lint, extension-source validation, unit/security behavior tests, built-in V8 coverage thresholds, dependency audit, deterministic build, and package-content audit. The ordinary package builder and source validator are repository-owned, dependency-minimal scripts rather than the vulnerable `web-ext` toolchain.",
);
replaceExactly(
  "docs/TESTING.md",
  "ESLint, web-ext lint, unit and security behavior tests",
  "ESLint, extension-source validation, unit and security behavior tests",
);
replaceExactly(
  "docs/TESTING.md",
  `npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile`,
  `mkdir -p /tmp/chzzk-firefox-profile
firefox --no-remote --profile /tmp/chzzk-firefox-profile about:debugging#/runtime/this-firefox`,
);
replaceExactly(
  "docs/TESTING.md",
  `\`\`\`bash
mkdir -p /tmp/chzzk-firefox-profile
firefox --no-remote --profile /tmp/chzzk-firefox-profile about:debugging#/runtime/this-firefox
\`\`\`

Checklist:`,
  `\`\`\`bash
mkdir -p /tmp/chzzk-firefox-profile
firefox --no-remote --profile /tmp/chzzk-firefox-profile about:debugging#/runtime/this-firefox
\`\`\`

In **This Firefox**, choose **Load Temporary Add-on** and select this checkout's \`manifest.json\`. The checked-in runtime bundles are the same files validated by \`npm run check:generated\`; \`npm run build\` additionally creates the deterministic distributable ZIP.

Checklist:`,
);
replaceExactly("docs/TROUBLESHOOTING.md", "npx web-ext lint --source-dir .", "npm run lint:webext");

replaceExactly(
  "tests/e2e/firefox-update-playback.mjs",
  "chmodSync, copyFileSync, mkdtempSync",
  "chmodSync, mkdtempSync",
);
replaceExactly(
  "tests/e2e/firefox-update-playback.mjs",
  "    } catch {}\n",
  "    } catch {\n      // Best-effort WebDriver shutdown during test cleanup.\n    }\n",
);

const securityPath = "tests/unit/security-remediation.test.js";
const securitySource = readFileSync(securityPath, "utf8");
const securityStart = securitySource.indexOf(
  "    for (const [name, version] of Object.entries(packageJson.devDependencies)) {",
);
const securityEnd = securitySource.indexOf(
  '    const ignore = read(".gitignore");',
  securityStart,
);
if (securityStart < 0 || securityEnd < 0) throw new Error("dependency pinning test boundary is missing");
writeFileSync(
  securityPath,
  `${securitySource.slice(0, securityStart)}    for (const [name, version] of Object.entries(packageJson.devDependencies)) {
    assert.doesNotMatch(version, /^[~^]/, \`\${name} must be exactly pinned\`);
  }
  assert.equal(packageJson.devDependencies.eslint, "10.8.0");
  assert.equal(packageJson.devDependencies["@eslint/js"], "10.0.1");
  assert.equal(packageJson.devDependencies.globals, "17.7.0");
  assert.equal(packageJson.devDependencies["web-ext"], undefined);
  assert.equal(packageJson.overrides, undefined);
  assert.equal(packageJson.scripts["lint:webext"], "node scripts/validate-extension-source.js");
  assert.match(packageJson.scripts.build, /build-extension-package\\.js/);
  assert.match(packageJson.scripts["test:coverage"], /coverage:shared.*coverage:runtime/);
  ${securitySource.slice(securityEnd)}`,
  "utf8",
);
NODE
rm .eslintrc.cjs
mkdir -p scripts tests/unit
cp "$RUNNER_TEMP/final-files/eslint.config.js" eslint.config.js
cp "$RUNNER_TEMP/final-files/scripts/build-extension-package.js" scripts/build-extension-package.js
cp "$RUNNER_TEMP/final-files/scripts/check-runtime-coverage.js" scripts/check-runtime-coverage.js
cp "$RUNNER_TEMP/final-files/scripts/validate-extension-source.js" scripts/validate-extension-source.js
cp "$RUNNER_TEMP/final-files/tests/build-extension-package.test.js" tests/unit/build-extension-package.test.js
chmod +x scripts/build-extension-package.js scripts/check-runtime-coverage.js scripts/validate-extension-source.js
cp "$RUNNER_TEMP/package.json" package.json
rm package-lock.json
npm install --package-lock-only --ignore-scripts
npm ci
npx prettier --write "**/*.{js,mjs,json,md,yml}" --ignore-path .prettierignore
npm run build:runtime
git diff --check
