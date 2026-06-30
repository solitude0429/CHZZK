# Troubleshooting

## Extension does not load

Run:

```bash
npm run validate:manifest
npx web-ext lint --source-dir .
```

## Quality label is not shown

CHZZK may have changed player DOM class names. Capture a minimal redacted DOM fixture around the quality menu and
add a regression test under `tests/fixtures/dom/` before changing selectors.

## Network request is not high quality

Check whether the current session actually receives a high-quality HLS variant. If the playlist or URL does not expose
that variant, the extension should fail closed instead of guessing or looping.

## Sensitive data handling

When sharing diagnostics, remove:

- cookies
- query strings from CDN/HLS URLs
- signed policy/signature fields
- account/session identifiers
