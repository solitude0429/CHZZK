# CHZZK Operations Runbook

## Release checklist

1. Check `git status --short --branch`.
2. Run `npm ci`.
3. Run `npm run format:check`.
4. Run `npm run verify`.
5. Inspect `unzip -l dist/chzzk-<version>.zip` for runtime files only.
6. Open a GitHub PR and wait for CI.
7. Merge, then let the signing workflow publish the release.
8. Deploy the internal update host with `npm run deploy:updates:internal`.

## Patch response

When CHZZK/NAVER changes break playback:

1. Export diagnostics JSON from the popup.
2. Re-check sensitive data handling:
   - no query/hash values
   - no cookies or headers
   - no account/session/key/UUID/connection identifiers
3. Run `npm run diagnostics:analyze -- diagnostics.json`.
4. If URL shape changed, add a failing redacted fixture first.
5. Fix `src/shared/quality.js` or `src/shared/session-rules.js`.
6. Run `npm run verify` before PR.

## Local diagnostics

- Diagnostics are stored only in the browser extension's local storage.
- The extension runtime does not send diagnostics to an external collector.
- Local samples are redacted before storage/export.
- If a diagnostic export is shared manually, review it again for signed URLs or account/session-like values.

## Incident response

### Unrelated CDN traffic appears in diagnostics

1. Stop sharing the affected diagnostics.
2. Add a `shouldRecordDiagnostics` regression test.
3. Harden context gates in `src/shared/session-rules.js`.
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
- Do not store unrelated page/CDN traffic.
- Do not store signed media URL query/hash values.
- Do not reintroduce external collector uploads unless the user explicitly accepts the additional Firefox data-consent UI.
- Do not describe Mozilla unlisted signing as NAVER approval.
