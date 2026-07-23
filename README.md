# CHZZK

Personal Firefox WebExtension for CHZZK live HLS quality redirects.

## What it does

- Watches trusted CHZZK live HLS playlist requests only; media segments bypass the blocking listener.
- Parses trusted HLS master playlists when available and scores variants by resolution, then frame rate, then bitrate.
- Falls back to one shared, bounded background probe set per tab, live context, and secret-free playlist family when only a numeric variant playlist URL is available. Independent playlist families never share a target or in-flight promise. Trust validation and candidate resolution share one 50 ms request deadline before the listener fails open while resolution continues.
- Prewarms CHZZK live tabs at `document_start` without choosing a quality, then resolves and caches the best supported quality label per playlist family. Cached redirects return synchronously. Delayed install/startup and content-message prewarming re-read the current tab under a transition token before migrating verified contextless state into the confirmed live context, so a stale snapshot cannot overwrite newer mini-player state or force another probe. A verified dedicated-livecloud target or its single in-flight candidate scan is re-keyed across live-to-search/list and repeated mini-player `pushState` transitions, even when Firefox continues reporting the original live `documentUrl`; generic-CDN work is never carried into mini-player mode. A URL-less reload keeps mini-player host restrictions until `tabs.get()` authoritatively validates the current page. Same-URL reload clears quality evidence; full navigation and tab-close cancellation tokens prevent stale probes from restoring old state.
- Rewrites quality markers in the URL pathname only; signed query strings and fragments remain byte-for-byte unchanged.
- Does not relabel the player menu, inject page scripts, or depend on CHZZK DOM selectors.
- Keeps signed CDN query strings, full subdomains, and ports out of local diagnostics.

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

Current candidate order:

```text
2160p, 1440p, 1080p, 720p, 480p, 360p, 270p, 144p
```

Runtime redirects are constrained by tab, CHZZK context, trusted CDN domains, GET requests, and media/XHR/other resource types. The blocking URL filter covers only case-complete `.m3u8` path patterns, so segment traffic never enters the handler. Explicit non-CHZZK document/origin metadata always vetoes cached trust. When a live stream continues in CHZZK's small player on a same-site list/search page, only playlists on the dedicated `livecloud.pstatic.net.live.gscdn.net` and `nvelop-livecloud.pstatic.net` host suffixes remain eligible. A URL-only live-to-list/search SPA transition migrates only a verified dedicated-host target or a target with a successfully attached, not-yet-failed response verifier into per-tab mini-player mode; later route changes reuse it without probes. Firefox may retain the original live `documentUrl` after `pushState`, so authoritative mini-player mode ignores that stale path and still rejects generic CDN traffic. Unresolved probes, unattached/failed verification, full document loads, new live-page state, foreign navigation, and tab close invalidate the state. The metadata-free compatibility fallback is limited to those same hosts; generic CDN path markers are never contextless trust evidence. There is no static or session DNR ruleset and no fixed startup target quality.

Numeric media-playlist evidence necessarily relies on the requested URL marker because ordinary media bodies do not declare rendition resolution. Rewriting and response renewal share the same marker grammar, including the observed `/360p/.../chunklist_480p.m3u8` form, so that valid legacy stream no longer expires into periodic probes. Evidence is scoped to its secret-free playlist family and uses `markerEvidenceTtlMs` as a 30-second idle timeout. Firefox streams selected-quality and redirected responses through unchanged while the background page incrementally decodes only bounded HLS verification text; only a usable playlist body paired with a successful completion renews the timeout, so status alone cannot keep an empty, HTML, or malformed target alive. An empty exact-URL HTTP 304 may renew only a representation whose exact URL was previously validated because Firefox reuses its cached playlist; empty-body judgment waits for completion status so this cache path is not mistaken for a broken HTTP 200. Newer valid evidence wins over a late failure from an older overlapping request. This avoids periodic blocking probes during valid small-player playback. HTTP 204/205, other redirects, an exposed request error, a 4xx/5xx completion, an unavailable response verifier, or invalid streamed evidence invalidates and temporarily suppresses the target so the next request can re-resolve or downgrade without looping.

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
stock-Firefox signed-artifact gate documented in `docs/TESTING.md`; it requires real AMO-signed XPIs
and never disables Firefox signature enforcement.

Generated runtime files are `background.js`, `diagnostics.js`, and `site-observer.js`. Edit `src/`, `policy/`, or tests, then run `npm run build:runtime`.

## Install

Use the signed XPI from the latest GitHub Release. Firefox automatic updates use:

```text
https://chzzk-updates.alpha-apple.dedyn.io/updates.json
```

The update host landing page exposes the current immutable signed XPI as a manual install/update fallback. Firefox's `about:addons` check installs automatically when the extension uses its default automatic-update policy; with automatic updates disabled, Firefox leaves the result pending until the user chooses the available update.

Mozilla unlisted signing and the immutable release pipeline are documented in `docs/SIGNING.md` and `docs/UPDATES.md`. The signing job receives only a checksum-verified prepared artifact and AMO environment secrets; verification, attestation, and `contents: write` draft staging run in separate jobs. An Actions-external administrator finalizer performs the just-in-time immutable-settings check and publication. Published assets are never overwritten. Mozilla signing only means the XPI is installable in Firefox; it is not NAVER approval.

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
