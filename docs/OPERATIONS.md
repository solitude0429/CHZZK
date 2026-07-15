# CHZZK Operations Runbook

## Release checklist

1. Confirm `git status --short --branch` is clean before starting the release branch.
2. Choose the SemVer change and update `package.json`, `package-lock.json`, and `manifest.json` together.
3. Run `npm run build:runtime`, `npm ci`, and `npm run verify`.
4. Run the checksum-pinned real Firefox E2E:

```bash
npm run setup:firefox-e2e
FIREFOX_BINARY="$PWD/dist/e2e-tools/firefox/firefox" \
GECKODRIVER_BINARY="$PWD/dist/e2e-tools/geckodriver" \
npm run test:firefox-functional-e2e
```

This is the unsigned functional-only gate. After AMO signing, run the stock-Firefox install gate from `docs/TESTING.md` with the real final XPI. After update-host deployment, run its old-signed-to-new-signed update mode. Do not waive either mode because an artifact is missing; the harness intentionally fails instead of skipping.

5. Open a GitHub PR and wait for all required CI/review gates.
6. Merge to protected `main`.
7. Manually run **Sign and publish unlisted Firefox release** from `main` and require the full prepare → sign → verify → attest → publish chain.
8. Confirm the Release has exactly the source ZIP, release metadata, and signed XPI. Never overwrite an existing asset or tag.
9. Deploy from a clean `main` checkout:

```bash
CHZZK_VERSION="<version>" \
CHZZK_GITHUB_REPOSITORY="solitude0429/CHZZK" \
npm run deploy:updates:internal
```

10. Verify live `updates.json`/XPI MIME, SHA-256, version, add-on ID, minimum Firefox version, and attestation-bound source commit.
11. Ask the user to trigger Firefox AddonManager update checking. Do not stop Firefox or overwrite the installed profile XPI.

## Patch response

When CHZZK/NAVER changes break playback:

1. Export diagnostics JSON from the popup.
2. Re-check sensitive data handling:
   - no query/hash values
   - no cookies or headers
   - no account/session/key/UUID/connection identifiers
3. Run `npm run diagnostics:analyze -- diagnostics.json`.
4. If URL shape changed, add a failing redacted fixture first.
5. Fix `src/shared/quality.js` or `src/shared/request-policy.js`.
6. Run `npm run verify` before PR.

## Local diagnostics

- Diagnostics are stored only in the browser extension's local storage.
- The extension runtime does not send diagnostics to an external collector.
- Local samples are exact-schema normalized and redacted before storage/export; host labels discard subdomains and ports.
- If a diagnostic export is shared manually, review it again for signed URLs or account/session-like values.

## Incident response

### Unrelated CDN traffic appears in diagnostics

1. Stop sharing the affected diagnostics.
2. Add a `shouldRecordDiagnostics` regression test.
3. Harden context gates in `src/shared/request-policy.js`.
4. Run `npm run verify`.
5. Add a privacy caveat to any affected release note before publishing another release.

### Playback fails completely

1. Disable the extension to confirm rollback behavior.
2. Check popup `lastDecision`.
3. Record only a redacted DevTools Network URL shape.
4. If the reason is `unknown-quality-shape`, add a parser fixture.
5. If the reason is `untrusted-request-domain`, confirm the request is truly CHZZK live before expanding domains.

### A higher quality appears later

1. Run the diagnostics analyzer.
2. If `needsPolicyUpdate` is true, use `--apply`.
3. Review the added candidate before release.

## Operational boundaries

- Do not reintroduce DOM-selector fake menu labels.
- Do not reintroduce a global static DNR ruleset.
- Do not seed a fixed startup target quality such as `1080p`; resolve the highest actually available HLS playlist quality per tab.
- Do not validate releases by closing Firefox or overwriting the profile XPI; validate through Firefox's add-on update path while Firefox stays running.
- Do not store unrelated page/CDN traffic.
- Do not store signed media URL query/hash values.
- Do not reintroduce external collector uploads unless the user explicitly accepts the additional Firefox data-consent UI.
- Do not describe Mozilla unlisted signing as NAVER approval.
