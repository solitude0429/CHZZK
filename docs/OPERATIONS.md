# CHZZK operations

<!-- contract:policy read-only=no-mutation docs-only=protected-merge-no-release release-version=YY.M.D daily-release-limit=1 overflow=ship-pending -->
<!-- contract:review exact-head-comment=required external-app=advisory merge=manual-squash auto-merge=disabled -->

## Operator interface

These are the only public operator commands for GitHub and the internal update server:

```powershell
npm run chzzk -- status --json
npm run chzzk -- ship --json
npm run chzzk -- release --json
npm run chzzk -- deploy [version] --json
npm run chzzk -- rollback <version> --json
```

- `status` reads GitHub, the local checkout, Releases, and the server without mutation.
- `ship` takes a product change through PR verification, merge, Release, server deployment, and disposable Firefox update verification.
- `release` signs a canonical version already merged into protected `main` and publishes an immutable GitHub Release.
- `deploy` installs the canonical Release, or the named immutable Release, on the internal server.
- `rollback` moves stable links to an explicitly requested earlier immutable version.

Every GitHub call uses this PC's GitHub CLI keyring. Never pass a raw token through an environment variable, argv, file, log, artifact, or server. The server does not authenticate to GitHub; it receives only a locally verified, uniquely named SCP bundle.

## Request classification

- Explanations, investigations, status checks, and reviews are read-only. Run `status` and necessary readbacks only; do not change a branch, commit, PR, Actions run, Release, server, or Firefox.
- A requested change to extension behavior, manifest, permissions, or packaged output authorizes the complete `ship` flow. After checks pass, continue through squash merge, signing, publication, deployment, and verification without per-stage approval.
- Documentation, operator tooling, test infrastructure, and workflow-pin changes stop after the protected PR merge. Do not change the version, create a Release, or deploy them.
- Rollback is never inferred. Run it only when the user explicitly identifies the target version and requests rollback.

The installed Firefox profile is a separate boundary. Automated shipping uses a new disposable profile. Unless the user explicitly requests an installation or real-profile update, do not close Firefox, overwrite its installed XPI, or operate its update controls.

## One Release per UTC day

The production version is the UTC date without zero padding: `YY.M.D` (for example, `26.8.30`).

- Publish at most one immutable Release per UTC day.
- If the day's slot is free, `ship` aligns the four version fields in `manifest.json`, `package.json`, and `package-lock.json`.
- If the day's Release already exists, do not bump or merge another product change. Create or update exactly one `ship-pending` PR.
- The next mutating product request after the UTC date changes resumes that PR, assigns the new date version, verifies it, and ships it. Do not add a scheduler or fifth Action.
- An exact existing tag, source SHA, and asset set is an idempotent no-op. A run for the same SHA or a compatible draft may resume. A foreign SHA, unexpected asset, or duplicate run fails closed before mutation.

## Product change and protected merge

1. Read remote `main` and require a clean `agent/*` branch.
2. Add a regression test for a real defect and regenerate runtime files when applicable.
3. Run the narrowest related tests, then `npm run verify` and any applicable Firefox E2E.
4. If the daily slot is free, align the four canonical version fields, verify again, and commit the source change.
5. Create the PR with `gh`. After the final source push, finalize the body and its permissions, privacy, release, and deployment notes.
6. Require `verify`, `firefox-e2e`, `dependency-review`, and `analyze` to pass on the exact PR head, with zero unresolved conversations.
7. The operating agent reviews the final diff and records an exact-head COMMENT review through `gh`, identifying the current head SHA. Any later source push requires all checks and a new exact-head COMMENT.
8. Re-read base and head, then perform a manual squash merge. Do not use GitHub auto-merge or generic unattended merge.
9. For a product change only, continue with `release`, `deploy`, and post-deployment verification.

This sole-owner repository keeps zero required approvals while retaining native PRs, strict required checks, administrator enforcement, and conversation resolution.

## Release

`npm run chzzk -- release --json` performs one bounded operation:

1. Verify local `gh` identity, repository ID, protected remote `main`, canonical UTC version, immutable-release configuration, and tag/Release conflicts.
2. Dispatch `Build signed Firefox release` with an unpredictable nonce plus exact `source_sha` and `version`.
3. Poll only the run bound to that workflow ID, source SHA, and nonce.
4. Download `chzzk-release-assets-<source_sha>` into a private local temporary directory.
5. Verify byte identity and provenance for the canonical source ZIP, metadata, and AMO-signed XPI, including add-on ID, version, update URL, stock-Firefox signed state, and build provenance.
6. Publish exactly that tag and those three assets, then read back immutable post-state.
7. Run `gh release verify` and verify the asset digests again.

