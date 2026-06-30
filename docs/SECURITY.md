# Security Policy

## Threat model

This extension observes CHZZK HLS playlist requests to install tab-scoped session redirect rules. The main risks are:

- capturing unrelated CDN traffic;
- storing signed media URL query strings;
- broad redirect rules affecting non-CHZZK pages;
- accidentally publishing account/session identifiers in diagnostics or fixtures.

## Controls

- No content script, page script, DOM mutation, or `scripting` permission.
- No global static DNR ruleset.
- Session rules are scoped by `tabIds`, `initiatorDomains`, `requestDomains`, `requestMethods`, and `resourceTypes`.
- Diagnostics are stored only in local extension storage.
- Query strings and fragments are stripped before diagnostics are stored/exported.
- `npm run verify` includes lint, web-ext lint, unit tests, dependency audit, build, and package-content audit.

## Sensitive data rules

Do not commit or paste:

- cookies or request/response headers;
- full CDN/HLS URLs with query strings or fragments;
- signed policy/signature values;
- account/session identifiers;
- key-like values, UUIDs, or connection identifiers.

When adding fixtures, use only redacted path shapes and synthetic domains where possible.

## Reporting issues

For personal/private use, prefer a private channel. If opening a GitHub issue, include:

- extension version;
- Firefox version;
- redacted diagnostics JSON;
- popup `lastDecision` reason;
- whether the session rule became active.

Do not include full signed URLs or account/session details.
