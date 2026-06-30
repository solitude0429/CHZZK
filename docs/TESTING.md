# Testing CHZZK

## Automated checks

```bash
npm ci
npm run verify
```

`verify` runs manifest/DNR validation, ESLint, web-ext lint, unit tests, and extension packaging.

## Manual Firefox test

Use a temporary profile instead of the main Firefox profile:

```bash
npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile
```

Manual checklist:

1. Remove or disable NAVER Live Streaming Connector/NLiveConnector on the test PC.
2. Open a CHZZK live page.
3. Select any non-1080p quality in the player, such as 360p, 480p, or 720p.
4. Confirm the quality menu is not relabeled; there should be no `1080p with CHZZK GRID™` fake item.
5. Confirm DevTools Network shows repeated `chunklist_1080p.m3u8` or `/1080p/...m3u8` requests.
6. Confirm requests for lower HLS qualities are redirected even when the selected menu item is not 480p.
7. Confirm no cookies, signed URL queries, or tokens are copied into logs or issue reports.
