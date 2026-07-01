# CHZZK telemetry auto-update loop

This repository uses a private, CHZZK-only maintenance loop. The loop receives data only when the extension popup has explicitly enabled collector transmission for the relevant telemetry category.

```text
Firefox extension telemetry, opt-in only
→ VPS collector
→ telemetry summary
→ Hermes scheduled operator
→ PR / CI / AMO signing / internal update host
→ Firefox extension update
```

## Collector

- HTTPS endpoint: `https://chzzk-report.alpha-apple.dedyn.io/report`
- Health endpoint: `https://chzzk-report.alpha-apple.dedyn.io/healthz`
- systemd service: `chzzk-telemetry-collector.service`
- local listener: `127.0.0.1:18181`
- storage: `/var/lib/chzzk-telemetry/reports-YYYYMMDD.ndjson`
- authentication: reports must be signed with HMAC-SHA256 using `CHZZK_TELEMETRY_HMAC_SECRET`; unsigned or stale requests are rejected
- quotas: per-install/global minute limits, daily file-size caps, and retention cleanup are enforced by the collector
- summary command:

```bash
sudo /usr/local/sbin/chzzk-telemetry-summary --since=-24h
```

- Hermes context script:
  - `~/.hermes/scripts/chzzk-telemetry-context.py`
  - emits `NO_ACTION` when no new telemetry summary exists

## Extension-side telemetry settings

Default state is local-only:

- `collectorEnabled: false`
- `sendDiagnostics: false`
- `sendStructure: false`
- `sendErrors: false`

The popup can enable collector transmission and then choose categories independently. Forced error reports still respect the collector opt-in gate; `force` only bypasses local rate/dedupe throttling after opt-in.

## What is collected after opt-in

Only CHZZK live scope reports are accepted:

- `scope: "chzzk-live"`
- `schemaVersion: 1`
- add-on ID `chzzk@solitude0429.local`
- extension version
- event type
- redacted HLS quality/decision aggregates, when diagnostics reports are enabled
- session-rule error category, not raw page error text, when error reports are enabled
- route shape `/live/[redacted]`, when structure reports are enabled
- tag/feature/class-token counts, when structure reports are enabled
- structure hash, when structure reports are enabled

The extension and collector reject signed CDN query values, token/auth/session-like material, raw URL paths, and raw page error strings. Stored reports keep a keyed `installIdHash`, not the raw install identifier.

## What is not collected

- cookies
- request/response headers
- page text
- chat text
- usernames
- raw channel IDs
- signed HLS query strings
- authentication/session values

## Automatic operator behavior

The scheduled Hermes operator consumes the summary and may act when there is new actionable telemetry.

Safe automated actions:

- update `policy/quality-policy.json` when higher quality is clearly observed;
- add redacted fixtures/tests for new URL shapes;
- patch parser/session-rule logic with tests;
- bump the patch version;
- run `npm run format:check` and `npm run verify`;
- open a PR;
- merge only if CI passes and the change is low-risk;
- trigger AMO unlisted signing;
- deploy the signed XPI and `updates.json` to the internal update host only after GitHub artifact attestation verifies the expected source commit and signing workflow;
- verify live URLs.

Manual-review actions:

- large CHZZK DOM/player rewrites;
- ambiguous telemetry;
- changes that require broader permissions;
- failures in AMO signing, CI, or update-host deployment.

In manual-review cases the operator should leave a PR or issue and report the blocker instead of publishing blindly.
