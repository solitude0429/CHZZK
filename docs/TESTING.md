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

## Real Firefox E2E

The CI E2E downloads checksum-pinned Firefox Developer Edition and geckodriver builds, then uses an isolated profile and synthetic HTTPS hosts.

```bash
npm run setup:firefox-e2e
FIREFOX_BINARY="$PWD/dist/e2e-tools/firefox/firefox" \
GECKODRIVER_BINARY="$PWD/dist/e2e-tools/geckodriver" \
npm run test:firefox-e2e
```

The test exercises real Firefox rather than a VM mock:

1. Installs synthetic version `0.1.3` through geckodriver.
2. Opens a CHZZK-shaped live fixture and issues a `480p` HLS request.
3. Confirms the extension probes candidates and Firefox requests the available `1080p` URL.
4. Confirms the signed-style query remains byte-for-byte unchanged.
5. Serves strict `updates.json` and synthetic version `0.1.4` over HTTPS.
6. Calls `AddonManager.findUpdates` and confirms the installed version becomes `0.1.4`.

The fixture XPIs are unsigned and exist only in the disposable Developer Edition profile, so signature/update certificate checks are disabled only for this test. Production Release artifacts must remain AMO-signed and attested.

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
