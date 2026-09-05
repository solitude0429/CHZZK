# Firefox signing and immutable Releases

<!-- contract:review exact-head-comment=required external-app=advisory merge=manual-squash auto-merge=disabled -->
<!-- contract:release actions-publish=false local-release-verify=required server-credentials=forbidden rollback-journal=required -->

Firefox Release/Beta requires Mozilla signing for a normally installed extension. CHZZK uses AMO's unlisted channel. Mozilla signing authorizes Firefox installation; it is not NAVER approval or endorsement.

## Trust boundary

- The GitHub operator must be the exact `RELEASE_OPERATOR_LOGIN` authenticated in this PC's `gh` keyring.
- Before every mutation, the operator reads back the repository ID, exact protected remote `main` head, and UTC `YY.M.D` version.
- Never pass GitHub administrator authority or a raw token to Actions, artifacts, argv, environment variables, checkouts, logs, or the server.
- `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` must exist as a complete pair only in Repository Actions secrets or the protected `firefox-signing` environment. A partial pair, conflicting scopes, or an unprotected environment fails closed.
- Repository immutable Releases must be enabled. Never overwrite a tag or asset, and never use `--clobber`.

## Operator commands

For an explicitly approved credential replacement, use the separate local
`scripts/Set-AmoCredentials.windows.ps1` prompt after closing unrestricted Codex
sessions. Enter only credentials issued by Mozilla. The default mode performs
an authenticated read-only check of this add-on's unlisted versions; `-Apply`
then sends the pair through stdin to the existing GitHub Actions secret store.
It does not read `.env`, print credentials, create a Release, or revoke old keys.
Do not start signing concurrently: GitHub stores the two entries separately.
A partial update is incomplete, and successful storage still requires separate
signing verification and Mozilla revocation readback. `.env.example` contains
only dummy documentation values and is excluded from the extension package.

Normal product changes use `ship`, which includes signing and publication. Use `release` directly only to resume or recover publication of a canonical version already merged into protected `main`.

```powershell
npm run chzzk -- status --json
npm run chzzk -- release --json
```

`status` is read-only. `release` treats an exact completed source and asset set as an idempotent no-op, and may resume only an in-progress run for the same source SHA or a compatible draft. A foreign source under the same tag, duplicate run, unexpected asset, or incomplete secret policy stops before mutation.

## Actions signing stages

`Build signed Firefox release` accepts only `workflow_dispatch` on protected `main`, with three required string inputs:

- `source_sha`
- `version`
- `nonce`

The run title is `Release assets <nonce>`. The local operator binds one exact workflow ID, source SHA, version, nonce, and run ID; it never reuses another run.

The workflow separates these trust stages:

1. Verify the exact protected source and canonical version.
2. In a read-only checkout, run `npm ci`, the complete `npm run verify`, and deterministic source-ZIP and release-metadata builds.
3. In a secret job with no checkout or npm, sign the unlisted XPI through the dependency-free AMO client.
4. In a secret-free job, verify XPI structure and runtime bytes, permanently install it in checksum-pinned stock Firefox with default signature enforcement, and require `SIGNEDSTATE_SIGNED`.
5. Generate GitHub build provenance for the source ZIP, metadata, and signed XPI.
6. Emit exactly those three canonical files in the `chzzk-release-assets-<source_sha>` run artifact.

The workflow does not create, draft, edit, or publish a GitHub Release and has no `contents: write` administrator role. Keep only CI, CodeQL, Dependency review, and this signing workflow.

## Local publication

After the workflow succeeds, the local `release` operator:

1. Downloads the exact run artifact to a private temporary directory.
2. Requires exactly these filenames:

   - `chzzk-<version>.zip`
   - `chzzk-<version>-release-metadata.json`
   - `chzzk-<version>-signed.xpi`

3. Verifies metadata repository/SHA/version, deterministic ZIP bytes, XPI add-on ID, update URL, minimum Firefox, signed state, and provenance for every asset.
4. Immediately before publication, re-reads operator identity, protected `main`, tag, Release, and immutable-release settings.
5. Publishes the exact tag and bytes and requires immutable post-state.
6. Runs `gh release verify "v<version>" --repo solitude0429/CHZZK` and reads back all three digests.

Temporary artifacts and evidence are bounded. On success or failure, remove only paths created by the task. If source ZIP, metadata, or signed-XPI bytes differ at any point, report the cause instead of retrying under a new tag.

## Daily UTC Release rule

Use the UTC date without zero padding as `YY.M.D`, with one immutable Release per day. If that UTC date already has a Release, do not bump, merge, or sign another product change. Hold all such changes in one `ship-pending` PR; the next mutating product request after the date changes resumes it with the new date version.

## Protected PR review

Every `main` change uses a native PR and exact-head checks `verify`, `firefox-e2e`, `dependency-review`, and `analyze`. After the final source push, the operating agent reviews the final diff and the PR body's high-risk impacts, then records an exact-head COMMENT review through `gh` that identifies the current head SHA. Any later source push requires all checks and another COMMENT review.

An external Codex GitHub App, comment-triggered review, approval bot, or custom review workflow is not required. The sole-owner repository keeps zero required approvals, while unresolved conversations must remain at zero. Merge is a manual squash after fresh base/head readback; GitHub auto-merge stays disabled.

## After publication

Only an immutable Release that passes `gh release verify` may be deployed to the internal update host described in `docs/UPDATES.md`. After deployment, run the disposable stock-Firefox update gate from the previous AMO-signed XPI to the new signed XPI.
