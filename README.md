# CHZZK

Personal Firefox WebExtension for CHZZK live HLS quality redirects.

## What it does

- Watches trusted CHZZK live HLS playlist requests only.
- Parses trusted HLS master playlists when available and scores variants by resolution, then frame rate, then bitrate.
- Falls back to one shared, bounded background probe set per tab, live context, and secret-free playlist family when only a numeric variant playlist URL is available. Independent playlist families never share a target or in-flight promise. The blocking listener waits at most the configured latency budget and fails open while resolution continues.
- Prewarms CHZZK live tabs at `document_start` without choosing a quality, then resolves and caches the best supported quality label per playlist family. Same-URL reload clears quality evidence but authoritatively revalidates live-tab trust; navigation and tab-close cancellation tokens prevent stale probes from restoring old state.
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

Runtime redirects are constrained by tab, CHZZK live context or current-URL-validated prewarmed live-tab state, trusted CDN domains, GET requests, and media/XHR/other resource types. Explicit non-CHZZK document/origin metadata always vetoes cached trust. When Firefox provides no page metadata, the compatibility fallback is limited to numeric playlists on the dedicated `livecloud.pstatic.net.live.gscdn.net` and `nvelop-livecloud.pstatic.net` host suffixes; generic CDN path markers are never contextless trust evidence. There is no static or session DNR ruleset and no fixed startup target quality.

Numeric media-playlist evidence necessarily relies on the requested URL marker because ordinary media bodies do not declare rendition resolution. That evidence is scoped to its secret-free playlist family and expires after `markerEvidenceTtlMs`; an exposed redirected-request error or 4xx/5xx completion invalidates the target and temporarily suppresses it so the next request can re-resolve or downgrade without looping.

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
npm run test:firefox-e2e
```

Generated runtime files are `background.js`, `diagnostics.js`, and `site-observer.js`. Edit `src/`, `policy/`, or tests, then run `npm run build:runtime`.

## Install

Use the signed XPI from the latest GitHub Release. Firefox automatic updates use:

```text
https://chzzk-updates.alpha-apple.dedyn.io/updates.json
```

Mozilla unlisted signing and the immutable release pipeline are documented in `docs/SIGNING.md` and `docs/UPDATES.md`. The signing job receives only a checksum-verified prepared artifact and AMO environment secrets; verification, attestation, and `contents: write` publication run in separate jobs. Published assets are never overwritten. Mozilla signing only means the XPI is installable in Firefox; it is not NAVER approval.

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