Actions never creates, drafts, edits, or publishes a GitHub Release. Administrator authority remains only in the local `gh` process. The workflow separates the AMO-secret signing job from secret-free verification and attestation jobs.

## Internal deployment

The normal route is `ssh server` through the router. `deploy` verifies the immutable Release and attestations locally, downloads the three assets to a private temporary directory, and bundles the exact protected activator, its full import graph, and `jszip` into one self-contained ESM file. It sends that file and the assets as a unique, bounded SCP bundle. The server needs no checkout, `node_modules`, or GitHub token.

Hidden activation enforces:

- fixed target `/srv/admin/chzzk-updates` and expected owner/mode;
- rejection of symlink ancestors, foreign ownership, and group/world-writable managed paths;
- a process-bound lock and fsynced rollback journal;
- an immutable version directory followed by atomic `current` and stable-link changes;
- backend and Caddy readback of version, MIME, JSON, links, and SHA-256;
- restoration of the previous links after activation failure or interruption.

After activation, the local operator verifies `updates.json` and the XPI again through PowerShell HTTPS. A `curl.exe` timeout alone is not authoritative because the router gate may reject its traffic.

`rollback <version>` verifies the immutable Release and server generation, then uses the same lock, journal, link switch, and readback. Never delete prior release directories automatically; they support rollback and old-signed-to-new-signed update testing.

## Disposable Firefox gate

Download and verify the previous signed XPI, new release metadata, and new signed XPI. Run update mode on the Windows PC with Firefox ESR, production DNS/TLS, and a new disposable profile.

The persisted Firefox distribution policy must lock `network.trr.excluded-domains` with `home.arpa`, preserving existing public-name DoH behavior while routing internal RFC 8375 names through native DNS. The checked-in Windows wrapper verifies the effective value and lock state. A changed distribution policy requires a full Firefox restart before an existing user profile sees it.

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File .\scripts\firefox-signed-smoke.windows.ps1 `
  -NodeBinary "<absolute-node.exe>" `
  -FirefoxBinary "<absolute-firefox.exe>" `
  -GeckodriverBinary "<absolute-geckodriver.exe>" `
  -ReleaseMetadata "<absolute-chzzk-YY.M.D-release-metadata.json>" `
  -SignedXpi "<absolute-chzzk-YY.M.D-signed.xpi>" `
  -OldSignedXpi "<absolute-previous-signed.xpi>" `
  -ResultPath "<new-private-result.json>"
```

The result must report the exact Firefox and extension versions, `permanent-signed-active`, and final `none-found`. Remove only inputs, results, profiles, and processes created by the task. Never open the user's profile.

## Repository settings

Keep exactly four workflows: CI, CodeQL, Dependency review, and Build signed Firefox release. Protected `main` requires strict checks `verify`, `firefox-e2e`, `dependency-review`, and `analyze`, native PRs, administrator enforcement, and conversation resolution. Only squash merge is allowed; default Actions permission is read-only.

The external Codex GitHub App remains connected for the user's web integration, but its review is advisory and is not a required check, approval, or merge gate. Inspect, answer, and resolve any conversation it creates. Do not add comment-triggered review, bot approval, or a custom review workflow.

## Failure boundaries

- If internal `ssh server` fails, read back PC-to-router and router-to-server routing, DNS, VPN, keys, and client configuration first.
- A public-SSH timeout is not a deployment blocker while the internal route works.
- OCI is break-glass only when both normal PC and router server-SSH paths fail. Automated `status`, `release`, `deploy`, and `rollback` never access OCI.
- If AMO, GitHub, SCP, activation, or readback is incomplete, do not report success. Leave a bounded, exact state that can be resumed safely.

## Responding to CHZZK changes

When a NAVER change breaks playback, add a fixture that reproduces the defect using redacted data, then run:

```bash
npm run diagnostics:analyze -- diagnostics.json
npm run verify
```

Never place query strings, fragments, cookies, headers, account/session identifiers, keys, UUIDs, or complete signed media URLs in issues, PRs, fixtures, or logs.
