# Testing CHZZK

## Standard gates

```bash
npm ci
npm run verify
```

`verify` runs formatting, generated-runtime drift checks, compatibility/manifest/project/workflow validation, ESLint, web-ext lint, unit and security behavior tests, dependency audit, deterministic packaging, and package-content audit.

Useful individual gates:

```bash
npm run check:firefox-compatibility-freshness
npm run check:generated
npm run validate:compatibility
npm run validate:manifest
npm run validate:workflows
npm run lint
npm run lint:webext
npm test
npm run audit:deps
npm run build
npm run audit:package
```

The unit suite includes direct library-boundary misuse tests for canonical release basenames, verifier-buffer deployment (no validated-path reread), exact remote draft/tag recovery, immutable deployment checks, bounded lock cleanup, canonical SemVer, administrator dispatch ordering, exact-head review completion, compatibility-policy and Mozilla-release freshness drift, complete live-release schema/digest/structure validation, and isolated repository-settings audit credentials. Review-gate cases cover exact/stale reviews, rejection of all mutable reactions, wrong actors, malformed dates, unresolved threads, ordinary paths, full-SHA operator-request and canonical clean-result comment binding, repeated post-comment evidence snapshots, and stubbed dry-run/idempotent sole-owner protection configuration. Clean-result negative cases cover stale/short/multiple commit markers, non-clean headings, arbitrary trailing findings/caveats, wrong actors, edits, later PR/reviewer activity, earlier/equal requests, later findings, stale full-SHA requests, head/activity changes, and same-second review/thread/comment mutations during evidence collection. Workflow-policy tests also require SHA-pinned actions, separated secret/write authority, cancelable forced evidence reevaluation, force-marker ownership, failure-only head fallback, and a trusted checker rerun inside the status-publication step.

For pull requests, CI runs the full repository verification on both the exact branch head and GitHub's effective pull-request event tree. The functional Firefox E2E runs on the effective event tree, so both direct-head regressions and merge-interaction regressions are covered. CodeQL runs independently on both trees.

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
5. Serves strict `updates.json` and synthetic version `0.1.4` over HTTPS.
6. Calls `AddonManager.findUpdates` and confirms the installed version becomes `0.1.4`.

The fixture XPIs are unsigned and exist only in the disposable Developer Edition profile, so signature/update certificate checks are disabled only for this functional test. This test makes no authenticity claim about a Release artifact.

## Stock Firefox signed-release gate

`test:firefox-signed-smoke` is the production-like authenticity gate. It launches stock Firefox with a new mode-`0700` disposable profile, supplies no preference overrides, confirms `xpinstall.signatures.required` is enabled and has no user value, permanently installs the final XPI, and requires the exact release add-on ID, version, update URL, active state, `temporarilyInstalled=false`, and `AddonManager.SIGNEDSTATE_SIGNED`.

`policy/compatibility-policy.json` binds the manifest support declaration to two checksum-pinned desktop profiles:

- `minimum`: the exact desktop `strict_min_version`;
- `current`: a separately pinned current stock-Firefox baseline.

The signing workflow runs the current x64 profile before attestation or draft staging. The `Signed Firefox compatibility` workflow verifies the exact release source and asset set, structurally verifies the source ZIP and signed XPI, checks release-asset attestations for staged drafts and immutable releases, and runs both browser profiles on Linux x64 and arm64. Relevant pull requests run the same four-combination harness from the exact PR head against the latest published release; a legacy non-immutable release is accepted only for that read-only regression test and does not satisfy a release gate.

To provision either profile locally, use a Linux x64 or arm64 host and keep the architecture in the tools directory name:

```bash
CHZZK_SIGNED_SMOKE_PROFILE="minimum" \
CHZZK_SIGNED_SMOKE_TOOLS_DIR="$PWD/dist/signed-smoke-tools-minimum-$(node -p 'process.arch')" \
npm run setup:firefox-signed-smoke

CHZZK_SIGNED_SMOKE_PROFILE="current" \
CHZZK_SIGNED_SMOKE_TOOLS_DIR="$PWD/dist/signed-smoke-tools-current-$(node -p 'process.arch')" \
npm run setup:firefox-signed-smoke
```

Install mode requires a real final AMO-signed XPI and canonical release metadata:

