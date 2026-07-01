# CHZZK

Personal Firefox WebExtension for CHZZK live HLS quality redirects.

## What it does

- Watches trusted CHZZK live HLS playlist requests only.
- Prewarms a tab-scoped startup redirect when a CHZZK live page starts, so playback does not need a manual refresh before moving off low quality.
- Probes configured quality candidates from highest to lowest.
- Redirects the current numeric playlist request and installs a tab-scoped session DNR rule for later requests below the resolved maximum.
- Does not relabel the player menu, inject page scripts, or depend on CHZZK DOM selectors.
- Keeps signed CDN query strings out of local diagnostics.

Example with supported `1440p`:

```text
360p playlist   -> 1440p playlist
720p playlist   -> 1440p playlist
1080p playlist  -> 1440p playlist
1440p playlist  -> unchanged
```

If `1440p` is not available but `1080p` is, the tab target becomes `1080p`. The extension does not create qualities NAVER does not serve.

## Policy

Source of truth: `policy/quality-policy.json`

Current candidate order:

```text
2160p, 1440p, 1080p, 720p, 480p, 360p, 270p, 144p
```

Runtime rules are session-only and scoped by tab, CHZZK live context, trusted CDN domains, GET requests, and media/XHR resource types. There is no always-on static DNR ruleset. The startup prewarm target is `1080p`; after the first trusted numeric playlist is observed, the tab target is upgraded to the highest supported candidate when available.

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

The popup shows the active tab rule, last decision, redacted HLS samples, and observed qualities. Diagnostics stay local in the browser extension storage; the packaged extension does not send them to an external collector.

If NAVER changes URL shapes or qualities:

```bash
npm run diagnostics:analyze -- diagnostics.json
npm run diagnostics:analyze -- diagnostics.json --apply
npm run verify
```

## License

MIT. See `LICENSE` and `NOTICE`.
