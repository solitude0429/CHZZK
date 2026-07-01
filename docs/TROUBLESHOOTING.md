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

The extension does not ship a global static ruleset. A startup redirect target should be prewarmed as soon as a CHZZK live page starts, then upgraded after a trusted numeric HLS playlist request is observed in that tab.

Check:

1. Page URL is `https://chzzk.naver.com/live/...`.
2. The page was opened after the current extension version loaded. If not, close and reopen the live tab once.
3. Playback has started and a numeric HLS playlist request occurred.
4. Popup `lastDecision` is one of:
   - `eligible-chzzk-hls-quality` — a per-tab target should be resolved and a rule installed.
   - `unknown-quality-shape` — CHZZK changed URL shape; add a redacted fixture and update parser.
   - `untrusted-initiator` — request was not tied to a CHZZK live tab.
   - `untrusted-request-domain` — CDN/domain policy needs review before widening.

## Network request is not the maximum supported quality

The runtime prewarms a safe startup redirect target before the first HLS playlist request, then probes `policy/quality-policy.json` quality candidates from highest to lowest for the current HLS URL shape, redirects current lower numeric playlist requests, and upgrades the per-tab target for later lower numeric playlists in that tab.

Check:

1. Confirm `npm run validate:manifest` passes.
2. Confirm `npm run check:generated` passes, so generated runtime matches source.
3. Confirm the tested media URL contains a numeric quality segment in one of the supported shapes:
   - `chunklist_<quality>.m3u8`
   - `/<quality>/...m3u8`
4. Confirm the candidate quality is listed in `policy/quality-policy.json`.
5. If CHZZK introduces a new URL shape, add a fixture/test and update `src/shared/quality.js` / `src/shared/request-policy.js`.

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
