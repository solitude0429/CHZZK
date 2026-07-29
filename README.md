# CHZZK

Personal Firefox WebExtension that keeps CHZZK playback on the highest concrete manual quality exposed by the player.

## What it does

- Watches trusted CHZZK live HLS playlist requests only; media segments bypass the blocking listener.
- Streams trusted HLS master responses to CHZZK unchanged while boundedly scoring their variants by resolution, then frame rate, then bitrate before the response closes. A dedicated-livecloud master observation may cross the same-tab live-to-mini-player transition under a new context token, so shrinking the player does not discard the response while it is still streaming. This seeds the highest valid target before the first numeric rendition request without a duplicate fetch; master-advertised qualities are not capped to the numeric fallback grid.
- Falls back to one shared, bounded concurrent background probe batch per tab, live context, and secret-free playlist family when only a numeric variant playlist URL is available. Eligible candidates start together so unavailable synthetic tiers cannot starve `1080p`; results are still consumed from highest to lowest. Independent playlist families never share a target or in-flight promise. Trust validation and candidate resolution share one 50 ms request deadline before the listener fails open while resolution continues.
- Prewarms CHZZK live tabs at `document_start` without choosing a quality, then resolves and caches the best supported quality label per playlist family. Cached redirects return synchronously. A trusted master replaces an earlier numeric-fallback target in either direction. The resulting master-advertised target is authoritative for its live context: ordinary numeric probing cannot promote it to an unadvertised rendition, while a later trusted master may promote it. Numeric-fallback targets remain monotonic and get one ordinary non-blocking refresh per minute. After a genuine higher-target failure, recovery starts at the 10-second failure-backoff expiry and, while the known failure remains unresolved, retries on playlist traffic at most every 15 seconds. Master-based recovery first rebuilds the exact advertised higher quality from the current same-family media request. If that exact check still fails, the same lineage- and target-guarded cycle may promote only a proven configured quality above the current fallback and at or below the advertised ceiling. This preserves the current signed query without retaining a signed recovery URL. A newer master that omits the quality revokes pending recovery so a stale result cannot restore it. Delayed install/startup and content-message prewarming re-read the current tab under a transition token before migrating verified contextless state or an eligible origin-bound dedicated master observer into the confirmed live context, so a stale snapshot cannot overwrite newer mini-player state or force another probe. A trusted dedicated-livecloud master target, verified dedicated-livecloud numeric target, eligible in-flight master response whose current or pending redirect remains on a dedicated host, or single in-flight candidate scan is re-keyed across live-to-search/list and repeated mini-player `pushState` transitions, even when Firefox continues reporting the original live `documentUrl`; generic-CDN work and observers awaiting a generic redirect are never carried into mini-player mode. Matching rendition verifiers retain their order across the transition: a newer mini-player verifier supersedes an older request failure, while a genuine failure from the first mini-player request remains authoritative even if it started before `tabs.onUpdated` arrived. If that newer verifier is only client-cancelled, the deferred genuine failure is applied instead of being lost. A URL-less reload keeps mini-player host restrictions until `tabs.get()` authoritatively validates the current page. Same-URL reload clears quality evidence; full navigation and tab-close cancellation tokens prevent stale probes from restoring old state.
- Rewrites quality markers in the URL pathname only; signed query strings and fragments remain byte-for-byte unchanged.
- Resolves the current player from CHZZK's live-layout React bridge (`wrapper.videoTracks`), with bounded legacy DOM fallbacks, and selects the highest concrete manual track by resolution, pixel count, and bitrate. The quality-pane display filter is not selection authority. The official `live-player-video-track` `{label,width,height}` value is persisted only after the exact current player confirms the selection; a temporary low-only state cannot replace a higher stored intent.
- Enforces the same invariant anywhere a CHZZK page contains the player, including live, home, search, category, following, and mini-player routes. Document-start storage protection, immediate player-root mutation handling, track/media/route/viewport signals, and a one-second watchdog cover cold loads, remounts, silent late tracks, and silent demotions. Stable checks make no selection write, and no continuous `timeupdate` listener is installed.
- Wraps configurable CHZZK track accessors in the MAIN world. A page request for ABR or a lower track is synchronously suppressed when the highest track is already selected, or redirected to the highest track before the lower setter can start a lower playlist or buffering cycle. Replaced descriptors, track lists, players, and pane filters are rebound; stop restores the exact page-owned descriptors and removes timers and listeners.
- Confirms asynchronous controller-owned selections without write churn. A controller-wide four-write burst budget is shared across route, pane, filter, and remount churn, then refills at most one write per five seconds. React discovery prioritizes the live layout over preview videos and has global fiber/state traversal caps.
- Does not fake a quality label or invent a track that CHZZK did not expose. The player-only controller has no extension API or signed-URL access. Its page-global singleton replaces 0.1.22-or-newer instances, while the synchronous accessor guard also neutralizes lower-track attempts from an older controller left alive in a tab during an add-on update.
- Keeps signed CDN query strings, raw browser errors, tab identifiers, full subdomains, and ports out of the bounded local state-transition diagnostics.

