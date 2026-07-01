# CHZZK hardening notes

This document summarizes the extension hardening invariants for the session-scoped CHZZK HLS redirect architecture.

## Runtime behavior

- CHZZK live page start prewarms a safe tab-scoped startup rule.
- Trusted numeric HLS playlist requests can synchronously redirect through blocking `webRequest` so the first playlist is not missed.
- After observing the signed URL shape, the runtime probes configured quality candidates and upgrades the tab-scoped session DNR rule to the highest supported candidate.
- Redirect bootstrap runs before local diagnostics recording.
- Local diagnostics storage writes are serialized to reduce read-modify-write races.
- Session rule IDs are bounded to the owned cleanup range.
- Active rules are removed when the tab closes.

## Content script behavior

- The content script is scoped to `https://chzzk.naver.com/live/*`.
- It does not query or mutate the page DOM.
- It only sends a live-page-ready message for startup rule prewarm.

## Permissions and data

- No external telemetry/data collector is used by the extension runtime.
- `data_collection_permissions` declares `required: ["none"]`.
- CHZZK page access is declared only once through `content_scripts.matches`.
- `host_permissions` are limited to the HTTPS HLS CDN origins needed by `webRequest`, fetch probes, and DNR redirects.

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
- `policy/quality-policy.json` is the source of truth for quality candidates and trusted domains.
- README must describe startup prewarm plus dynamic highest-supported target upgrade.
- Signed XPI/update-site artifacts must be generated only from a verified build.
