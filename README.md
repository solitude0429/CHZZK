# CHZZK

Personal Firefox WebExtension that removes CHZZK video ads and keeps playback on the highest concrete manual quality exposed by the player.

The extension is deliberately narrow: unrelated requests fail open, it never invents a quality, signed URL query strings and fragments remain byte-for-byte unchanged, and diagnostics stay local and redacted.

## Behavior

- Cancels only the exact CHZZK live ad-state polling routes and removes the detector token only from exact live/video-detail requests.
- Neutralizes recognized decrypted live, event-live, and VOD GFP schedules and NAVER waterfall responses in the page MAIN world, preserving envelopes and tracking context. Malformed, mixed-family, unrecognized, and unrelated payloads fail open; exact guards are in [SECURITY.md](docs/SECURITY.md).
- Suppresses only CHZZK's known ad-blocking/ad UI overlays and the exact `#live_rs_banner` and `#vod_rs_banner` elements while leaving unrelated banners rendered.
- Observes trusted CHZZK HLS master playlists, scores advertised variants by resolution, frame rate, then bitrate, and seeds the best valid target without an extra fetch.
- When Firefox exposes only a numeric rendition URL, probes one bounded concurrent fallback batch per tab, live context, and secret-free playlist family. The configured order is `2160p, 1440p, 1080p, 720p, 480p, 360p, 270p, 144p`.
- Preserves verified dedicated-livecloud state across eligible live-to-mini-player transitions while rejecting generic-CDN, stale, conflicting, or foreign-navigation evidence.
- Validates selected or redirected playlist bodies before renewing evidence. Empty, HTML, malformed, gap-only, hint-only, oversized, failed, or unavailable responses invalidate the target; exact Firefox client cancellations are neutral.
- Resolves the current CHZZK player through the live-layout React bridge with bounded fallbacks and selects only a concrete track accepted by CHZZK. Intercepted selections share the controller write budget.
- Enforces the same quality invariant on live, home, search, category, following, and mini-player routes, including remounts and silent demotions.
- Keeps signed query strings, raw browser errors, tab IDs, full subdomains, ports, cookies, and account/session identifiers out of persisted diagnostics.

Example when `1440p` is available:

```text
360p playlist   -> 1440p playlist
720p playlist   -> 1440p playlist
1080p playlist  -> 1440p playlist
1440p playlist  -> unchanged
```

Valid master-advertised qualities may exceed the fallback list. Numeric probes cannot exceed that master's ceiling. Recovery uses the current same-family request and never stores signed recovery URLs.

## Source and policy

- Runtime sources: `src/`
- Quality policy: `policy/quality-policy.json`
- Generated runtime: `background.js`, `diagnostics.js`, `player-controller.js`, `site-observer.js`
- Security model: [`docs/SECURITY.md`](docs/SECURITY.md)
- Testing: [`docs/TESTING.md`](docs/TESTING.md)
- Historical handoff snapshot: [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md)

Edit `src/`, `policy/`, or tests. Regenerate runtime files with:

```bash
npm run build:runtime
```

## Build and verify

```bash
npm ci
npm run verify
```

Useful focused checks:

```bash
npm run check:generated
npm run validate:manifest
npm run lint
npm run lint:webext
npm test
npm run build
```

The Developer Edition E2E is functional-only. Release authenticity is checked separately with real AMO-signed XPIs in stock Firefox; signature enforcement is never disabled. See [`docs/TESTING.md`](docs/TESTING.md).

## Install and updates

Install the Mozilla-signed XPI from the latest immutable GitHub Release.

Latest verified deployment: **26.9.6**, checked on 2026-09-05 UTC. See [results and limits](docs/UPDATES.md#latest-verified-deployment).

Firefox updates through:

```text
https://chzzk.home.arpa:8443/updates.json
```

The router resolves the update host over WireGuard. Caddy serves TLS on port 8443 through the isolated backend. The landing page links the signed XPI for manual installation.

Signing, protected release, and deployment procedures are in:

- [`docs/SIGNING.md`](docs/SIGNING.md)
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- [`docs/UPDATES.md`](docs/UPDATES.md)

Changes authorize implementation and scoped verification. Run `ship` only with authorization for its entire applicable flow under `AGENTS.md` and `docs/OPERATIONS.md`. Non-product changes stop at authorized protected merge.

Versions normally use UTC `YY.M.D`, one immutable Release per day. The local operator uses the `gh` keyring and sends only a verified, credential-free bundle through `ssh server`.

The sole [approved exception](docs/OPERATIONS.md#one-release-per-utc-day) released `26.9.6` early on September 5 and reserves September 6.

Mozilla signing means Firefox may install the XPI; it is not NAVER approval.

## Diagnostics

The popup shows the active tab count, target qualities, last decision, and redacted HLS samples. It stores a bounded, normalized schema locally and sends nothing to an external collector.

Clearing follows earlier accepted writes. Clears coalesce only without an intervening write. Continued playback may create new records after deletion.

If NAVER changes URL shapes or qualities:

```bash
npm run diagnostics:analyze -- diagnostics.json
npm run diagnostics:analyze -- diagnostics.json --apply
npm run verify
```

Never include complete signed URLs, cookies, headers, keys, UUIDs, or account/session identifiers in fixtures, issues, PRs, or logs.

## License

MIT. See `LICENSE` and `NOTICE`.
