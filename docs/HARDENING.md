# CHZZK hardening notes

This document summarizes the extension hardening invariants for the MV2 required-permission CHZZK HLS redirect architecture.

## Runtime behavior

- A minimal MV2 `site-observer.js` content script runs at `document_start` on CHZZK live pages (`https://*.chzzk.naver.com/live/*`) and prewarms only the CHZZK live tab identity before the first playlist request; the first redirect must not depend solely on content-script timing.
- Trusted HLS master playlists start non-blocking background scoring when available, supersede any older in-flight numeric probe in the same tab/context, and cache the best target quality by resolution, frame rate, then bitrate.
- Trusted numeric HLS playlist requests use blocking `webRequest`, but the listener waits only `blockingProbeBudgetMs`. Candidate resolution continues in one shared in-flight promise per tab/context and is bounded by `probeResolutionBudgetMs`.
- Candidate probe redirects fail closed because Firefox does not expose redirect hops to manual Fetch handling. Numeric media-playlist evidence must match the requested quality; a returned master must contain a trusted variant whose metadata and URI both prove that candidate.
- The first request records its live-channel context before probing. Adopting a concrete live context invalidates older contextless work; navigation, tab close, or request-proven context mismatch aborts pending fetches, invalidates the per-tab token, and clears tab trust and cached targets, so stale async work or metadata-poor follow-up requests cannot resurrect cross-context state.
- Quality rewriting uses one shared pathname grammar for parsing and replacement; only real `.m3u8` pathnames are eligible and query/hash bytes are never rewritten.
- Redirect handling is independent of local diagnostics persistence; storage failures cannot extend the blocking request deadline.
- Local diagnostics storage writes are serialized to reduce read-modify-write races and use allowlisted redaction rather than denylisted parameter names.

## Content script behavior

- `site-observer.js` is scoped to `https://chzzk.naver.com/live/*` and only sends `chzzk.live-page-ready`.
- The content script does not query or mutate the CHZZK page DOM.
- Firefox may omit message sender URL fields, so the background treats them as non-authoritative and queries the current tab URL before accepting prewarm. A delayed message from a document that has navigated away cannot restore tab trust.

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
- semantic workflow validation
- ESLint and web-ext lint
- Node unit/security/transaction tests
- dependency audit
- deterministic package build/audit

CI also runs the checksum-pinned Firefox Developer Edition E2E. It proves a synthetic `480p` playlist is redirected to the available `1080p` fixture without altering the signed-style query and proves `AddonManager.findUpdates` installs the next version in an isolated profile.

## Release invariants

- `package.json`, `manifest.json`, and immutable release metadata must describe the same extension version.
- Version bumps follow the project `a.b.c` SemVer rule: MAJOR for incompatible changes, MINOR for backward-compatible features, PATCH for backward-compatible bug/security fixes.
- `policy/quality-policy.json` is the source of truth for fallback candidates, probe budgets, and trusted domains.
- AMO receives only the deterministic exact-allowlist ZIP; local untracked files and symlinks cannot enter the signing input.
- Authorized AMO API requests reject redirects. Signed-XPI downloads are separate unauthenticated requests whose HTTPS allowlisted redirect hops are validated manually.
- Build, AMO-secret signing, signed verification, OIDC attestation, and `contents: write` publication are separate jobs.
- GitHub Release tag/assets are immutable. Exact reruns are no-ops; mismatch or orphan tag states fail closed.
- Internal deployment derives `updates.json` from attested Release metadata and signed XPI bytes, commits through an immutable release directory plus atomic `current` symlink, and fully rolls back activation failures.
