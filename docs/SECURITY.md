# Security Policy

## Threat model

This extension observes CHZZK live-page HLS playlist requests only to install tab-scoped session redirect rules and keep local troubleshooting diagnostics. The main risks are:

- capturing unrelated CDN or non-CHZZK traffic;
- storing signed media URL query strings;
- broad redirect rules affecting non-CHZZK pages;
- accidentally publishing account/session identifiers in exported diagnostics, fixtures, issues, or PRs.

## Controls

- No `scripting` permission and no page-DOM mutation.
- The only content script is `site-observer.js`, scoped to `https://chzzk.naver.com/live/*`, and it only sends a live-page-ready message so the background script can prewarm a tab-scoped rule.
- No external telemetry/data collector is used by the extension runtime.
- The Firefox manifest declares no data collection/transmission with `data_collection_permissions.required: ["none"]`.
- Host permissions are limited to trusted HLS CDN origins needed by `webRequest`, HLS availability probes, and session DNR redirects.
- CHZZK page access is declared once through `content_scripts.matches`, not duplicated in `host_permissions`.
- Local diagnostics storage mutations are serialized to avoid local read-modify-write races during HLS bursts.
- No global static DNR ruleset.
- Session rules are scoped by `tabIds`, `initiatorDomains`, `requestDomains`, `requestMethods`, and `resourceTypes`.
- Session rule IDs are bounded to the owned cleanup range and removed on tab close.
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
- whether the session rule became active.

Do not include full signed URLs or account/session details.
