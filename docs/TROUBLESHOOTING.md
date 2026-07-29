# Troubleshooting

## Extension does not load

Run:

```bash
npm run validate:manifest
npx web-ext lint --source-dir .
```

## Player still selects a lower quality

The extension intentionally does not rename `480p` to a fake `1080p` label. It selects the highest real manual track that CHZZK exposes and accepts through its own quality filter, and the network layer keeps matching playlist requests on that resolved quality. Check the selected player track and the `live-player-video-track` value, not just menu text. If CHZZK's filter permits only a lower track, the extension respects that limit.

## Playback buffers after making the window small

CHZZK can replace its player, `VideoTrackList`, quality pane, or responsive filter while the viewport crosses a compact-layout breakpoint. A page-owned quality setter may also apply asynchronously. Treating every resize, mutation, track event, and immediate readback as a new command can repeatedly cancel and reload the same playlist even though the network target is already `1080p`.

The controller therefore coalesces responsive bursts for 250 ms, confirms an asynchronous selection through read-only checks, and caps an unchanged generation at two writes. Its cross-generation budget begins with four ordinary writes, followed only by one non-periodic five-second recovery and one final attempt gated by genuine current-primary playback recovery; page-owned remounts cannot reset those bounds, and time spent outside an eligible player route cannot refill them. On an unchanged primary, a `waiting` hold requires 250 ms of `playing`, `canplay`, or `timeupdate` and is not released by time alone; `stalled` during that settle retains the waiting history. The hold migrates across track-list and primary replacement and remains active while the player is temporarily absent on an eligible route; a replacement or stalled-only primary gets one bounded one-second ready-state recheck across the entire unsettled episode. A temporary compact-layout filter contraction cannot make the extension actively lower or persist over an already selected higher concrete track. The Firefox functional test physically resizes a real browser window from 1200 to 560 pixels and back, requires one asynchronous `1080p` commit per remounted generation, checks continuing media time and rendered frames, and verifies `1080p` playlist routing in every phase. This deterministic fixture validates the extension boundary, not CHZZK's proprietary decoder.

## Popup shows no active redirect target

The extension does not ship a global static ruleset. CHZZK live tab identity may be prewarmed as soon as a live page starts. On a URL-less same-page reload, the background clears quality evidence separately and rechecks the authoritative tab URL so a generic-CDN first playlist can still work before the content message. Explicit foreign page metadata vetoes cached trust. With no page metadata or cached trust, compatibility is limited to the two legacy dedicated livecloud suffixes plus the exact current `livecloud.akamaized.net` host with an exact `/chzzk/` path segment; generic CDN path markers do not.

Check:

1. Page URL is `https://chzzk.naver.com/live/...`.
2. The page was opened after the current extension version loaded. If not, close and reopen the live tab once.
3. Playback has started and a numeric HLS playlist request occurred.
4. Popup `lastDecision` is one of:
   - `eligible-chzzk-hls-quality` — the runtime should resolve a per-tab target and redirect lower numeric playlist requests through blocking `webRequest`.
   - `unknown-quality-shape` — CHZZK changed URL shape; add a redacted fixture and update parser.
   - `untrusted-initiator` — request was not tied to a CHZZK live tab.
   - `untrusted-request-domain` — CDN/domain policy needs review before widening.

## Network request is not the maximum supported quality

The runtime treats prewarm as a supporting signal only. A trusted successful master response is passed through unchanged and scored before its response filter closes, so the highest valid variant is normally cached before CHZZK asks for its first numeric rendition. Without usable master evidence, the first numeric request starts one shared candidate resolution per family. Only `.m3u8` patterns enter the blocking listener, media segments bypass it, and an already-cached target redirects synchronously. Trust validation and fallback candidate resolution share one 50 ms request deadline; if resolution is not ready the listener fails open while background probing continues. Valid targets are monotonic: a later lower master or stale numeric result cannot replace a still-valid higher result. A genuine failed higher target may temporarily allow a lower rendition. Its first upward retry runs at the 10-second backoff expiry and unresolved known-failure recovery retries on playlist traffic at most every 15 seconds; ordinary discovery remains on the one-minute interval. If the failed rendition came from a master, recovery first rebuilds that exact advertised quality from the current same-family media request and stores no signed recovery URL. If the exact check still fails, it immediately checks only configured intermediate qualities above the current fallback and at or below the master ceiling. A newer lower-only master cancels that recovery and stale completion cannot promote it. Firefox `NS_BINDING_ABORTED` and `NS_ERROR_ABORT` are ignored as exact neutral client-cancellation codes because CHZZK supersedes overlapping LL-HLS requests. If a genuine older failure was deferred only because that request was still pending, cancelling the newer overlap applies the deferred failure; a newer verified success discards it.

