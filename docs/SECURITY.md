# Security Policy

## Threat model

This extension observes CHZZK live-page HLS playlist requests only to redirect eligible playlist quality URLs and keep local troubleshooting diagnostics. The main risks are:

- capturing unrelated CDN or non-CHZZK traffic;
- storing signed media URL query strings;
- broad redirects affecting non-CHZZK pages;
- accidentally publishing account/session identifiers in exported diagnostics, fixtures, issues, or PRs.

## Controls

- No `scripting` permission and no page-DOM mutation.
- `site-observer.js` is the only content script; it is scoped to CHZZK live pages, sends only a live-page-ready prewarm message, and does not mutate or query the page DOM.
- No external telemetry/data collector is used by the extension runtime.
- The Firefox manifest declares no data collection/transmission with `data_collection_permissions.required: ["none"]`.
- Firefox MV2 required permissions include CHZZK live pages and trusted HLS CDN origins needed by `webRequest`, HLS availability probes, and redirects.
- No `host_permissions` or optional host permission surface is used for core functionality; the MV2 content script match is required install-time CHZZK live access.
- Local diagnostics storage mutations are serialized to avoid local read-modify-write races during HLS bursts.
- No global static or session DNR ruleset.
- Redirect handling is constrained by tab, CHZZK live context, trusted request domains, request methods, and resource types.
- Per-tab cached redirect targets are removed on tab close.
- HLS diagnostics strip query strings, fragments, signed path segments, and high-entropy CDN path tokens before local storage/export.
- The signing workflow uses a protected `firefox-signing` environment, protected ref checks, temporary non-argv AMO credential delivery, and GitHub artifact attestations for release provenance.
- `npm run verify` includes formatting, generated-runtime refresh, manifest validation, project cleanliness validation, lint, web-ext lint, unit tests, Python ops tests, dependency audit, build, and package-content audit.

## Sensitive data rules

Do not commit, paste, transmit, or store:

- cookies or request/response headers;
- full CDN/HLS URLs with query strings or fragments;
- signed policy/signature values;
- account/session identifiers;
- key-like values, UUIDs, or connection identifiers.

When adding fixtures, use only redacted path shapes and synthetic domains where possible.

## Reporting issues

For personal/private use, export the local diagnostics JSON from the popup. If opening a GitHub issue manually, include:

- extension version;
- Firefox version;
- redacted diagnostics JSON;
- popup `lastDecision` reason;
- active tab redirect target state.

Do not include full signed URLs or account/session details.
