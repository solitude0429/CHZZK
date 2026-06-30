# CHZZK hardening notes

This branch hardens the `0.0.5` telemetry/update loop without changing the core CHZZK HLS redirect policy.

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
- Sanitization rejects signed CDN query values and token/auth/session-like query strings.

## Verification

`npm run verify` now includes:

- `npm run format:check`
- generated runtime refresh
- manifest/project validation
- ESLint and web-ext lint
- Node unit tests
- Python ops compile/tests
- dependency audit
- package build/audit
