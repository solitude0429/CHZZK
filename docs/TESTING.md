# Testing CHZZK

## Automated checks

```bash
npm ci
npm run verify
```

`verify` runs rules rendering, manifest/DNR validation, ESLint, web-ext lint, unit tests, and extension packaging.

## Manual Firefox test

Use a temporary profile instead of the main Firefox profile:

```bash
npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile
```

Manual checklist:

1. Remove or disable NAVER Live Streaming Connector/NLiveConnector on the test PC.
2. Open a CHZZK live page.
3. Select any non-target quality in the player, such as 360p, 480p, or 720p.
4. Confirm the quality menu is not relabeled; there should be no `1080p with CHZZK GRID™` fake item.
5. Confirm DevTools Network shows repeated `chunklist_1080p.m3u8` or `/1080p/...m3u8` requests.
6. Confirm a synthetic/future lower quality such as `540p` or `900p` is covered by unit tests, not by hand-added DNR alternatives.
7. Open the extension popup and confirm diagnostics show only redacted HLS URLs and quality counters.
8. Confirm no cookies, signed URL queries, or tokens are copied into logs or issue reports.
