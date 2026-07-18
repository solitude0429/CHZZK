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
- Version bumps use canonical `a.b.c` only: no leading zero, no prerelease/build suffix, and at most 9 digits per component. MAJOR is for incompatible changes, MINOR for backward-compatible features, and PATCH for backward-compatible bug/security fixes.
- `policy/quality-policy.json` is the source of truth for fallback candidates, probe budgets, and trusted domains.
- AMO receives only the deterministic exact-allowlist ZIP; local untracked files and symlinks cannot enter the signing input.
- Release metadata has one exact validator shared by prepare/sign/structure/update/deploy callers: fixed project identity/repository/update URL, exact keys and runtime paths, unique paths, canonical names, safe sizes, and SHA-256/Git digest syntax.
- Authorized AMO API requests reject redirects. Only an exact approved developer-file URL 404 is retried; every attempt starts there with a fresh JWT, while manually validated redirect hops receive no authorization. API JSON and signed bodies have streaming byte/depth bounds.
- The Node signed-XPI check is structural-only. It applies compressed, per-entry, aggregate, ratio, exact signature-name/size, comment-free ZIP, ZIP64/multi-disk, raw-path, and full local-entry-contiguity limits before JSZip inflation. It does not implement Mozilla cryptography.
- Release authenticity requires the separate stock-Firefox gate with default signature enforcement, permanent installation, exact ID/version/update URL, and `SIGNEDSTATE_SIGNED`. The release workflow runs install mode on the final AMO-signed XPI before attestation/draft staging; update mode runs previous-signed to final-signed only after the production update endpoint is deployed.
- Build, AMO-secret signing, signed verification, OIDC attestation, and `contents: write` draft staging are separate jobs. Publication exists only in the Actions-external finalizer.
- Repository immutable releases must be enabled. An out-of-band administrator preflight binds the exact default-branch SHA/version before dispatch; the workflow has no direct release `workflow_dispatch` and no Administration credential. Before AMO, compatible partial drafts are recognized only after exact commit/tag/name/byte verification. After attested draft staging, the finalizer is invoked directly with an administrator-trusted Node executable, never through npm, npx, or a repository-controlled script shell; the CLI replaces caller `node_modules/.bin` entries with a system-only `PATH`, removes caller Git/GitHub overrides, disables Git fsmonitor/hooks and global/system config, verifies its own clean repository, rejects `assume-unchanged`/`skip-worktree` finalizer sources, compares each credentialed source byte with its exact `HEAD` blob, proves that local `HEAD` is the authenticated operator's exact protected remote default-branch head, and executes a nested data-URL graph built from those verified blobs rather than mutable module paths; the dependency-free verifier then requires every exact-source staging run to be complete and the newest run/attempt to succeed, pins local allowlisted bytes, validates exact GitHub asset metadata and three draft snapshots—including exact release/asset IDs immediately before publication—with built-in ZIP inspection, verifies exact attestations, performs a second just-in-time administrator `enabled: true` check, immediately publishes, and requires the exact immutable post-state. No other durable same-authority release writer may be active; mismatch or orphan tag states fail closed.
- Internal deployment requires the Release's independent immutable flag, derives `updates.json` from verifier-returned Release metadata and signed-XPI buffers, and never rereads a validated path for activation. It normalizes the target path, rejects symlinked, externally owned, or group/world-writable managed paths, and serializes mutation with a process-bound advisory lock whose child and cleanup waits are bounded. Before release or live-link mutation it fsyncs a private durable snapshot journal; a killed process or reboot therefore releases the lock and the next run restores the previous generation before retrying. Link and release post-verification remain inside the rollback boundary so an unverified generation never stays live.
- Atomic artifact writes fsync file data and their parent directory, source files are copied from a single verified open descriptor, and source ZIP/metadata/signed XPI/update links use exact canonical basenames.
- Release/security review gating combines current and previous renamed sensitive paths, all `docs/**`, `README.md`, and explicit labels. A manual `force_review=true` run uses a unique non-cancelable group to publish a generation-bound failure check, cancel and await older ordinary same-PR review runs while excluding other forced generations, republish the marker, persist `security-review-required`, and dispatch a matching non-cancelable forced reevaluation. Status publication selects the newest check by monotonic check-run ID, refuses to overwrite a failure marker unless its generation matches, and re-reads the check immediately before a changed POST, while ordinary PR runs still cancel stale ordinary evaluations. The gate requires zero unresolved actionable threads plus the configured connector's exact-head `APPROVED` review, its later `+1` on an operator request comment containing the full current head SHA, or its canonical unedited clean-result comment after that request with exactly one 10–40 hex reviewed-commit prefix matching the current head. The clean comment must be the latest reviewer comment, contain only the complete allowlisted body (including at most the exact stock informational footer), exactly match current PR activity time, and postdate any exact-head finding. After collecting comment evidence, reviews and threads are read between matching head/activity snapshots and only the revalidated state can pass. `COMMENTED`/`CHANGES_REQUESTED` reviews and unbound issue-level reactions are rejected; a reaction must also postdate GitHub's current PR activity timestamp and any exact-head finding review, so a pre-bound unpublished SHA cannot pass. Missing/malformed identity, SHA/prefix, full-body shape, snapshot stability, or time state fails closed, and quiet scheduled reconciliation corrects evidence creation/deletion without duplicating unchanged checks.
