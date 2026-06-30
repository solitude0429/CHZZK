# Testing CHZZK

## Automated checks

```bash
npm ci
npm run verify
```

`verify` runs generated-runtime drift checks, manifest/session-DNR validation, ESLint, web-ext lint with warnings as errors,
unit tests, dependency audit, packaging, and package-content audit.

## Individual gates

```bash
npm run check:generated
npm run validate:manifest
npm run lint
npm run lint:webext
npm test
npm run audit:deps
npm run build
npm run audit:package
```

## Manual Firefox test

Use a temporary profile instead of the main Firefox profile:

```bash
npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile
```

Manual checklist:

1. Remove or disable NAVER Live Streaming Connector/NLiveConnector on the test PC.
2. Open a CHZZK live page.
3. Open the extension popup and confirm `activeTabIds` / `activeRuleIds` initially show `none`.
4. Start playback and select a lower numeric quality such as 360p, 480p, or 720p.
5. Reopen the popup and confirm:
   - `lastDecision: ok / eligible-lower-quality-chzzk-hls / tab <id>` appears, or
   - a clear blocked reason appears if the request is not eligible.
6. Confirm the quality menu is not relabeled; there should be no `1080p with CHZZK GRID™` fake item.
7. Confirm DevTools Network shows subsequent same-tab lower playlist requests redirected to `chunklist_1080p.m3u8` or `/1080p/...m3u8`.
8. Confirm a synthetic/future lower quality such as `540p` or `900p` is covered by unit tests, not by hand-added DNR alternatives.
9. Confirm diagnostics show only redacted HLS URLs and quality counters.
10. Confirm no cookies, signed URL queries, or tokens are copied into logs or issue reports.

## Regression fixtures

When CHZZK changes URL shapes:

1. Export diagnostics from the popup.
2. Remove every query string, fragment, account identifier, session value, and key-like value.
3. Add a minimal redacted fixture or unit test covering the new shape.
4. Watch the test fail.
5. Fix `src/shared/quality.js` or `src/shared/session-rules.js`.
6. Run `npm run verify`.

Do not paste full signed media URLs into GitHub issues, commits, or chat.
