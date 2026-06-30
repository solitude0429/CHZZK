# Security Policy

## Threat model

This extension observes CHZZK live-page HLS playlist requests, page structure signals, and runtime errors to install tab-scoped session redirect rules and feed the private auto-update loop. The main risks are:

- capturing unrelated CDN or non-CHZZK traffic;
- storing signed media URL query strings;
- collecting chat text, page text, cookies, account data, or authentication data;
- broad redirect rules affecting non-CHZZK pages;
- automatically shipping a bad patch after a website change;
- accidentally publishing account/session identifiers in diagnostics, telemetry, fixtures, issues, or PRs.

## Controls

- No `scripting` permission and no page-DOM mutation.
- The only content script is `site-observer.js`, scoped to `https://chzzk.naver.com/live/*`.
- The content script records structural summaries only: route shape, tag counts, selected class-token counts, selector samples, feature counts, and a structure hash.
- Page text, chat text, cookies, local/session storage, request/response headers, and authentication values are not collected.
- No global static DNR ruleset.
- Session rules are scoped by `tabIds`, `initiatorDomains`, `requestDomains`, `requestMethods`, and `resourceTypes`.
- HLS diagnostics strip query strings and fragments before local storage, export, or telemetry transmission.
- Telemetry is sent only to `https://chzzk-report.alpha-apple.dedyn.io/report` and only from CHZZK live pages / trusted HLS diagnostics.
- The collector validates schema, scope, add-on ID/version, event type, size, and sensitive-query patterns before writing newline-delimited JSON.
- `npm run verify` includes generated-file checks, manifest validation, project cleanliness validation, lint, web-ext lint, unit tests, dependency audit, build, and package-content audit.

## Data collection declaration

The Firefox manifest declares:

- required `websiteContent` because CHZZK live-page structure summaries are sent to the private collector;
- optional `technicalAndInteraction` because runtime errors and extension diagnostics can be transmitted.

This replaces the earlier `required: ["none"]` declaration because `0.0.5` intentionally adds private telemetry for automatic maintenance.

## Sensitive data rules

Do not commit, paste, transmit, or store:

- cookies or request/response headers;
- full CDN/HLS URLs with query strings or fragments;
- signed policy/signature values;
- account/session identifiers;
- key-like values, UUIDs, or connection identifiers.

When adding fixtures, use only redacted path shapes and synthetic domains where possible.

## Auto-update operator rules

The auto-update loop may use collected telemetry to create patches, PRs, and releases, but it must:

- prefer test-first patches;
- run `npm run format:check` and `npm run verify` before merging;
- keep generated runtime files in sync via `npm run build:runtime`;
- avoid committing raw telemetry files;
- avoid printing or preserving secrets;
- leave complex/uncertain CHZZK structural changes as a PR or issue instead of blindly publishing.

## Reporting issues

For personal/private use, prefer the private collector or a private channel. If opening a GitHub issue manually, include:

- extension version;
- Firefox version;
- redacted diagnostics JSON or collector summary;
- popup `lastDecision` reason;
- whether the session rule became active.

Do not include full signed URLs or account/session details.
