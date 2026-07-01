# CHZZK hardening notes

This document summarizes the extension hardening invariants for the MV2 required-permission CHZZK HLS redirect architecture.

## Runtime behavior

- A minimal MV2 `site-observer.js` content script runs at `document_start` on CHZZK live pages and prewarms the per-tab startup redirect target before the first playlist request.
- Trusted numeric HLS playlist requests synchronously redirect through blocking `webRequest`; after observing the signed URL shape, the runtime probes configured quality candidates and caches the highest supported candidate per tab.
- Redirect handling runs before local diagnostics recording.
- Local diagnostics storage writes are serialized to reduce read-modify-write races.
- Active per-tab targets are removed when the tab closes.

## Content script behavior

- `site-observer.js` is scoped to `https://chzzk.naver.com/live/*` and only sends `chzzk.live-page-ready`.
- The content script does not query or mutate the CHZZK page DOM.

## Permissions and data

- Firefox manifest version 2 is used so CHZZK and trusted CDN origins are declared in required `permissions`, like the user's other Firefox extensions.
- No `host_permissions`, `optional_permissions`, or `optional_host_permissions` site-access toggle surface is used for core functionality; the MV2 content script match is required install-time CHZZK live access.
- No external telemetry/data collector is used by the extension runtime.
- `data_collection_permissions` declares `required: ["none"]`.

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
- README must describe MV2 required permissions, first-request prewarm, and dynamic highest-supported target redirects.
- Signed XPI/update-site artifacts must be generated only from a verified build.
