# CHZZK

Personal Firefox WebExtension that removes CHZZK video ads and keeps playback on the highest concrete manual quality exposed by the player.

The extension is deliberately narrow: unrelated requests fail open, it never invents a quality, signed URL query strings and fragments remain byte-for-byte unchanged, and diagnostics stay local and redacted.

## Behavior

- Cancels only the exact CHZZK live ad-state polling routes and removes the detector token only from exact live/video-detail requests.
- Neutralizes recognized decrypted live, event-live, and VOD GFP schedules plus live/VOD NAVER waterfall responses in the page MAIN world while preserving their response envelopes and tracking context. The two live schedule IDs share one live-unit family, while VOD uses a separate exact unit set; every break must stay within its live-or-VOD family and contain populated record-only sources. Malformed required guard fields, live/VOD family crossings, mixed-family schedules, unrecognized units, and unrelated payloads fail open.
- Suppresses only CHZZK's known ad-blocking/ad UI overlays and the exact `#live_rs_banner` and `#vod_rs_banner` elements while leaving unrelated banners rendered.
- Observes trusted CHZZK HLS master playlists, scores advertised variants by resolution, frame rate, then bitrate, and seeds the best valid target without an extra fetch.
- When Firefox exposes only a numeric rendition URL, probes one bounded concurrent fallback batch per tab, live context, and secret-free playlist family. The configured order is `2160p, 1440p, 1080p, 720p, 480p, 360p, 270p, 144p`.
- Preserves verified dedicated-livecloud state across eligible live-to-mini-player transitions while rejecting generic-CDN, stale, conflicting, or foreign-navigation evidence.
- Validates selected or redirected playlist bodies before renewing evidence. Empty, HTML, malformed, gap-only, oversized, failed, or unavailable responses invalidate the target; exact Firefox client cancellations are neutral.
- Resolves the current CHZZK player through the live-layout React bridge with bounded fallbacks and selects only a concrete track accepted by CHZZK. A shared write budget prevents selection churn.
- Enforces the same quality invariant on live, home, search, category, following, and mini-player routes, including remounts and silent demotions.
- Keeps signed query strings, raw browser errors, tab IDs, full subdomains, ports, cookies, and account/session identifiers out of persisted diagnostics.

Example when `1440p` is available:

```text
360p playlist   -> 1440p playlist
720p playlist   -> 1440p playlist
1080p playlist  -> 1440p playlist
1440p playlist  -> unchanged
```

If a master advertises a quality outside the numeric fallback list, that valid advertised quality may still win. Numeric fallback evidence cannot promote a master-derived target above its advertised ceiling. Recovery derives any candidate URL transiently from the current same-family request and never stores a signed recovery URL.

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

Install the Mozilla-signed XPI from the latest immutable GitHub Release. Firefox updates through:

```text
https://chzzk.home.arpa:8443/updates.json
```

The router resolves `chzzk.home.arpa` to the server WireGuard address. Caddy terminates TLS on port 8443 and proxies to the isolated update backend. The landing page exposes the current immutable signed XPI as a manual fallback.

Signing, protected release, and deployment procedures are in:

- [`docs/SIGNING.md`](docs/SIGNING.md)
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- [`docs/UPDATES.md`](docs/UPDATES.md)

Product changes ship through a protected PR, exact-head checks and review, Mozilla unlisted signing, an immutable GitHub Release, internal transactional deployment, and a disposable Firefox update test. Documentation, test-infrastructure, operator-tool, and workflow-pin changes stop after the protected PR merge: they do not create a Release or deploy to the server.

Release versions use UTC `YY.M.D`, with at most one immutable Release per UTC day. The four retained Actions are CI, CodeQL, Dependency review, and Build signed Firefox release. The local operator uses the existing `gh` keyring and sends only a verified, credential-free SCP bundle through `ssh server`.

Mozilla signing means Firefox may install the XPI; it is not NAVER approval.

## Diagnostics

The popup shows the active redirect target, last decision, redacted HLS samples, and observed qualities. It stores a bounded, normalized schema locally and sends nothing to an external collector.

If NAVER changes URL shapes or qualities:

```bash
npm run diagnostics:analyze -- diagnostics.json
npm run diagnostics:analyze -- diagnostics.json --apply
npm run verify
```

Never include complete signed URLs, cookies, headers, keys, UUIDs, or account/session identifiers in fixtures, issues, PRs, or logs.

## License

MIT. See `LICENSE` and `NOTICE`.
