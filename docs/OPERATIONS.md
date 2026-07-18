# CHZZK Operations Runbook

## Release checklist

1. Confirm `git status --short --branch` is clean before starting the release branch.
2. Choose the canonical SemVer change (`MAJOR.MINOR.PATCH`, no leading zero, at most 9 digits per component) and update `package.json`, `package-lock.json`, `manifest.json`, and the release finalizer's `RELEASE_VERSION` together.
3. Run `npm run build:runtime`, `npm ci`, and `npm run verify`.
4. Run the checksum-pinned real Firefox E2E:

```bash
npm run setup:firefox-e2e
FIREFOX_BINARY="$PWD/dist/e2e-tools/firefox/firefox" \
GECKODRIVER_BINARY="$PWD/dist/e2e-tools/geckodriver" \
npm run test:firefox-functional-e2e
```

This is the unsigned functional-only gate. After AMO signing, the release workflow must run the stock-Firefox install gate from `docs/TESTING.md` with the real final XPI before attestation/draft staging. After update-host deployment, run its old-signed-to-new-signed update mode. Do not waive either mode because an artifact is missing; the harness intentionally fails instead of skipping.

5. Open a GitHub PR and wait for all required CI/review gates. CI must pass full verification on both the exact PR head and GitHub's effective pull-request event tree, plus the real Firefox functional E2E. For release/security paths or the explicit review labels, `CHZZK review completion` requires zero unresolved threads plus one of: the configured reviewer's exact-head `APPROVED` review; its later `+1` on an operator request comment containing the full current head SHA; or its canonical, unedited clean-result comment after that request with one 10–40 hex reviewed-commit prefix matching the current head. The clean comment must be the latest reviewer comment, equal current PR activity time, and postdate any exact-head finding. `COMMENTED`/`CHANGES_REQUESTED` reviews and PR-level reactions are not completion evidence. Pushes trigger bounded polling, and a quiet 15-minute reconciliation corrects delayed evidence creation/deletion. Release/supply-chain changes should also receive independent human review; record the exception and rationale when that is unavailable.
6. Merge to protected `main`.
7. Before release dispatch, run the read-only repository-settings drift audit with a dedicated fine-grained token restricted to this repository. Grant only the read access needed for Administration, Actions, and metadata inspection. Do not reuse the release administrator token or any generic/write-capable GitHub credential:

```bash
unset CHZZK_RELEASE_ADMIN_TOKEN GH_TOKEN GITHUB_TOKEN \
  GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
CHZZK_REVIEW_GATE_AUDIT_TOKEN="<dedicated-read-only-token>" \
CHZZK_GITHUB_REPOSITORY="solitude0429/CHZZK" \
CHZZK_AUTOMATED_REVIEW_LOGIN="<exact-reviewer-login>" \
CHZZK_RELEASE_OPERATOR_LOGIN="<exact-operator-login>" \
npm run audit:review-gate-settings
```

8. Install/refresh the operator bootstrap from protected `main` using `docs/SIGNING.md`. From an Actions-external clean checkout at the exact remote `main` head, authenticate as the configured narrow release operator and run its `dispatch` mode. Do not execute checkout JavaScript, use the Actions UI, or put the administrator credential in Actions.

```bash
(
  GH_TOKEN="$CHZZK_RELEASE_ADMIN_TOKEN"
  export GH_TOKEN PATH="/usr/local/bin:/usr/bin:/bin"
  unset ALL_PROXY BASH_ENV CHZZK_RELEASE_ADMIN_TOKEN CURL_CA_BUNDLE ENV \
    GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GITHUB_TOKEN HTTPS_PROXY \
    HTTP_PROXY LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD NODE_EXTRA_CA_CERTS \
    NODE_OPTIONS NODE_PATH NO_PROXY REQUESTS_CA_BUNDLE SSL_CERT_DIR \
    SSL_CERT_FILE XDG_CONFIG_HOME all_proxy http_proxy https_proxy no_proxy
  exec /absolute/path/to/trusted/node \
    "$HOME/.local/libexec/chzzk-release-bootstrap.mjs" \
    dispatch "solitude0429/CHZZK" "$PWD"
)
```

