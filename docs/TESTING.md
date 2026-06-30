# Testing CHZZK

## Automated checks

```bash
npm ci
npm run verify
```

`verify` runs manifest validation, ESLint, unit tests, and extension packaging.

## Manual Firefox test

Use a temporary profile instead of the main Firefox profile:

```bash
npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile
```

Manual checklist:

1. Open a CHZZK live page.
2. Open the quality menu.
3. Confirm the extension injects without console errors.
4. Confirm the highest visible quality is marked with a `CHZZK` badge, then select it if it is not already selected.
5. Confirm the actual HLS request quality in DevTools Network.
6. Confirm no cookies, signed URL queries, or tokens are copied into logs or issue reports.
