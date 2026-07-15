# CHZZK hardening notes

This document summarizes the extension hardening invariants for the MV2 required-permission CHZZK HLS redirect architecture.

## Runtime behavior

- A minimal MV2 `site-observer.js` content script runs at `document_start` on CHZZK live pages (`https://*.chzzk.naver.com/live/*`) and prewarms only the CHZZK live tab identity before the first playlist request; the first redirect must not depend solely on content-script timing.
- Trusted HLS master playlists start non-blocking background scoring when available, supersede an older numeric probe only in the same tab, live context, and playlist family, and cache the best target quality by resolution, frame rate, then bitrate.
- Trusted numeric HLS playlist requests use blocking `webRequest`, but the listener waits only `blockingProbeBudgetMs`. Target state, resolved state, and in-flight work are independently keyed by tab, live context, and a secret-free playlist family; query, fragment, quality markers, and recognized signed path-tail segments are excluded from that family key, and the key is never persisted in diagnostics.
- Candidate probe redirects fail closed because Firefox does not expose redirect hops to manual Fetch handling. A response must have an exact first meaningful `#EXTM3U` line, must not declare an obvious HTML/JSON content type, and is capped in UTF-8 bytes. A returned master must contain a trusted variant whose metadata and URI both prove that candidate.
- Ordinary media-playlist bodies do not declare their rendition resolution, so numeric evidence relies on consistent URL markers. This assumption is bounded to one playlist family and `markerEvidenceTtlMs` (10 seconds, with a 30-second code maximum). A 4xx/5xx `webRequest.onCompleted` result or `onErrorOccurred` event for a redirected request invalidates and temporarily suppresses that target, allowing a safe re-resolution/downgrade without a redirect loop.
- The first request records its live-channel context before probing. Explicit non-CHZZK document/origin metadata vetoes and evicts cached trust. Adopting a concrete live context invalidates older contextless work; navigation, tab close, or request-proven context mismatch aborts pending fetches, invalidates the per-tab token, and clears tab trust and cached targets, so stale async work cannot resurrect cross-context state.
- Same-URL loading clears only quality/session evidence. When Firefox omits the update URL, the background validates `tabs.get(tabId).url`; a still-live tab retains trust for a generic-CDN first playlist, while navigation or tab close cannot be re-trusted by the stale asynchronous result.
- Contextless compatibility is limited to numeric playlists on the dedicated `livecloud.pstatic.net.live.gscdn.net` and `nvelop-livecloud.pstatic.net` host suffixes when all page metadata is absent. Generic CDN path markers are never contextless trust evidence, and any contradictory metadata vetoes the exception.
- Quality rewriting uses one shared pathname grammar for parsing and replacement; only real `.m3u8` pathnames are eligible and query/hash bytes are never rewritten. Contradictory markers fail closed except for the observed `/360p/.../chunklist_480p.m3u8` legacy shape, whose two markers are rewritten together.
- Redirect handling and startup prewarming are independent of local diagnostics persistence; storage failures cannot extend the blocking request deadline or prevent already-open live tabs from being trusted after install/startup.
- Local diagnostics storage writes are serialized and exact-schema normalized on load/save. Arrays are tail-bounded by policy, corrupt counters reset to zero, valid counters saturate at `Number.MAX_SAFE_INTEGER`, unknown fields are dropped, and the popup normalizes again before rendering.

## Content script behavior

- `site-observer.js` is scoped to `https://chzzk.naver.com/live/*` and only sends `chzzk.live-page-ready`.
- The content script does not query or mutate the CHZZK page DOM.
- Firefox may omit message sender URL fields, so the background treats them as non-authoritative and queries the current tab URL before accepting prewarm. A delayed message from a document that has navigated away cannot restore tab trust.

## Permissions and data

- Firefox manifest version 2 is used so CHZZK and trusted CDN origins are declared in required `permissions`, like the user's other Firefox extensions.
- No `host_permissions`, `optional_permissions`, or `optional_host_permissions` site-access toggle surface is used for core functionality; the MV2 content script match is required install-time CHZZK live access.
- No external telemetry/data collector is used by the extension runtime.
- `data_collection_permissions` declares `required: ["none"]`.
- Diagnostic URL labels retain only a canonical allowlist domain and media shape; full subdomains and ports are discarded before local persistence/export.

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

CI also runs the checksum-pinned Firefox Developer Edition functional-only E2E. It proves a synthetic `480p` playlist is redirected to the available `1080p` fixture without altering the signed-style query and proves the synthetic `AddonManager.findUpdates` path in an isolated profile. It does not establish Release authenticity.

## Release invariants

- `package.json`, `manifest.json`, and immutable release metadata must describe the same extension version.
- Version bumps follow the project `a.b.c` SemVer rule: MAJOR for incompatible changes, MINOR for backward-compatible features, PATCH for backward-compatible bug/security fixes.
- `policy/quality-policy.json` is the source of truth for fallback candidates, probe budgets, and trusted domains.
- AMO receives only the deterministic exact-allowlist ZIP; local untracked files and symlinks cannot enter the signing input.
- Release metadata has one exact validator shared by prepare/sign/structure/update/deploy callers: fixed project identity/repository/update URL, exact keys and runtime paths, unique paths, canonical names, safe sizes, and SHA-256/Git digest syntax.
- Authorized AMO API requests reject redirects. Only an exact approved developer-file URL 404 is retried; every attempt starts there with a fresh JWT, while manually validated redirect hops receive no authorization. API JSON and signed bodies have streaming byte/depth bounds.
- The Node signed-XPI check is structural-only. It applies compressed, per-entry, aggregate, ratio, exact signature-name/size, ZIP64/multi-disk, and raw-path limits before JSZip inflation. It does not implement Mozilla cryptography.
- Release authenticity requires the separate stock-Firefox gate with default signature enforcement, permanent installation, exact ID/version/update URL, and `SIGNEDSTATE_SIGNED`. Its update mode runs previous-signed to final-signed only after the production update endpoint is deployed.
- Build, AMO-secret signing, signed verification, OIDC attestation, and `contents: write` publication are separate jobs.
- Repository immutable releases must be enabled. Compatible partial drafts are resumed by verifying existing bytes and uploading only missing assets; publication must return `immutable: true`. Exact reruns are no-ops, while mismatch or orphan tag states fail closed.
- Internal deployment derives `updates.json` from attested Release metadata and signed XPI bytes, normalizes and reuses the same validated absolute target path before mutation, rejects symlinked, externally owned, or group/world-writable managed paths, and serializes mutation with a process-bound advisory lock. Before release or live-link mutation it fsyncs a private durable snapshot journal; a killed process or reboot therefore releases the lock and the next run restores the previous generation before retrying. Link and release post-verification remain inside the rollback boundary so an unverified generation never stays live.