9. Require the authorize → prepare/pre-sign remote-state inspection → sign → structural verification → stock-Firefox default-signature install smoke → attest → stage chain. A compatible draft may resume, but stale/foreign/extra/different-byte state must stop before AMO. The final AMO-signed XPI must pass the stock-Firefox step before attestation or draft staging.
10. Dispatch `Signed Firefox compatibility` for the exact staged draft tag from protected `main`. Require both the `minimum` and `current` profiles, exact source/asset binding, structural verification, release-asset provenance verification, and permanent stock-Firefox installation to pass. Complete the Android release smoke from `docs/COMPATIBILITY.md`, or record an explicit support exception.
11. After the workflows succeed, ensure every exact-source run is complete, the newest run/attempt succeeded, and no other durable `contents: write` credential or concurrent release writer exists. An older failed attempt does not permanently block a later successful staging run, but any queued/in-progress run or newest failure does. Then use the operator-controlled bootstrap installed outside the checkout according to `docs/SIGNING.md`—never execute the checkout's `scripts/finalize-release.js`, npm, npx, or a repository-controlled script shell. The bootstrap first verifies the protected remote default head and fetches that exact commit's entrypoint blob into a memory-only data URL. The protected entrypoint then rechecks the clean exact-`main` checkout, index flags, exact `HEAD` bytes, dependency-free sealed import graph, three exact release/asset snapshots, attestations, just-in-time immutable setting, exact-ID publication, and immutable post-state. If a same-authority credential may be exposed, rotate it before finalizing.

```bash
(
  GH_TOKEN="$CHZZK_RELEASE_ADMIN_TOKEN"
  export GH_TOKEN PATH="/usr/local/bin:/usr/bin:/bin"
  unset ALL_PROXY BASH_ENV CHZZK_RELEASE_ADMIN_TOKEN CURL_CA_BUNDLE ENV \
    GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GITHUB_TOKEN HTTPS_PROXY \
    HTTP_PROXY LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD NODE_EXTRA_CA_CERTS \
    NODE_OPTIONS NODE_PATH NO_PROXY REQUESTS_CA_BUNDLE SSL_CERT_DIR \
    SSL_CERT_FILE XDG_CONFIG_HOME all_proxy http_proxy https_proxy no_proxy
  exec /absolute/path/to/trusted/node \
    "$HOME/.local/libexec/chzzk-release-bootstrap.mjs" \
    finalize "solitude0429/CHZZK" "$PWD"
)
```

12. Confirm the Release is immutable and has exactly the source ZIP, release metadata, and signed XPI. Never overwrite an existing asset or tag. The published event reruns the signed minimum/current compatibility workflow and provenance checks.
13. Deploy from a clean `main` checkout:

```bash
CHZZK_VERSION="<version>" \
CHZZK_GITHUB_REPOSITORY="solitude0429/CHZZK" \
npm run deploy:updates:internal
```

14. From a trusted Actions-external checkout on the WireGuard-connected VPS, run `npm run check:live-update`. It must download `updates.json`, release metadata, the deterministic source ZIP, and the signed XPI without redirects; verify exact schemas, MIME types, bounds, canonical immutable paths, metadata/source digests, signed-XPI SHA-256, and full source/XPI structure. Compare the reported metadata-bound source digest with the immutable GitHub Release; the signed-compatibility and deployment workflows remain the attestation authorities. Never run this production check on a public GitHub-hosted runner or add public DNS/exposure for it. Then run the old-signed-to-new-signed stock-Firefox update mode from the actual PC.
15. Ask the user to trigger Firefox AddonManager update checking. Do not stop Firefox or overwrite the installed profile XPI.

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
