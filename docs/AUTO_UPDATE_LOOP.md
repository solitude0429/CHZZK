# CHZZK telemetry auto-update loop

This document is historical. The current Firefox extension runtime no longer sends telemetry to an external collector and no longer exposes collector/category toggles in the popup.

Current state:

```text
Firefox extension
→ local redacted diagnostics only
→ manual export when needed
→ PR / CI / AMO signing / internal update host
→ Firefox extension update
```

## Retired collector path

The previous private collector path accepted explicitly opt-in extension reports and fed a scheduled operator. That path is no longer part of the packaged extension runtime or manifest permissions. Do not re-enable it unless the user explicitly accepts the extra Firefox data-consent UI and the corresponding host permission.

If it is ever reintroduced, it must remain:

- CHZZK-only;
- opt-in only;
- HMAC-authenticated;
- rate-limited;
- sanitized before storage;
- covered by tests and manifest data collection declarations.

## Current operator behavior

Safe automated actions are based on local diagnostics exported by the user or on redacted fixtures committed to the repository:

- update `policy/quality-policy.json` when a higher quality is clearly observed;
- add redacted fixtures/tests for new URL shapes;
- patch parser/request-policy logic with tests;
- bump the patch version;
- run `npm run format:check` and `npm run verify`;
- open a PR;
- merge only if CI passes and the change is low-risk;
- trigger AMO unlisted signing;
- deploy the signed XPI and `updates.json` to the internal update host only after GitHub artifact attestation verifies the expected source commit and signing workflow;
- verify live URLs.

Manual-review actions:

- large CHZZK DOM/player rewrites;
- ambiguous diagnostics;
- changes that require broader permissions;
- failures in AMO signing, CI, or update-host deployment.

In manual-review cases the operator should leave a PR or issue and report the blocker instead of publishing blindly.
