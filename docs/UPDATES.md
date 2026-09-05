# Firefox automatic updates

<!-- contract:release actions-publish=false local-release-verify=required server-credentials=forbidden rollback-journal=required -->

CHZZK distributes its Mozilla-signed unlisted XPI from a private HTTPS update host. Firefox reads `updates.json` from the fixed `update_url` in `manifest.json`:

```text
https://chzzk.home.arpa:8443/updates.json
```

## Latest verified deployment

Verified on **2026-09-05 UTC**. This is a dated deployment result; use
`npm run chzzk -- status --json` to refresh live state before another operation.

| Field                          | Verified result                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Immutable Release              | [v26.9.6](https://github.com/solitude0429/CHZZK/releases/tag/v26.9.6)                                  |
| Source                         | `c1ce6e8d8be7edb2f18462da9ca20ed30750e19f` ([PR #112](https://github.com/solitude0429/CHZZK/pull/112)) |
| Signed XPI SHA-256             | `23efd2f672a583408a5f73b61f5bb0d470630bae16315e4ab9c0bda6acd8321f`                                     |
| Production manifest / XPI MIME | `application/json` / `application/x-xpinstall`                                                         |
| Windows Firefox ESR            | `140.15.0`                                                                                             |
| Disposable-profile update      | `26.9.5` to `26.9.6`, `permanent-signed-active`, final `none-found`                                    |

The release fixes deletion ordering when diagnostics writes occur between clear
requests. All four required PR checks passed, including three functional Firefox
E2E runs; the signing workflow verified the signed XPI in stock Firefox before
publication. Version `26.9.6` used the [one-time early-release exception](OPERATIONS.md#one-release-per-utc-day).

The first Windows post-deployment smoke failed with `active=false`,
`appDisabled=false`, and `userDisabled=false`. A fresh disposable-profile run of
`deploy 26.9.6` passed using the same immutable assets and active server generation.
The first failure's cause remains undetermined; the successful retry is not a
root-cause fix. The user's installed Firefox profile was not changed or verified.

## From Release to update host

1. The local operator uses the `gh` keyring to verify the exact protected `main` and immutable Release.
2. `gh release verify` and canonical metadata bind the tag, source SHA, three assets, and build provenance.
3. The operator downloads assets into a private local temporary directory and bundles the activator's complete import graph plus `jszip` into one self-contained ESM file. It creates a uniquely named SCP deployment bundle.
4. The bundle travels through internal `ssh server` via the router and runs hidden transactional activation. No GitHub credential is sent to the server.
5. The operator reads back the version, MIME types, JSON, links, and SHA-256 from the server filesystem, loopback backend, Caddy, and PC production HTTPS path.
6. On the real Windows PC, a disposable Firefox profile updates from the previous signed XPI to the new signed XPI through the fixed `update_url`.

For a normal product change, `ship` performs the entire sequence. To deploy an already published immutable Release:

```powershell
npm run chzzk -- deploy [version] --json
```

Without `version`, the operator selects the current canonical immutable Release. If the exact generation and stable links are already active, deployment completes as an idempotent no-op.

## Deployment layout

Each version occupies an immutable directory:

```text
<target>/
  releases/
    <version>/
      chzzk-<version>-signed.xpi
      chzzk-<version>-release-metadata.json
      chzzk-<version>.zip
      updates.json
      index.html
      provenance.json
  current -> releases/<version>
  updates.json -> current/updates.json
  index.html -> current/index.html
  provenance.json -> current/provenance.json
```

`updates.json` and landing-page links use root-absolute immutable version paths. The activator changes `current` and all stable links atomically under the rollback journal, so the manifest and XPI cannot point to different generations.

## Local verification and transfer

Before any write, `deploy` requires:

- the authenticated `gh` identity and pinned repository ID;
- the exact tag's source commit to match release metadata;
- `isImmutable: true` on the published Release;
- exactly three canonical assets with valid GitHub build provenance;
- signed-XPI structure, add-on ID, version, update URL, minimum Firefox, and signed state;
- a private temporary directory, bounded sizes, and exact SHA-256 values;
- a self-contained bundled activator with no bare imports and exactly three assets;
- SSH alias exactly `server` and remote target exactly `/srv/admin/chzzk-updates`.

Transfer filenames contain an unpredictable nonce and never overwrite an existing remote path. After success or failure, remove only the exact staging path created by that operation. The server executes only the bundled activator and needs no CHZZK checkout, `node_modules`, `gh` login, or GitHub token.

## Server activation

The hidden server-side operation verifies bundle metadata and artifacts again, then enforces:

- rejection of symlink ancestors, foreign ownership, and group/world-writable managed paths;
- fixed `admin` ownership and target boundary;
- a process-bound advisory lock with bounded wait;
- a private fsynced rollback journal before mutation;
- fsync of file data and parent directories;
- completion of a new immutable release directory before stable-link changes;
- exact `updates.json`, XPI MIME/hash, and link readback from the backend and Caddy;
- restoration of the previous link snapshot after post-activation failure;
- recovery of an incomplete journal after SIGKILL or reboot before retry.

Never delete server release directories automatically. Previous generations are required for explicit rollback and old-to-new signed Firefox update verification.

## PC production-path readback

Allowed direct PC traffic uses Windows QoS DSCP 3 policy. Firefox and PowerShell are permitted, while the router gate may time out `curl.exe`; use PowerShell HTTPS as authority.

```powershell
$manifest = Invoke-WebRequest `
  -Uri "https://chzzk.home.arpa:8443/updates.json" `
  -UseBasicParsing `
  -TimeoutSec 15
$manifest.StatusCode
$manifest.Headers["Content-Type"]
$manifest.Content | ConvertFrom-Json
```

Compare the response to the exact Release:

- `updates.json` is HTTP 200 with JSON MIME and canonical schema;
- version, add-on ID, minimum Firefox, and immutable update link match;
- the XPI is HTTP 200 with `application/x-xpinstall` MIME, expected size, and SHA-256;
- `current`, `updates.json`, `index.html`, and `provenance.json` link targets match;
- metadata repository/SHA and provenance asset digests match;
- every local landing-page link is valid.

## Disposable Firefox update gate

Update mode uses the production `update_url` already embedded in the previous signed XPI. It accepts no base-URL override and never lowers signature or update trust preferences.

```bash
CHZZK_OLD_SIGNED_XPI="/absolute/path/to/previous-signed.xpi" \
CHZZK_RELEASE_METADATA="/absolute/path/to/chzzk-<version>-release-metadata.json" \
CHZZK_SIGNED_SMOKE_MODE=update \
CHZZK_SIGNED_XPI="/absolute/path/to/chzzk-<version>-signed.xpi" \
FIREFOX_BINARY="/absolute/path/to/firefox" \
GECKODRIVER_BINARY="/absolute/path/to/geckodriver" \
npm run test:firefox-signed-smoke
```

The production gate uses the checked-in Windows wrapper and requires exact `permanent-signed-active` plus final `none-found`. It creates a fresh disposable profile and removes only task-created inputs, results, processes, and profiles. Never read the user's installed profile, cookies, identifiers, or complete signed media URLs.

## Rollback

Run rollback only after the user explicitly names the target version and requests it:

```powershell
npm run chzzk -- rollback <version> --json
```

The operator verifies target GitHub Release and server-generation metadata, provenance, and digests. It uses the same lock, rollback journal, atomic stable-link switch, and readback as a deployment. If the generation is absent or its bytes differ, fail closed instead of using a manual symlink command.

## Network failures

The normal path is PC to router to server over internal WireGuard/SSH and HTTPS. If it fails, inspect DNS, routes, VPN, keys, and SSH from both PC and router first. A public-SSH timeout is not a blocker while the internal path works. Automated deployment and rollback never access OCI; OCI requires separate approval and is reserved for emergencies where both normal server-SSH paths are unavailable.