Example with supported `1440p`:

```text
360p playlist   -> 1440p playlist
720p playlist   -> 1440p playlist
1080p playlist  -> 1440p playlist
1440p playlist  -> unchanged
```

If `1440p` is not available but `1080p` is, the tab target becomes `1080p`. Master playlist scoring can use frame-rate and bitrate to choose the best target quality, but redirects preserve the live playlist request shape instead of pinning playback to a stale exact playlist URL. The extension does not create qualities NAVER does not serve.

## Policy

Source of truth: `policy/quality-policy.json`

Numeric fallback candidate order:

```text
2160p, 1440p, 1080p, 720p, 480p, 360p, 270p, 144p
```

The fallback list is needed only when Firefox exposes a numeric rendition URL without a master list; arbitrary quality labels cannot be enumerated from that one URL. When a trusted master is available, its advertised variants are scanned directly and the highest valid one can be selected even when its label is absent from the fallback list. Newly observed master evidence replaces an earlier numeric target even when the advertised quality is lower. Numeric evidence does not supersede a valid master-derived target except inside the matching-lineage recovery cycle after a genuine same-family failure: the exact advertised quality is checked first, then lower configured qualities above the current fallback may be proven without crossing that advertised ceiling. The recovery URL is derived transiently from the current media request and is never stored in lineage or failure state. A newer master, a context reset, or successful exact recovery changes that authority.

Runtime redirects are constrained by tab, CHZZK context, trusted CDN domains, GET requests, and media/XHR/other resource types. The blocking URL filter covers only case-complete `.m3u8` path patterns, so segment traffic never enters the handler. Explicit non-CHZZK document/origin metadata always vetoes cached trust. When a live stream continues in CHZZK's small player on a same-site list/search page, only playlists on the legacy dedicated `livecloud.pstatic.net.live.gscdn.net` and `nvelop-livecloud.pstatic.net` host suffixes, or the exact current `livecloud.akamaized.net` host with an exact `/chzzk/` path segment, remain eligible. A URL-only live-to-list/search SPA transition migrates only a trusted master-derived or verified dedicated-host target, a target with a successfully attached and not-yet-failed response verifier, an eligible dedicated master observer whose current or pending redirect URL remains dedicated, or the single unambiguous dedicated candidate scan into per-tab mini-player mode; later route changes reuse that state without probes. Firefox may retain the original live `documentUrl` after `pushState`, so authoritative mini-player mode ignores that stale path and still rejects generic CDN traffic. Generic master observers, dedicated observers awaiting a generic redirect, unresolved generic probes, unattached/failed numeric verification, full document loads, new live-page state, foreign navigation, and tab close invalidate the state. The metadata-free compatibility fallback is limited to those same hosts; generic CDN path markers are never contextless trust evidence. There is no static or session DNR ruleset and no fixed startup target quality.