```bash
FIREFOX_BINARY="/path/to/pinned/stock/firefox" \
GECKODRIVER_BINARY="/path/to/pinned/geckodriver" \
CHZZK_RELEASE_METADATA="/path/to/chzzk-<version>-release-metadata.json" \
CHZZK_SIGNED_XPI="/path/to/chzzk-<version>-signed.xpi" \
CHZZK_SIGNED_SMOKE_MODE="install" \
npm run test:firefox-signed-smoke
```

Update mode first performs the same direct final-XPI install in one disposable profile. In a second disposable profile it permanently installs an older AMO-signed XPI, invokes `AddonManager.findUpdates`, and requires a permanent, active, Mozilla-signed installation at the final version:

```bash
FIREFOX_BINARY="/path/to/stock/firefox" \
GECKODRIVER_BINARY="/path/to/geckodriver" \
CHZZK_RELEASE_METADATA="/path/to/chzzk-<version>-release-metadata.json" \
CHZZK_SIGNED_XPI="/path/to/chzzk-<version>-signed.xpi" \
CHZZK_OLD_SIGNED_XPI="/path/to/chzzk-<older-version>-signed.xpi" \
CHZZK_SIGNED_SMOKE_MODE="update" \
npm run test:firefox-signed-smoke
```

Update mode deliberately uses the older XPI's canonical production `update_url`; run it only after the versioned final XPI and `updates.json` are deployed. Missing binaries, metadata, or required signed artifacts are hard failures, never skips. Fake or cryptographically tampered metadata that can satisfy the structural ZIP bounds is rejected by Firefox installation/signed-state enforcement rather than by home-grown cryptography.

## Firefox compatibility freshness

`npm run check:firefox-compatibility-freshness` fetches Mozilla's official bounded JSON release metadata without following redirects. It requires the policy's pinned current Firefox to equal `LATEST_FIREFOX_VERSION`, requires the declared desktop minimum to remain in the `FIREFOX_ESR` major, and reports `NEXT_RELEASE_DATE` for maintenance planning.

The `Firefox compatibility freshness` workflow runs daily and on relevant pull requests from the exact source tree. A stable release intentionally turns this check red until the new x64 and arm64 archives are checksum-pinned and the full signed compatibility matrix succeeds. This network-dependent check is kept outside the deterministic local `npm run verify`; its parser and policy behavior remain covered by unit tests.

## Production update canary

`npm run check:live-update` downloads the production `updates.json`, canonical release metadata, deterministic source ZIP, and advertised signed XPI without following redirects. It requires strict UTF-8 JSON, exact schemas, canonical immutable paths, expected MIME types, bounded nonempty bodies, the manifest minimum Firefox version, metadata/source size and SHA-256 consistency, the advertised signed-XPI SHA-256, and the same full source/XPI structural verification used by the release pipeline.

The production hostname is WireGuard-only. Run this command after deployment from a trusted Actions-external checkout on the connected VPS, then run the old-signed-to-new-signed stock-Firefox update smoke from the actual PC. Public GitHub-hosted runners are expected to receive `NXDOMAIN`; repository workflows must not invoke this command, publish the hostname through public DNS, or weaken the private access boundary. Unit tests cover the canary implementation and enforce that workflow separation.

## Repository-settings audit

`npm run audit:review-gate-settings` is an Actions-external, read-only drift check. It requires a dedicated fine-grained `CHZZK_REVIEW_GATE_AUDIT_TOKEN`, rejects ambient release or generic GitHub credentials, resolves a root-owned system `gh`, and runs the existing dry-run configuration inspector in a private sanitized environment. Follow `docs/COMPATIBILITY.md`; never run repository-controlled audit code with the release administrator token.

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

Firefox Android remains an explicit manual release gate; follow `docs/COMPATIBILITY.md` and record any exception rather than treating an untested release as fully supported.

## Regression fixtures

When CHZZK changes URL shapes:

1. Export local diagnostics.
2. Remove every query, fragment, account/session identifier, key-like value, UUID, and connection identifier.
3. Add the smallest synthetic failing fixture first.
4. Fix `src/shared/quality.js`, `src/shared/request-policy.js`, or runtime state handling.
5. Run `npm run verify` and the Firefox E2E.

Never paste complete signed media URLs into issues, commits, or chat.
