# Troubleshooting

## Extension does not load

Run:

```bash
npm run validate:manifest
npx web-ext lint --source-dir .
```

## Quality menu text did not change

That is expected. This extension does not relabel quality menu items such as `480p -> 1080p with CHZZK GRID™`.
The core behavior is network/webRequest level, so it does not depend on CHZZK player DOM selectors.

## Popup shows no active redirect target

The extension does not ship a global static ruleset. CHZZK live tab identity may be prewarmed as soon as a live page starts. On a URL-less same-page reload, the background clears quality evidence separately and rechecks the authoritative tab URL so a generic-CDN first playlist can still work before the content message. Explicit foreign page metadata vetoes cached trust. With no page metadata or cached trust, only the two documented dedicated livecloud host suffixes receive the compatibility fallback; generic CDN path markers do not.

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

The runtime treats prewarm as a supporting signal only. A trusted master playlist starts non-blocking variant scoring by resolution, frame rate, and bitrate and supersedes an older pending numeric probe only in the same tab/context/playlist family. Without a master, the first numeric request starts one shared candidate resolution per family. The blocking listener waits only the configured latency budget; if resolution is not ready it fails open while background probing continues. On a same-site CHZZK list/search page, small-player continuation is limited to the two dedicated livecloud hosts. URL-marker-only evidence expires after an idle `markerEvidenceTtlMs`; successful redirected-playlist completions renew that timeout, and a visible redirected-request failure causes temporary downgrade suppression. Each probe and the whole resolution have time/size limits. Candidate bodies require an exact first meaningful `#EXTM3U` line and are capped in UTF-8 bytes. Navigation or tab close aborts and invalidates pending work.

Check:

1. Confirm `npm run validate:manifest` passes.
2. Confirm `npm run check:generated` passes, so generated runtime matches source.
3. Confirm the tested media URL contains a numeric quality segment in one of the supported shapes:
   - `chunklist_<quality>.m3u8`
   - `/<quality>/...m3u8`
4. If a master playlist was observed, inspect its `RESOLUTION`, `FRAME-RATE`, `BANDWIDTH`, and `AVERAGE-BANDWIDTH` attributes.
5. If fallback probing was used, confirm the candidate quality is listed in `policy/quality-policy.json`.
6. If CHZZK introduces a new URL shape or HLS attribute shape, add a fixture/test and update `src/shared/quality.js` / `src/shared/request-policy.js`.

Diagnostics exports contain only normalized bounded records. CDN hosts are reduced to canonical allowlist domain labels; subdomains and ports are not available for troubleshooting by design.

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

DOM changes should not break the core redirect because no page script or DOM selector is used. If playback still fails after a CHZZK update, inspect the HLS playlist URL shape and diagnostics export rather than the player menu HTML.

## NAVER Live Streaming Connector popup keeps appearing

Remove NAVER Live Streaming Connector/NLiveConnector first. If the popup still appears after uninstalling it, inspect and apply `reg/fix-live-connector.reg` on Windows to remove the stale `naverliveconnector` protocol handler.

## Sensitive data handling

When sharing diagnostics, remove:

- account/session identifiers
- cookies
- query strings from CDN/HLS URLs
- signed policy/signature fields
- any key-like values, UUIDs, or connection identifiers
