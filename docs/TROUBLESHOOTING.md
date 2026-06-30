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

Check whether the current session actually receives a high-quality HLS variant. If the playlist, URL, or player menu does not expose
that variant, the extension should fail closed instead of guessing or looping. The extension intentionally does not ship a
broad static DNR redirect rule, because that can redirect to unobserved variants and break signed media URLs.

The injected page script logs `[CHZZK] observed HLS qualities` when it sees HLS playlist requests. The logged sample URL
has query strings and fragments redacted, so it can be copied into an issue after any remaining account/session details
are removed.

The shared helper `planQualityUpgrade` only returns an upgrade plan when the target quality is already present in the
observed quality set. If a preferred quality such as `1080p` is not observed, tests require it to keep the current URL
instead of inventing an unavailable variant.

## Sensitive data handling

When sharing diagnostics, remove:

- cookies
- query strings from CDN/HLS URLs
- signed policy/signature fields
- account/session identifiers
