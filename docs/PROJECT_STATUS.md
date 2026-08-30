# CHZZK historical project snapshot

Snapshot readback time: **2026-08-30 UTC**

> This entire document is a dated historical handoff snapshot, not current-state authority. Preserve its versions, hashes, and observed claims for traceability. Before acting, use `npm run chzzk -- status --json` and authoritative live readback. In particular, the `server-config` SHA and dirty-worktree claim recorded below are known historical values and may be stale.

<!-- contract:policy read-only=no-mutation docs-only=protected-merge-no-release release-version=YY.M.D daily-release-limit=1 overflow=ship-pending -->

## Product and installed version at snapshot time

- Repository: `C:\Users\Alpha\CHZZK`
- Remote: `solitude0429/CHZZK`
- Default branch: `main`
- Deployed version: `26.8.30`
- v26.8.30 source commit: `b1d2c413794ca61a9fb8c21fdfbeaf67344fd937`
- Firefox extension ID: `chzzk@solitude0429.local`
- Minimum Firefox: `140.0`
- Distribution: Mozilla unlisted-signed XPI, immutable GitHub Release, and internal HTTPS update host

The last user-installation readback reported v0.1.23 active and Mozilla-signed (`signedState = 2`). Its built-in update URL delivered the then-current v26.8.30. Automated verification did not modify the user's profile.

```text
https://chzzk.home.arpa:8443/updates.json
```

The former public update domain used by 0.1.22 had been retired. The snapshot explicitly prohibited restoring a compatibility domain or separate port-443 bridge. Automated shipping used disposable Firefox profiles; modifying the installed profile required an explicit installation or update request.

Scoop Firefox ESR's persisted distribution policy locked `network.trr.excluded-domains = home.arpa`. That retained the existing DoH policy for public domains while sending only `*.home.arpa` through PC-native DNS. A new disposable Firefox verified a real v0.1.23 to v26.8.30 manual and automatic `about:addons` update, Mozilla signed state 2, `permanent-signed-active`, and final `none-found`. A user Firefox process already open before the policy change needed one full exit and restart.

## GitHub Release at snapshot time

- Tag: `v26.8.30`
- State: public and immutable
- Canonical assets: three, with build provenance verified
- Signed XPI SHA-256: `688124ec05938332c1929cd7d6fb13eab18c45fd9a1f6cd1445b60c96ffa2715`
- Source ZIP SHA-256: `6b4921211ec36d14fa4fbef27f31f786a066cf9cda87ecdd08003ebfb6724648`
- Release metadata SHA-256: `782ad7a2f47d1e906730c07c41a32164bfb77505e2e5d6dd8012c049faa0341b`
- `gh release verify v26.8.30 --repo solitude0429/CHZZK`: verified successfully

v0.1.23 was the last sequential version. Beginning with v26.8.30, production versions used the UTC date as `YY.M.D`, with one immutable Release per UTC day.

## GitHub operating state at snapshot time

- GitHub CLI `2.98.0` was authenticated as `solitude0429` through this PC's keyring, with repository ADMIN readback.
- Protected `main` required native PRs, strict checks `verify`, `firefox-e2e`, `dependency-review`, and `analyze`, administrator enforcement, and conversation resolution.
- Required approval count was 0; only squash merge was allowed; auto-merge was disabled.
- Exactly four Actions were active: CI, CodeQL, Dependency review, and Build signed Firefox release.
- The AMO credential pair was stored in Actions secrets, and the `firefox-signing` environment was limited to protected branches.

The operator did not depend on an external comment-triggered review or GitHub App review. After the final source push, the operator reviewed the exact head and recorded a COMMENT review through `gh`. The external Codex GitHub App remained connected for the user's web integration, but its review was only advisory. Any unresolved conversation created by the App had to be reviewed, answered, and resolved before merge.

## Server state at snapshot time

The production path was healthy in the 2026-08-30 UTC readback:

- PC DNS: `chzzk.home.arpa -> 100.64.0.1`
- PC PowerShell HTTPS `/health`: 200
- Router-to-server WireGuard reachability: healthy
- Internal `ssh server` ProxyJump: healthy
- `protected-services.target`, `chzzk-updates.service`, `caddy.service`: active
- Backend: `127.0.0.1:18082`
- Caddy SNI: `chzzk.home.arpa:8443`
- Update tree: `/srv/admin/chzzk-updates`
- `current -> releases/26.8.30`
- Stable `updates.json`, `index.html`, and `provenance.json` links: current generation
- Live `updates.json`: HTTP 200, JSON, version 26.8.30
- Live signed XPI SHA-256: matched the immutable GitHub Release
- Unresolved deployment journal: none

The server had a public SSH listener, but PC access through `server-recovery` timed out. Because internal `ssh server` worked, this was neither a CHZZK operations blocker nor an OCI break-glass condition. Normal status, release, deployment, and rollback did not access OCI.

Historical `server-config` observation, retained verbatim as snapshot data:

- Source path: `C:\Users\Alpha\server-config`
- Recorded HEAD: `be54e6a`
- Recorded dirty claim: `deployment-identities.nix` contained an uncommitted Router WireGuard public-key change.

Those two `server-config` state claims belong only to the 2026-08-30 snapshot and are explicitly not a current checkout assertion. The CHZZK content deployment was not authorized to overwrite or clean that separate server work. Date-stamped `server-chzzk-*` directories were not deployment sources.

## Operating flow captured by the snapshot

```powershell
npm run chzzk -- status --json
npm run chzzk -- ship --json
npm run chzzk -- release --json
npm run chzzk -- deploy [version] --json
npm run chzzk -- rollback <version> --json
```

- Read-only requests ran only `status` and necessary readbacks.
- Product changes moved from a clean `agent/*` branch through verification, protected PR, exact-head COMMENT review, squash merge, signed Release, SCP deployment, and disposable Firefox update verification.
- Documentation, operator-tool, test-infrastructure, and workflow-pin changes stopped after merge and did not create a Release.
- A second product change on a UTC date with an existing Release stayed in exactly one `ship-pending` PR and shipped on the next UTC date's mutating request.
- The server received no GitHub credential, checkout, or `node_modules`. Local `gh` verified the Release and attestation before sending a unique, bounded bundle containing a self-contained ESM activator and exactly three assets through internal SSH/SCP.
- Rollback ran only after the user explicitly named the version and requested it.

For the current contracts, use `docs/OPERATIONS.md`, `docs/SIGNING.md`, and `docs/UPDATES.md`.
