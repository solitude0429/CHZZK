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

## Network request is not 1080p

This extension redirects lower CHZZK HLS playlist quality segments to the highest target quality:

- `144p`, `240p`, `270p`, `360p`, `480p`, `720p` → `1080p`
- `1080p` requests are left unchanged

Check DevTools Network for `chunklist_1080p.m3u8` or `/1080p/...m3u8` requests. If requests still show a lower quality:

1. Confirm the page URL is `https://chzzk.naver.com/live/...`.
2. Confirm `npm run validate:manifest` passes and `rules.json` is packaged.
3. Confirm the tested media URL contains one of the lower quality segments matching
   `(.*)(144p|240p|270p|360p|480p|720p)(.*\.m3u8.*)`.
4. If CHZZK introduces a new lower quality label, add it to `LOWER_QUALITIES`, `rules.json`, and the regression tests.

## DOM changed

DOM changes should not break the core redirect because no content script or DOM selector is used. If playback still fails after a
CHZZK update, inspect the HLS playlist URL shape rather than the player menu HTML.

## NAVER Live Streaming Connector popup keeps appearing

Remove NAVER Live Streaming Connector/NLiveConnector first. If the popup still appears after uninstalling it, inspect and
apply `reg/fix-live-connector.reg` on Windows to remove the stale `naverliveconnector` protocol handler.

## Sensitive data handling

When sharing diagnostics, remove:

- account/session identifiers
- cookies
- query strings from CDN/HLS URLs
- signed policy/signature fields
