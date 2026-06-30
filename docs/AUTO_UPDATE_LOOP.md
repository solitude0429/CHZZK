# CHZZK telemetry auto-update loop

This repository uses a private, CHZZK-only maintenance loop:

```text
Firefox extension telemetry
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
- summary command:

```bash
sudo /usr/local/sbin/chzzk-telemetry-summary --since=-24h
```

- Hermes context script:
  - `~/.hermes/scripts/chzzk-telemetry-context.py`
  - emits `NO_ACTION` when no new telemetry summary exists

## What is collected

Only CHZZK live scope reports are accepted:

- `scope: "chzzk-live"`
- `schemaVersion: 1`
- add-on ID `chzzk@solitude0429.local`
- extension version
- event type
- redacted HLS quality/decision aggregates
- session-rule error summary
- route shape `/live/[redacted]`
- tag/feature/class-token counts
- structure hash

The extension and collector reject signed CDN query values and token/auth/session-like query strings.

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
- deploy the signed XPI and `updates.json` to the internal update host;
- verify live URLs.

Manual-review actions:

- large CHZZK DOM/player rewrites;
- ambiguous telemetry;
- changes that require broader permissions;
- failures in AMO signing, CI, or update-host deployment.

In manual-review cases the operator should leave a PR or issue and report the blocker instead of publishing blindly.
