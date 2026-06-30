# Troubleshooting

## Extension does not load

Run:

```bash
npm run validate:manifest
npx web-ext lint --source-dir .
```

## `1080p with CHZZK GRID™` is not shown

CHZZK may have changed player DOM class names. Capture a minimal redacted DOM fixture around the quality menu and add a
regression test under `tests/fixtures/dom/` before changing selectors.

The label is only UI text. If the label intermittently fails to render, selecting the raw `480p` item should still trigger
the same DNR redirect and play through the 1080p playlist.

## Network request is not 1080p

This project intentionally follows the original grid-bypass concept:

- player menu `480p` item → displayed as `1080p with CHZZK GRID™`
- HLS playlist URL containing `480p` → static DNR redirect to `1080p`

Check DevTools Network for `chunklist_1080p.m3u8` or `/1080p/...m3u8` requests. If requests still show `480p`:

1. Confirm Firefox is running on Windows; the extension disables the redirect ruleset on non-Windows platforms.
2. Confirm the page URL is `https://chzzk.naver.com/live/...`.
3. Confirm `npm run validate:manifest` passes and `rules.json` is packaged.
4. Confirm the tested media URL contains a `480p` segment matching `(.*)480p(.*\.m3u8.*)`.

## NAVER Live Streaming Connector popup keeps appearing

Remove NAVER Live Streaming Connector/NLiveConnector first. If the popup still appears after uninstalling it, inspect and
apply `reg/fix-live-connector.reg` on Windows to remove the stale `naverliveconnector` protocol handler.

## Sensitive data handling

When sharing diagnostics, remove:

- account/session identifiers
- cookies
- query strings from CDN/HLS URLs
- signed policy/signature fields
