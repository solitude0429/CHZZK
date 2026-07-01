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
3. Enable collector telemetry only for the categories needed to reproduce the issue.
4. Run `npm run diagnostics:analyze -- diagnostics.json`.
5. If URL shape changed, add a failing redacted fixture first.
6. Fix `src/shared/quality.js` or `src/shared/session-rules.js`.
7. Run `npm run verify` before PR.

## Telemetry operations

- Default is local-only.
- External collector upload requires popup opt-in and category opt-in.
- Diagnostics, structure, and errors are controlled independently.
- Forced error reporting must not bypass collector opt-in.
- If collector returns `rate_limited`, check nginx limits and collector limits together.

## Incident response

### Unrelated CDN traffic appears in diagnostics

1. Stop sharing the affected diagnostics.
2. Switch collector telemetry back to local-only.
3. Add a `shouldRecordDiagnostics` regression test.
4. Harden context gates in `src/shared/session-rules.js`.
5. Run `npm run verify`.
6. Add a privacy caveat to any affected release note before publishing another release.

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

### Collector reports are excessive

1. Turn collector telemetry off in the popup.
2. Check collector logs for `rate_limited` and client keys.
3. Check nginx/access logs and `/var/lib/chzzk-telemetry/reports-*.ndjson` growth.
4. Adjust `CHZZK_TELEMETRY_RATE_WINDOW_SECONDS` / `CHZZK_TELEMETRY_RATE_MAX_REPORTS` only if needed.
5. If repeated, re-check whether update host / collector access should be WireGuard-only.

## Operational boundaries

- Do not reintroduce DOM-selector fake menu labels.
- Do not reintroduce a global static DNR ruleset.
- Do not store unrelated page/CDN traffic.
- Do not store signed media URL query/hash values.
- Do not enable collector telemetry by default.
- Do not describe Mozilla unlisted signing as NAVER approval.