On a same-site CHZZK list/search page, small-player continuation is limited to the documented dedicated livecloud set, including current Akamai requests only when both the exact host and `/chzzk/` segment match. A URL-only live-to-list/search SPA route change migrates a trusted master-derived or verified target with its matching secret-free failure suppression and master lineage, an eligible dedicated master observer whose current or pending redirect URL remains dedicated, or one with a successfully attached, not-yet-failed response verifier into authoritative mini-player state rather than restarting probes, even when Firefox continues attaching the original live `documentUrl`; the restriction remains active during URL-less reload validation. Matching rendition verifiers retain their order, so a request that begins after `pushState` but before `tabs.onUpdated` is not discarded and can still invalidate a genuinely broken rendition. Generic-CDN targets and observers, dedicated observers awaiting a generic redirect, unattached/failed verification, unresolved generic probes, collisions, expired evidence, and full document loads are not preserved. Delayed startup/message prewarming re-reads the current tab under an unchanged transition token before migrating reusable verified contextless state or an eligible origin-bound dedicated master observer, so a stale live snapshot cannot clear newer mini-player state or lose the master body. URL-marker-only evidence expires after a 30-second idle `markerEvidenceTtlMs`; a redirected response renews that timeout only after Firefox passes the bytes through unchanged and the bounded incremental decoder proves a usable HLS body. An exact-URL HTTP 304 is the bodyless exception. Other status-only, bodyless, malformed, redirected, or genuinely failed responses cause expiry or temporary suppression. Each probe and the whole resolution have time/size limits. Live-page changes, foreign navigation, or tab close abort and invalidate the corresponding pending work.

Check:

1. Confirm `npm run validate:manifest` passes.
2. Confirm `npm run check:generated` passes, so generated runtime matches source.
3. Confirm the tested media URL contains a numeric quality segment in one of the supported shapes:
   - `chunklist_<quality>.m3u8`
   - `/<quality>/...m3u8`
4. If a master playlist was observed, inspect its `RESOLUTION`, `FRAME-RATE`, `BANDWIDTH`, and `AVERAGE-BANDWIDTH` attributes.
5. If fallback probing was used, confirm the candidate quality is listed in `policy/quality-policy.json`.
6. If CHZZK introduces a new URL shape or HLS attribute shape, add a fixture/test and update `src/shared/quality.js` / `src/shared/request-policy.js`.

Use `lastRuntimeTransition` to distinguish the state-machine path:

- `selected / initial-selection / master-response` — the observed master seeded the target before the first rendition.
- `blocked / lower-quality` — lower evidence was seen but could not overwrite the active higher target.
- `ignored / client-cancelled` — an overlapping request was cancelled without changing quality state.
- `invalidated / network-error|response-status|response-body` — genuine failure evidence removed the target and started bounded backoff.

Diagnostics exports contain only normalized bounded records. Runtime transition values are fixed enums; raw errors, tab identifiers, signed URLs, CDN subdomains, and ports are not available for troubleshooting by design.

## A higher quality appears later

Export diagnostics from the extension popup and run:

```bash
npm run diagnostics:analyze -- diagnostics.json
```

If the analyzer reports `needsPolicyUpdate: true`, apply and verify:

```bash
npm run diagnostics:analyze -- diagnostics.json --apply
npm run verify
```

## DOM changed

The network redirect does not depend on player HTML, but real track selection deliberately uses the current `#live_player_layout > pzp-pc-layout`, `videoTracks`, and quality-filter contract. If CHZZK changes that contract, inspect both the selected track/local storage and the redacted HLS diagnostics. Do not treat a renamed menu item as playback proof.

## NAVER Live Streaming Connector popup keeps appearing

Remove NAVER Live Streaming Connector/NLiveConnector first. If the popup still appears after uninstalling it, inspect and apply `reg/fix-live-connector.reg` on Windows to remove the stale `naverliveconnector` protocol handler.

## Sensitive data handling

When sharing diagnostics, remove:

- account/session identifiers
- cookies
- query strings from CDN/HLS URLs
- signed policy/signature fields
- any key-like values, UUIDs, or connection identifiers