Numeric media-playlist evidence necessarily relies on the requested URL marker because ordinary media bodies do not declare rendition resolution. Rewriting and response renewal share the same marker grammar, including the observed `/360p/.../chunklist_480p.m3u8` form, so that valid legacy streams remain synchronous. Evidence is scoped to its secret-free playlist family and uses `markerEvidenceTtlMs` as a 30-second idle timeout. Firefox streams selected-quality and redirected responses through unchanged while the background page incrementally decodes only bounded HLS verification text; only a usable playlist body paired with a successful completion renews the timeout, so status alone cannot keep an empty, HTML, malformed, or gap-only target alive. An empty exact-URL HTTP 304 may renew only a representation whose exact URL was previously validated because Firefox reuses its cached playlist; empty-body judgment waits for completion status so this cache path is not mistaken for a broken HTTP 200. Newer valid evidence wins over a late failure from an older overlapping request. Firefox's exact user-cancellation codes, `NS_BINDING_ABORTED` and `NS_ERROR_ABORT`, are neutral because CHZZK routinely supersedes overlapping LL-HLS requests: they neither renew nor invalidate the target. A neutral cancellation does not erase a genuine older failure that was deferred solely while the cancelled request remained pending. HTTP 204/205, other redirects, other exposed request errors, a 4xx/5xx completion, an unavailable response verifier, or invalid streamed evidence invalidates and temporarily suppresses the target so the next request can re-resolve without looping.

## Build and verify

```bash
npm ci
npm run verify
```

Useful individual checks:

```bash
npm run check:generated
npm run validate:manifest
npm run lint
npm run lint:webext
npm test
npm run build
npm run setup:firefox-e2e
FIREFOX_BINARY="$PWD/dist/e2e-tools/firefox/firefox" \
GECKODRIVER_BINARY="$PWD/dist/e2e-tools/geckodriver" \
npm run test:firefox-functional-e2e
```

That unsigned Developer Edition test is functional-only. Release authenticity uses the separate
stock-Firefox signed-artifact gates documented in `docs/TESTING.md`; they require real AMO-signed
XPIs and never disable Firefox signature enforcement. The repository includes a native Windows
runner for the post-deployment old-to-new signed update check.

Generated runtime files are `background.js`, `diagnostics.js`, `player-controller.js`, and `site-observer.js`. Edit `src/`, `policy/`, or tests, then run `npm run build:runtime`.

## Install

Use the signed XPI from the latest GitHub Release. Firefox automatic updates use:

```text
https://chzzk-updates.alpha-apple.dedyn.io/updates.json
```

The update host landing page exposes the current immutable signed XPI as a manual install/update fallback. Firefox's `about:addons` check installs automatically when the extension uses its default automatic-update policy; with automatic updates disabled, Firefox leaves the result pending until the user chooses the available update.

Mozilla unlisted signing and the immutable release pipeline are documented in `docs/SIGNING.md` and `docs/UPDATES.md`. One out-of-band `release` operation verifies the protected exact head and immutable-release setting, dispatches the separated build/sign/stock-Firefox/attestation/draft-staging chain, waits for its exact nonce-bound run, and then performs a fresh just-in-time administrator preflight before immutable publication. The administrator token never enters Actions, and published assets are never overwritten. Mozilla signing only means the XPI is installable in Firefox; it is not NAVER approval.

## Diagnostics

The popup shows active tab redirect targets, the last decision, redacted HLS samples, and observed qualities. Diagnostics stay local in the browser extension storage; the packaged extension does not send them to an external collector. Persisted data is exact-schema normalized and bounded, and hostnames are reduced to canonical allowlist domain labels with subdomains and ports discarded.

If NAVER changes URL shapes or qualities:

```bash
npm run diagnostics:analyze -- diagnostics.json
npm run diagnostics:analyze -- diagnostics.json --apply
npm run verify
```

## License

MIT. See `LICENSE` and `NOTICE`.
