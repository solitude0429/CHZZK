# CHZZK

Personal Firefox WebExtension for CHZZK live HLS quality redirects.

## What it does

- Watches trusted CHZZK live HLS playlist requests only.
- Parses trusted HLS master playlists when available and scores variants by resolution, then frame rate, then bitrate.
- Falls back to probing configured quality candidates from highest to lowest when only a numeric variant playlist URL is available.
- Prewarms CHZZK live tabs at `document_start` without choosing a quality, then resolves and caches the best supported quality label per tab while the tab is open.
- Does not relabel the player menu, inject page scripts, or depend on CHZZK DOM selectors.
- Keeps signed CDN query strings out of local diagnostics.

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

Runtime redirects are constrained by tab, CHZZK live context or prewarmed live-tab state, trusted CDN domains, GET requests, and media/XHR/other resource types. There is no static or session DNR ruleset and no fixed startup target quality; a minimal MV2 content script only sends a live-page-ready prewarm message, and the persistent MV2 background resolves and redirects eligible playlist requests through `webRequestBlocking`.

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
```

Generated runtime files are `background.js`, `diagnostics.js`, and `site-observer.js`. Edit `src/`, `policy/`, or tests, then run `npm run build:runtime`.

## Install

Use the signed XPI from the latest GitHub Release. Firefox automatic updates use:

```text
https://chzzk-updates.alpha-apple.dedyn.io/updates.json
```

Mozilla unlisted signing is documented in `docs/SIGNING.md`. It only means the XPI is installable in Firefox; it is not NAVER approval.

## Diagnostics

The popup shows active tab redirect targets, the last decision, redacted HLS samples, and observed qualities. Diagnostics stay local in the browser extension storage; the packaged extension does not send them to an external collector.

If NAVER changes URL shapes or qualities:

```bash
npm run diagnostics:analyze -- diagnostics.json
npm run diagnostics:analyze -- diagnostics.json --apply
npm run verify
```

## License

MIT. See `LICENSE` and `NOTICE`.
