# Security Policy

## Threat model

This extension observes CHZZK live-page HLS playlist requests only to redirect eligible playlist quality URLs and keep local troubleshooting diagnostics. The main risks are:

- capturing unrelated CDN or non-CHZZK traffic;
- storing signed media URL query strings;
- broad redirects affecting non-CHZZK pages;
- accidentally publishing account/session identifiers in exported diagnostics, fixtures, issues, or PRs.

## Controls

- No `scripting` permission and no page-DOM mutation.
- `site-observer.js` is the only content script; it is scoped to CHZZK live pages (`https://*.chzzk.naver.com/live/*`), sends only a live-page-ready prewarm message, and does not mutate or query the page DOM. Because Firefox may omit or stale message sender URL fields, the background queries the current tab and accepts prewarm only while its current URL is still a CHZZK live page.
- No external telemetry/data collector is used by the extension runtime.
- The Firefox manifest declares no data collection/transmission with `data_collection_permissions.required: ["none"]`.
- Firefox MV2 required permissions include CHZZK live pages (`https://*.chzzk.naver.com/live/*`) and trusted HLS CDN origins needed by `webRequest`, HLS availability probes, and redirects.
- No `host_permissions` or optional host permission surface is used for core functionality; the MV2 content script match is required install-time CHZZK live access.
- Local diagnostics storage mutations are serialized and exact-schema normalized on load/save to avoid local read-modify-write races and corrupted/unbounded persisted state. Invalid counters reset to zero, valid counters saturate at the safe-integer maximum, arrays are tail-trimmed to policy, and unknown fields are dropped.
- No global static or session DNR ruleset.
- Redirect handling is constrained by tab, CHZZK live context, trusted request domains, request methods, resource types, and an actual `.m3u8` pathname; media segments and query-only playlist strings are ineligible. Explicit non-CHZZK document/origin metadata always vetoes cached trust, which is used only when request metadata is absent.
- Contextless compatibility is limited to numeric playlists on `livecloud.pstatic.net.live.gscdn.net` and `nvelop-livecloud.pstatic.net` (including their subdomains) when page metadata is entirely absent. Generic CDN path markers are never contextless trust evidence, and contradictory metadata always vetoes this exception.
- The first request records its live context. Target state, resolved evidence, and in-flight work are keyed by tab, live context, and secret-free playlist family. Independent families cannot share results; adopting a concrete context, navigation, tab close, or request-proven mismatch invalidates the corresponding work and trust.
- URL-marker-only media evidence is restricted to its playlist family and `markerEvidenceTtlMs`. Browser-visible redirected-request errors and 4xx/5xx completions invalidate and temporarily suppress the failed target so re-resolution can downgrade without looping.
- Diagnostics persistence is fire-and-forget relative to blocking requests and startup prewarming, so storage or error-reporting failures cannot extend the request deadline or prevent already-open live tabs from being prewarmed.
- Numeric URL rewriting changes only the pathname. Signed query strings and fragments are preserved byte-for-byte. Contradictory pathname markers fail closed except for the explicitly observed `/360p/.../chunklist_480p.m3u8` legacy form, whose markers are rewritten together.
- Probe bodies require `#EXTM3U` as the exact first meaningful line, reject obvious HTML/JSON MIME types, and are capped in UTF-8 bytes. HLS attributes reject duplicate keys and accept only bounded positive decimal bandwidth/frame-rate syntax.
- HLS diagnostics use an allowlist model: canonical domain label, normalized quality, and structured media shape only. Userinfo, complete paths, query strings, fragments, signed path values, high-entropy tokens, full subdomains and ports are discarded before persistence/export. The popup renders only the shared normalized schema.
- The release workflow separates read-only build, AMO-secret signing, signed-artifact verification, OIDC attestation, and `contents: write` publication into different jobs. The read-only verification job also permanently installs the final AMO-signed XPI in checksum-pinned stock Firefox with default signature enforcement before attestation/publication. The `firefox-signing` environment is reachable only from protected `main`.
- Signing uses a dependency-free Node AMO client and an exact deterministic prepared ZIP. Secret-bearing jobs do not checkout, install packages, or hold repository/OIDC write authority; derived AMO JWTs are scoped to API-root requests plus the exact first unlisted developer-file download, authorized requests use manual/error redirect handling, and later signed-XPI redirect hops never carry authorization.
- An Actions-external, repository-scoped administrator preflight requires immutable releases to be explicitly enabled and binds the exact remote default-branch SHA/version before sending the only accepted release dispatch. Workflow `GITHUB_TOKEN` remains unable to read Administration settings, and no admin PAT is stored in Actions.
- Before AMO access, all matching draft/tag state must belong to the exact source commit and contain only canonical expected assets whose existing bytes match. Compatible partial drafts resume without overwrites; stale/foreign/extra/different-byte state fails closed. Published assets require a post-publication `immutable: true` check.
- Internal update deployment independently requires the GitHub Release to be immutable, rejects symlink ancestors, foreign ownership, and group/world-writable managed directories, and activates the same byte buffers returned by signed-release verification. A process-bound advisory lock with bounded acquire/cleanup waits serializes mutation, while a private fsynced snapshot journal makes SIGKILL/reboot recovery restartable before post-activation content/link verification can commit.
- Atomic release/AMO writes fsync the file and containing directory where meaningful. Source preparation reads and verifies through one open descriptor, canonical basenames are enforced at library boundaries, and release versions are bounded canonical `MAJOR.MINOR.PATCH` values.
- The exact-head review gate classifies broad sensitive paths plus explicit release/security labels, requires a configured review app's completed successful check on the current head, and rejects unresolved or unavailable review-thread state. Repository protection must source-bind its required check to the GitHub Actions App, apply to administrators without review bypasses, dismiss stale reviews, require at least one last-push approval, and require conversation resolution.
- `npm run verify` includes formatting, generated-runtime drift checks, manifest/project/semantic-workflow validation, lint, web-ext lint, unit/security behavior tests, dependency audit, deterministic build, and package-content audit. CI separately runs the real Firefox playback/update E2E.

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
