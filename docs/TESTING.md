# Testing CHZZK

## Standard gates

```bash
npm ci
npm run verify
```

`verify` runs formatting, generated-runtime drift checks, manifest/project/workflow validation, ESLint, web-ext lint, unit and security behavior tests, dependency audit, deterministic packaging, and package-content audit.

Useful individual gates:

```bash
npm run check:generated
npm run validate:manifest
npm run validate:workflows
npm run lint
npm run lint:webext
npm test
npm run audit:deps
npm run build
npm run audit:package
```

The unit suite includes direct library-boundary misuse tests for canonical release basenames, verifier-buffer deployment (no validated-path reread), exact remote draft/tag recovery, immutable deployment checks, bounded lock cleanup, canonical SemVer, administrator dispatch ordering, and idempotent sole-owner repository protection. The repository-settings tests source-bind CI, Firefox E2E, dependency review, and CodeQL to the GitHub Actions app, remove the retired bot-review state, restrict Actions to GitHub-owned code, and keep workflows read-only by default. Workflow-policy tests also require SHA-pinned actions and separated secret/write authority.

## Functional-only Firefox E2E

The CI E2E downloads checksum-pinned Firefox Developer Edition and geckodriver builds, then uses an isolated profile and synthetic HTTPS hosts.

```bash
npm run setup:firefox-e2e
FIREFOX_BINARY="$PWD/dist/e2e-tools/firefox/firefox" \
GECKODRIVER_BINARY="$PWD/dist/e2e-tools/geckodriver" \
npm run test:firefox-functional-e2e
```

The test exercises real Firefox rather than a VM mock:

1. Installs synthetic version `0.1.3` through geckodriver.
2. Opens a CHZZK-shaped live fixture and issues a `480p` HLS request.
3. Confirms the extension probes candidates and Firefox requests the available `1080p` URL.
4. Confirms the signed-style query remains byte-for-byte unchanged.
5. Moves the live page to the same-site `/lives` mini-player route with `history.pushState`, keeps Firefox's observed original-live `documentUrl`, changes routes repeatedly, and confirms unavailable candidates are not re-probed.
6. Revalidates the selected playlist with an empty HTTP 304 and confirms the cached target remains usable.
7. Serves strict `updates.json` and synthetic version `0.1.4` over HTTPS.
8. Calls `AddonManager.findUpdates` and confirms the installed version becomes `0.1.4`.

The fixture XPIs are unsigned and exist only in the disposable Developer Edition profile, so signature/update certificate checks are disabled only for this functional test. This test makes no authenticity claim about a Release artifact.

## Stock Firefox signed-release gate

`test:firefox-signed-smoke` is the production-like authenticity gate. It launches stock Firefox with a new mode-`0700` disposable profile, supplies no preference overrides, confirms `xpinstall.signatures.required` is enabled and has no user value, permanently installs the final XPI, and requires the exact release add-on ID, version, update URL, active state, `temporarilyInstalled=false`, and `AddonManager.SIGNEDSTATE_SIGNED`.

The release workflow downloads checksum-pinned stock Firefox and geckodriver with the separate signed-smoke setup, then runs install mode on the final AMO-signed XPI before attestation or draft staging. The nonce-bound out-of-band release operation waits for that exact staging run and performs a fresh administrator-only immutable-setting and attestation preflight before publication. To provision the same binaries locally:

```bash
npm run setup:firefox-signed-smoke
```

The required release runner is Linux x64; the setup also has checksum-pinned Linux arm64 inputs. Windows, macOS, and Android are not required gates: the shipped WebExtension payload is platform-independent, and unattended unlisted-extension installation on those runners would add a large, fragile toolchain without replacing the stock-Firefox signature check. Residual operating-system integration risk is handled by the disposable post-deployment update smoke on the actual Firefox client, without weakening signature or update trust.

Install mode requires a real final AMO-signed XPI and canonical release metadata:

```bash
FIREFOX_BINARY="$PWD/dist/signed-smoke-tools/firefox/firefox" \
GECKODRIVER_BINARY="$PWD/dist/signed-smoke-tools/geckodriver" \
CHZZK_RELEASE_METADATA="/path/to/chzzk-<version>-release-metadata.json" \
CHZZK_SIGNED_XPI="/path/to/chzzk-<version>-signed.xpi" \
CHZZK_SIGNED_SMOKE_MODE="install" \
npm run test:firefox-signed-smoke
```

Update mode first performs the same direct final-XPI install in one disposable profile. In a second disposable profile it permanently installs an older AMO-signed XPI, disables automatic updates, opens that extension's `about:addons` details, clicks its visible update-check control, proves Firefox keeps the old version while exposing the pending `install-update` control, then clicks that control and requires a permanent, active, Mozilla-signed installation at the final version. A third disposable profile keeps the default update policy, clicks the global add-on-manager update control, requires the visible `installed` state, and checks once more for the visible `none-found` state:

```bash
FIREFOX_BINARY="/path/to/stock/firefox" \
GECKODRIVER_BINARY="/path/to/geckodriver" \
CHZZK_RELEASE_METADATA="/path/to/chzzk-<version>-release-metadata.json" \
CHZZK_SIGNED_XPI="/path/to/chzzk-<version>-signed.xpi" \
CHZZK_OLD_SIGNED_XPI="/path/to/chzzk-<older-version>-signed.xpi" \
CHZZK_SIGNED_SMOKE_MODE="update" \
npm run test:firefox-signed-smoke
```

Update mode deliberately uses the older XPI's canonical production `update_url`; run it only after the versioned final XPI and `updates.json` are deployed. The test clicks both the per-extension `[action="update-check"]`/`[action="install-update"]` controls and the global `[action="check-for-updates"]` control in stock Firefox rather than calling `AddonManager.findUpdates` directly. Missing binaries, metadata, or required signed artifacts are hard failures, never skips. Fake or cryptographically tampered metadata that can satisfy the structural ZIP bounds is rejected by Firefox installation/signed-state enforcement rather than by home-grown cryptography.

The Linux authenticity gate does not replace the client-network boundary. Release readiness also requires an operator-automated disposable profile on the actual current Windows client using its installed Firefox ESR, normal DNS, and production TLS path. Drive the same visible, interactability-enforcing `about:addons` controls from an older Mozilla-signed XPI to the intended version, then require a second visible `none-found` result. Keep results enum-only and leave the user's running profile untouched.

## Manual Firefox smoke test

Use a temporary profile instead of the user's main profile:

```bash
npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile
```

Checklist:

1. Remove or disable NAVER Live Streaming Connector/NLiveConnector on the test PC.
2. Open a CHZZK live page.
3. Confirm the popup can show the tab in `activeTabIds` while `targetsByTab` is empty before a numeric HLS request. Prewarm must not seed a fixed quality.
4. Start playback and choose any numeric quality.
5. Confirm the popup shows `eligible-chzzk-hls-quality` or a clear fail-closed reason.
6. Confirm the player menu is not relabeled.
7. Confirm subsequent lower playlist requests use the highest available target while keeping the original URL path shape and signed query/hash.
8. Confirm diagnostics contain only an allowlisted host, quality, structured media shape, and local counters.

## Regression fixtures

When CHZZK changes URL shapes:

1. Export local diagnostics.
2. Remove every query, fragment, account/session identifier, key-like value, UUID, and connection identifier.
3. Add the smallest synthetic failing fixture first.
4. Fix `src/shared/quality.js`, `src/shared/request-policy.js`, or runtime state handling.
5. Run `npm run verify` and the Firefox E2E.

Never paste complete signed media URLs into issues, commits, or chat.
