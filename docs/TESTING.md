# Testing CHZZK

## Automated checks

```bash
npm ci
npm run verify
```

`verify` runs bundle generation, manifest/DNR validation, ESLint, web-ext lint, unit tests, and extension packaging.

## Manual Firefox test

Use a temporary profile instead of the main Firefox profile:

```bash
npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile
```

Manual checklist:

1. Remove or disable NAVER Live Streaming Connector/NLiveConnector on the test PC.
2. Open a CHZZK live page.
3. Open the quality menu.
4. Confirm the extension injects without console errors.
5. Confirm the `480p` item is displayed as `1080p with CHZZK GRID™`.
6. Select that item.
7. Confirm DevTools Network shows repeated `chunklist_1080p.m3u8` or `/1080p/...m3u8` requests.
8. Confirm no cookies, signed URL queries, or tokens are copied into logs or issue reports.
