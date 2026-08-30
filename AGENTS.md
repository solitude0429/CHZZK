# CHZZK project instructions

This repository contains the CHZZK Firefox extension product source. Read this file and the root `README.md` before working. Read only the task-relevant runbooks linked below. `docs/PROJECT_STATUS.md` is a dated historical handoff snapshot; consult it only when historical deployment context is relevant, and verify all time-varying state with live readback.

<!-- contract:policy read-only=no-mutation docs-only=protected-merge-no-release release-version=YY.M.D daily-release-limit=1 overflow=ship-pending -->
<!-- contract:entry-docs combined-max-utf8-bytes=10240 project-status=historical-on-demand -->

## Source map

- Product code, tests, and release pipeline: `C:\Users\Alpha\CHZZK`
- Current NixOS configuration: `C:\Users\Alpha\server-config`
- Server update tree: `/srv/admin/chzzk-updates`
- Firefox update URL: `https://chzzk.home.arpa:8443/updates.json`
- Signing and release: `docs/SIGNING.md`, `docs/OPERATIONS.md`
- Update-server deployment: `docs/UPDATES.md`

Date-stamped `server-chzzk-*` directories are historical candidates or reference material. If server configuration must change, start from a clean `server-config` checkout and make the smallest scoped change.

## Request authority

- Read-only explanation, status, investigation, or review may run `npm run chzzk -- status --json` and necessary readbacks only. Do not mutate files, branches, PRs, Releases, Actions runs, the server, or Firefox.
- A requested change to extension behavior, permissions, manifest, or packaged output authorizes the full `npm run chzzk -- ship --json` flow from a clean `agent/*` branch: protected PR, squash merge, Mozilla signing, immutable Release, internal deployment, and disposable Firefox verification.
- Documentation, test infrastructure, operator tooling, and workflow-pin changes stop after the protected PR merge. Do not change the version, create a Release, or deploy them.
- Versions use UTC `YY.M.D`, with one immutable Release per UTC day. A second same-day product change remains in the single `ship-pending` PR and ships on the next UTC day's mutating request.
- Run `npm run chzzk -- rollback <version> --json` only when the user explicitly names the version and requests rollback.

## Working rules

- Implement requested product changes immediately, then run the narrowest regression and an applicable real Firefox flow.
- `background.js`, `diagnostics.js`, `player-controller.js`, and `site-observer.js` are generated. Edit `src/` or `policy/`, then run `npm run build:runtime`.
- Deploy only Mozilla unlisted-signed assets from an immutable GitHub Release. Never place an unsigned XPI on the production update path.
- GitHub operations use this PC's `gh` keyring. Never expose or copy a raw token through environment variables, argv, files, logs, artifacts, or the server. Send only the verified unique SCP bundle and use transactional activation through `ssh server`.
- Keep exactly four Actions: CI, CodeQL, Dependency review, and Build signed Firefox release. After the last source push, review the current PR head and record an exact-head COMMENT review through `gh`; repeat checks and review after any later push. External app reviews and bot approvals are not merge gates.
- Never close the user's Firefox, overwrite its XPI, or press its update controls unless explicitly asked to modify that profile. Automated verification uses a disposable profile.
- Do not restore the retired 0.1.22 public update domain, a compatibility domain, or a port-443 listener. The installed 0.1.23 migrated to the `home.arpa:8443` channel.
- Normal server access is internal `ssh server` through the router. OCI is break-glass only when both PC and router server-SSH paths are unavailable, and requires separate authorization.
- Never print or document tokens, private keys, signed media URLs, cookies, or account identifiers.

## Completion boundary

For product changes, verify the applicable parts of the real flow: extension behavior; Mozilla signature, provenance, and immutable Release; production `updates.json` and signed-XPI version/MIME/SHA-256 readback; and disposable Firefox updating through the built-in `update_url`.

When the user requests only part of that flow, perform and report only that scope.
