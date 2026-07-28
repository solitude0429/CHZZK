# Security Policy

## Threat model

This extension observes CHZZK live-page HLS playlist requests only to redirect eligible playlist quality URLs and keep local troubleshooting diagnostics. The main risks are:

- capturing unrelated CDN or non-CHZZK traffic;
- storing signed media URL query strings;
- broad redirects affecting non-CHZZK pages;
- accidentally publishing account/session identifiers in exported diagnostics, fixtures, issues, or PRs.

## Controls

- No `scripting` permission and no page-DOM mutation.
- `site-observer.js` is the only content script; it is scoped to CHZZK live pages (`https://*.chzzk.naver.com/live` and `https://*.chzzk.naver.com/live/*`), sends only a live-page-ready prewarm message, and does not mutate or query the page DOM. Because Firefox may omit or stale message sender URL fields and asynchronous tab snapshots, the background queries the current tab under a per-tab transition token and accepts prewarm only while its current URL is still a CHZZK live page and no newer navigation or mini-player transition occurred; only reusable verified contextless state may migrate.
- No external telemetry/data collector is used by the extension runtime.
- The Firefox manifest declares no data collection/transmission with `data_collection_permissions.required: ["none"]`.
- Firefox MV2 required permissions include the CHZZK origin (`https://*.chzzk.naver.com/*`) and trusted HLS CDN origins needed by `webRequest`, HLS availability probes, and redirects. Runtime policy still limits same-site non-live playback to the two dedicated livecloud host suffixes, and the content script remains scoped to live pages.
- No `host_permissions` or optional host permission surface is used for core functionality; the MV2 content script match is required install-time CHZZK live access.
- Local diagnostics storage mutations are serialized and exact-schema normalized on load/save to avoid local read-modify-write races and corrupted/unbounded persisted state. Invalid counters reset to zero, valid counters saturate at the safe-integer maximum, arrays are tail-trimmed to policy, and unknown fields are dropped.
- No global static or session DNR ruleset.
- Redirect handling is constrained by tab, CHZZK context, trusted request domains, request methods, resource types, and an actual `.m3u8` pathname. The blocking listener uses case-complete playlist-only URL patterns, so media segments bypass it and query-only playlist strings remain ineligible. Explicit non-CHZZK document/origin metadata always vetoes cached trust. A same-site non-live CHZZK page can continue small-player playback only on the two dedicated livecloud host suffixes and cannot authorize a generic CDN playlist. A URL-only live-to-list/search SPA route change migrates only a trusted master-derived or verified dedicated-host target, one whose numeric response verifier actually attached and has not failed, an eligible dedicated master observer whose current or pending redirect URL remains dedicated, or one unambiguous dedicated candidate scan into authoritative mini-player state. Matching response verifiers remain ordered under the new context instead of being classified by an unobservable player owner: a newer request supersedes an older failure, while the first mini-player request remains able to invalidate unusable evidence even when Firefox delivers it before `tabs.onUpdated`. Stale original-live `documentUrl` metadata cannot re-adopt the old context, including during URL-less reload validation. Unresolved generic work, unattached/failed numeric verification, generic-CDN targets and master observers, dedicated observers awaiting a generic redirect, collisions, expired evidence, failed-target suppression, full document loads, concrete live-page trust, and all foreign-navigation state are removed.
- Contextless compatibility is limited to numeric playlists on `livecloud.pstatic.net.live.gscdn.net` and `nvelop-livecloud.pstatic.net` (including their subdomains) when page metadata is entirely absent. Generic CDN path markers are never contextless trust evidence, and contradictory metadata always vetoes this exception.
- The first request records its live context. Target state, resolved evidence, and in-flight work are keyed by tab, live context, and secret-free playlist family. Independent families cannot share results, expired entries are swept, and the combined state is LRU-bounded per tab and globally. Only eligible dedicated-livecloud target, master-observer, response-verification, and unambiguous candidate-scan state may be re-keyed under a new token across a same-document mini-player transition; generic-CDN work, conflicting contexts, full document loads, new live contexts, foreign navigation, tab close, and request-proven mismatch invalidate the corresponding work and trust.
- URL-marker-only media evidence is restricted to its playlist family and a 30-second `markerEvidenceTtlMs` idle timeout. Redirected and already-selected-quality response chunks are passed to the player immediately and copied only up to `probeMaxBytes`; renewal requires both a successful 2xx completion and an exact streamed body that passes HLS/quality validation. An empty HTTP 304 may renew only when that exact network URL previously passed body validation, independent of body/status event order. Target epochs and request ordering make newer valid evidence authoritative over stale overlapping failures. Firefox `NS_BINDING_ABORTED` is treated as a neutral cancellation and cannot erase the target; status alone, an unavailable verifier, empty/HTML/malformed or oversized non-304 bodies, other redirects, other browser-visible errors, and HTTP 204/205 or 4xx/5xx completions invalidate and temporarily suppress it. The first retry occurs at the failed higher target's bounded backoff expiry instead of the generic minute interval.
- Diagnostics persistence is fire-and-forget relative to blocking requests and prewarming, so storage or error-reporting failures cannot extend the request deadline or prevent live tabs from being prewarmed. Install/startup and content-message handlers migrate reusable verified contextless state or an eligible origin-bound dedicated master observer only after re-reading the current live tab under an unchanged transition token, preventing delayed delivery from erasing a target or master response that playback established first, forcing another probe, or overwriting newer mini-player state.
- Numeric URL rewriting and response renewal use the same bounded pathname-marker grammar. Signed query strings and fragments are preserved byte-for-byte. Contradictory pathname markers fail closed except for the explicitly observed `/360p/.../chunklist_480p.m3u8` legacy form, whose markers are rewritten together and whose valid response body renews the selected target without periodic re-probing.
- Probe bodies require `#EXTM3U` as the exact first meaningful line plus a usable master variant, media segment, or LL-HLS part reference; an `#EXT-X-PART` with `GAP=YES` is unavailable and cannot establish or renew quality evidence. Probe bodies reject obvious HTML/JSON MIME types and are capped in UTF-8 bytes. HLS attributes reject duplicate keys and accept only bounded positive decimal bandwidth/frame-rate syntax.
- HLS diagnostics use an allowlist model: canonical domain label, normalized quality, structured media shape, and fixed runtime-transition enums only. Userinfo, complete paths, query strings, fragments, signed path values, high-entropy tokens, raw browser errors, tab identifiers, full subdomains and ports are discarded before persistence/export. The popup renders only the shared normalized schema.
- The release workflow separates read-only build, AMO-secret signing, signed-artifact verification, OIDC attestation, and `contents: write` draft staging into different jobs. The read-only verification job permanently installs the final AMO-signed XPI in checksum-pinned stock Firefox with default signature enforcement before attestation/staging. The `firefox-signing` environment is reachable only from protected `main`.
- Signing uses a dependency-free Node AMO client and an exact deterministic prepared ZIP. Secret-bearing jobs do not checkout, install packages, or hold repository/OIDC write authority; derived AMO JWTs are scoped to API-root requests plus the exact first unlisted developer-file download, authorized requests use manual/error redirect handling, and later signed-XPI redirect hops never carry authorization.
- A single out-of-band `release` operation checks the configured operator, protected clean exact head, canonical version, and immutable-release setting; dispatches a nonce-bound staging run; waits for its exact actor/source/branch/workflow identity; then rechecks the remote/local state before loading the protected finalizer. No administrator token is stored in Actions.
- Before AMO access, all matching draft/tag state must belong to the exact source commit and contain only canonical expected assets whose existing bytes match. Compatible partial drafts resume without overwrites; stale/foreign/extra/different-byte state fails closed. The out-of-band finalizer verifies three stable draft snapshots and attestations, checks the admin-only immutable setting immediately before publishing the exact release ID, and then requires the exact immutable post-state.
- Internal update deployment independently requires the GitHub Release to be immutable, rejects symlink ancestors, foreign ownership, and group/world-writable managed directories, and activates the same byte buffers returned by signed-release verification. A process-bound advisory lock with bounded acquire/cleanup waits serializes mutation, while a private fsynced snapshot journal makes SIGKILL/reboot recovery restartable before post-activation content/link verification can commit.
- Atomic release/AMO writes fsync the file and containing directory where meaningful. Source preparation reads and verifies through one open descriptor, canonical basenames are enforced at library boundaries, and release versions are bounded canonical `MAJOR.MINOR.PATCH` values.
- The final direct Codex review is the single qualitative review layer. Its review record must identify the current full PR head SHA after the PR body and every high-risk impact note are finalized; any later source push requires all deterministic checks and a new final review. Immediately before the manual squash merge, the owner rechecks that reviewed commit against the current head and requires zero unresolved conversations. No custom review-completion workflow or required status represents this evidence: GitHub checks are commit-scoped rather than PR-scoped, can be reused by another PR sharing the commit, and only respond asynchronously to PR or comment metadata changes. The sole-owner branch instead requires GitHub-Actions-bound CI, Firefox E2E, dependency review, CodeQL, administrator enforcement, and native conversation resolution, without an impossible self-approval, approval count, or duplicate bot review.
- `npm run verify` includes formatting, generated-runtime drift checks, manifest/project/semantic-workflow validation, lint, web-ext lint, unit/security behavior tests, shared-module and non-vacuous VM-bundle coverage thresholds, dependency audit, deterministic build, and package-content audit. Signed release allowlists also require `LICENSE` and `NOTICE`. CI separately runs the real Firefox playback/update E2E.

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
