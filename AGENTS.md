# CHZZK project instructions

Read this file and root `README.md` before working on the CHZZK extension. Follow only task-relevant runbooks. `docs/PROJECT_STATUS.md` is historical; verify time-varying state live.

<!-- contract:policy read-only=no-mutation docs-only=protected-merge-no-release release-version=YY.M.D daily-release-limit=1 overflow=ship-pending -->
<!-- contract:entry-docs combined-max-utf8-bytes=10240 project-status=historical-on-demand -->

## Source map

- Product code, tests, and release pipeline: `C:\Users\Alpha\CHZZK`
- Current NixOS configuration: `C:\Users\Alpha\server-config`
- Server update tree: `/srv/admin/chzzk-updates`
- Firefox update URL: `https://chzzk.home.arpa:8443/updates.json`
- Signing and release: `docs/SIGNING.md`, `docs/OPERATIONS.md`
- Update-server deployment: `docs/UPDATES.md`

`server-chzzk-*` directories are historical. Make scoped server changes in a clean `server-config` checkout.

## Request authority

- Explanations, status, investigations, and reviews permit only `npm run chzzk -- status --json` and necessary readbacks; no file, GitHub, server, or Firefox mutations.
- Change requests authorize implementation and scoped verification. GitHub, signing, release, and deployment actions require the global authorization rules; reuse approval for its covered stages. Run `npm run chzzk -- ship --json` from a clean `agent/*` branch only when its entire applicable flow is authorized; see `docs/OPERATIONS.md`.
- Documentation, test infrastructure, operator tooling, and workflow-pin changes may reach protected PR merge only when authorized. Never version, release, or deploy them. The `docs-only` marker is a maximum boundary, not merge permission.
- Versions use UTC `YY.M.D`, with one immutable Release per UTC day. Authorized same-day overflow stays in one `ship-pending` PR. Later shipping still needs applicable authorization; a code-edit request alone does not grant it.
- Run `npm run chzzk -- rollback <version> --json` only when the user explicitly names the version and requests rollback.

## Working rules

- Implement requested product changes immediately, then run the narrowest regression and an applicable real Firefox flow.
- `background.js`, `diagnostics.js`, `player-controller.js`, and `site-observer.js` are generated. Edit `src/` or `policy/`, then run `npm run build:runtime`.
- Deploy only Mozilla unlisted-signed assets from an immutable GitHub Release. Never place an unsigned XPI on the production update path.
- GitHub operations use this PC's `gh` keyring. Never expose or copy a raw token through environment variables, argv, files, logs, artifacts, or the server. Send only the verified unique SCP bundle and use transactional activation through `ssh server`.
- Keep exactly four Actions: CI, CodeQL, Dependency review, and Build signed Firefox release. After the last source push, review the current PR head and record an exact-head COMMENT review through `gh`; repeat checks and review after any later push. External app reviews and bot approvals are not merge gates.
- Never close the user's Firefox, overwrite its XPI, or press its update controls unless explicitly asked to modify that profile. Automated verification uses a disposable profile.
- Preserve `home.arpa:8443`; never restore the retired public update domain, a compatibility domain, or a port-443 listener.
- Normal server access is internal `ssh server` through the router. OCI is break-glass only when both PC and router server-SSH paths are unavailable, and requires separate authorization.
- Never print or document tokens, private keys, signed media URLs, cookies, or account identifiers.

## Completion boundary

Verify product behavior. Authorized shipping also requires signature, provenance, immutable Release, production version/MIME/SHA-256 readback, and disposable Firefox `update_url` verification. Finish independent authorized work before reporting a blocker; distinguish implementation, verification, and delivery.

Perform and report only the requested scope.
