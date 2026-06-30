# Troubleshooting

## Extension does not load

Run:

```bash
npm run validate:manifest
npx web-ext lint --source-dir .
```

## Quality menu text did not change

That is expected. This extension intentionally does **not** relabel the `480p` item as `1080p with CHZZK GRID™`.
The core behavior is network-level DNR redirect, so it does not depend on CHZZK player DOM selectors.

## Network request is not target quality

This extension redirects numeric CHZZK HLS playlist quality segments lower than `policy/quality-policy.json`'s `targetQuality`.
The generated rule is range-based, not a hand-maintained list of 360/480/720 values.

Check DevTools Network for `chunklist_1080p.m3u8` or `/1080p/...m3u8` requests. If requests still show a lower quality:

1. Confirm the page URL is `https://chzzk.naver.com/live/...`.
2. Confirm `npm run validate:manifest` passes and `rules.json` is packaged.
3. Confirm `npm run check:generated` passes, so `rules.json` matches `policy/quality-policy.json`.
4. Confirm the tested media URL contains a numeric quality segment in one of the supported shapes:
   - `chunklist_<quality>.m3u8`
   - `/<quality>/...m3u8`
5. If CHZZK introduces a new URL shape, add a fixture/test and update `src/shared/quality.js` / `scripts/render-rules.js`.

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

DOM changes should not break the core redirect because no content script or DOM selector is used. If playback still fails after a
CHZZK update, inspect the HLS playlist URL shape and diagnostics export rather than the player menu HTML.

## NAVER Live Streaming Connector popup keeps appearing

Remove NAVER Live Streaming Connector/NLiveConnector first. If the popup still appears after uninstalling it, inspect and
apply `reg/fix-live-connector.reg` on Windows to remove the stale `naverliveconnector` protocol handler.

## Sensitive data handling

When sharing diagnostics, remove:

- account/session identifiers
- cookies
- query strings from CDN/HLS URLs
- signed policy/signature fields
