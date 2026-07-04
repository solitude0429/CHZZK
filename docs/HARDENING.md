# CHZZK hardening notes

This document summarizes the extension hardening invariants for the MV2 required-permission CHZZK HLS redirect architecture.

## Runtime behavior

- A minimal MV2 `site-observer.js` content script runs at `document_start` on CHZZK live pages (`https://*.chzzk.naver.com/live/*`) and prewarms only the CHZZK live tab identity before the first playlist request; the first redirect must not depend solely on content-script timing.
- Trusted HLS master playlists are parsed when available, and the runtime caches the best target quality per tab by resolution, frame rate, then bitrate.
- Trusted numeric HLS playlist requests synchronously redirect through blocking `webRequest`; when no master playlist has been scored yet, the runtime probes configured quality candidates and caches the highest supported candidate per tab.
- Redirect handling runs before local diagnostics recording.
- Local diagnostics storage writes are serialized to reduce read-modify-write races.
- Active per-tab targets are removed when the tab closes.

## Content script behavior

- `site-observer.js` is scoped to `https://chzzk.naver.com/live/*` and only sends `chzzk.live-page-ready`.
- The content script does not query or mutate the CHZZK page DOM.
- The background trusts that manifest-scoped prewarm message by tab ID only; Firefox may omit message sender URL fields before the first HLS request.

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
- Version bumps follow the project `a.b.c` SemVer rule: MAJOR for incompatible changes, MINOR for backward-compatible features, PATCH for backward-compatible bug fixes.
- `policy/quality-policy.json` is the source of truth for fallback quality candidates and trusted domains.
- README must describe MV2 required permissions, first-request prewarm, master-playlist variant scoring, live playlist URL-shape preservation, and dynamic highest-supported target redirects.
- Signed XPI/update-site artifacts must be generated only from a verified build.
