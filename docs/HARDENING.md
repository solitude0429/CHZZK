# CHZZK hardening notes

This document summarizes the `0.0.6` telemetry/session-rule hardening release without changing the configured CHZZK HLS redirect target policy.

## Runtime behavior

- Session redirect bootstrap runs before diagnostics/telemetry reporting.
- External collector transmission is disabled by default.
- Diagnostics, structure, and error reports are independently opt-in.
- Telemetry POST calls are bounded by a short timeout.
- Telemetry dedupe state is pruned by TTL.
- Local diagnostics storage writes are serialized to reduce read-modify-write races.
- Session rule IDs are bounded to the owned cleanup range.
- A defensive tab navigation cleanup removes active session rules when a tab leaves a CHZZK live URL and the browser exposes that URL change.

## Content script behavior

- Structure reports are sent only after collector/category opt-in.
- Mutation observation is narrowed to class changes plus child list changes.
- Hidden tabs disconnect the observer and cancel pending mutation reports.

## Collector behavior

- NDJSON writes are protected by a process-local lock.
- Report POSTs are rate-limited per client key.
- Sanitization rejects signed CDN query values and token/auth/session-like query strings before storage.

## Verification

`npm run verify` includes:

- `npm run format:check`
- generated runtime refresh
- manifest/project validation
- ESLint and web-ext lint
- Node unit tests
- Python ops compile/tests
- dependency audit
- package build/audit

## Release invariants

- `package.json`, `manifest.json`, and release notes must describe the same extension version.
- `policy/quality-policy.json` is the source of truth for the configured HLS redirect target.
- README must describe the quality policy as a redirect attempt toward the configured target, not as a guarantee that CHZZK/NAVER provides that quality for every stream.
- Signed XPI/update-site artifacts must be generated only from a verified build.
