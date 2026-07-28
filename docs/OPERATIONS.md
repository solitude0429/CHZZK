# CHZZK Operations Runbook

## Release checklist

1. Start from a clean branch based on the exact remote `main`.
2. Choose one canonical SemVer change and update `package.json`, `package-lock.json`, `manifest.json`, and the `RELEASE_VERSION` constant in `scripts/lib/release-finalize-state.js` together.
3. Run the complete local gate:

```bash
npm ci
npm run verify
npm run setup:firefox-e2e
FIREFOX_BINARY="$PWD/dist/e2e-tools/firefox/firefox" \
GECKODRIVER_BINARY="$PWD/dist/e2e-tools/geckodriver" \
npm run test:firefox-functional-e2e
```

4. Open a draft PR. The protected branch requires the four GitHub-Actions-bound checks `verify`, `firefox-e2e`, `dependency-review`, and `analyze` (CodeQL), plus zero unresolved review threads.
5. Finalize the PR body and every high-risk release, permissions, deployment, or security-policy note after the last source push. Then mark the PR ready for review and request the final direct Codex review:

```text
@codex review
```

Wait for the resulting review record and confirm that its reviewed commit is the current full PR head SHA. Resolve every actionable finding. Any source push after that review requires all four checks and a new final direct Codex review on the Ready PR. Immediately before the authorized squash merge, the acting operator confirms that the reviewed commit still equals the PR head, the finalized high-risk notes remain unchanged, the base is current, all four protected checks pass, and GitHub reports zero unresolved conversations. A self-approval, approval-count gate, custom bot-review workflow, or commit-scoped review-completion status is not used for this sole-owner repository.

6. The owner or an operating agent explicitly authorized by the owner squash-merges through protected `main` only after step 5 is complete. An owner instruction to finish or merge the scoped task is sufficient authorization, so the agent does not request a second merge confirmation after the gates pass. GitHub auto-merge and unattended generic merge automation must not be enabled or used.

7. Refresh the external operator bootstrap from the protected exact `main` blob as described in `docs/SIGNING.md`.

8. From the clean exact-`main` checkout, run the fully sanitized, bounded `release` command in `docs/SIGNING.md` once. Do not replace it with a checkout script, npm command, or ambient `gh workflow run`.

9. Require the administrator preflight → nonce-bound dispatch/wait → authorize → prepare → sign → signed-XPI verification → stock-Firefox install → attest → draft stage → fresh administrator preflight → immutable publication chain. Do not waive a missing artifact or smoke.
10. Confirm the published Release is immutable and contains exactly the source ZIP, release metadata, and signed XPI:

```bash
gh release verify "v$VERSION" --repo solitude0429/CHZZK
```

11. Refresh `scripts/internal-update-deploy-bootstrap.js` from the protected exact `main` blob using the same Git-blob verification procedure as the release bootstrap, and install it outside the checkout as an owner-only mode `0500` `.mjs` file. From an already-running trusted administrator shell and the exact clean `main` checkout, deploy the immutable release only through that external bootstrap:

```bash
(
  if [ -n "${GITHUB_ACTIONS-}" ]; then exit 1; fi
  trap - DEBUG 2>/dev/null || true
  set +x
  set +v
  chzzk_deploy_token="$CHZZK_DEPLOY_READ_TOKEN"
  unset ALL_PROXY BASH_ENV CDPATH CHZZK_DEPLOY_READ_TOKEN CURL_CA_BUNDLE ENV \
    GH_ENTERPRISE_TOKEN GH_TOKEN GITHUB_ENTERPRISE_TOKEN GITHUB_TOKEN GLOBIGNORE HOME \
    HTTPS_PROXY HTTP_PROXY LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD \
    NODE_EXTRA_CA_CERTS NODE_OPTIONS NODE_PATH NO_PROXY PS4 \
    REQUESTS_CA_BUNDLE SSL_CERT_DIR SSL_CERT_FILE XDG_CONFIG_HOME \
    all_proxy http_proxy https_proxy no_proxy
  export -n BASHOPTS SHELLOPTS 2>/dev/null || true
  printf '%s\n' "$chzzk_deploy_token" |
    /usr/bin/env -i CHZZK_UPDATE_DEPLOY_PARENT_BOUNDARY=1 \
      LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin \
      "/absolute/protected/chzzk-internal-update-deploy-bootstrap.mjs" \
      "<canonical published version>" \
      "solitude0429/CHZZK" \
      "$PWD" \
      "/var/www/chzzk-updates"
  chzzk_deploy_status=$?
  unset chzzk_deploy_token
  exit "$chzzk_deploy_status"
)
```

The trusted parent shell disables command/input tracing before copying the token, then removes dynamic-loader, shell-startup, Node, proxy, and CA injection variables before starting even `/usr/bin/env`; do not replace that boundary with a one-line `GH_TOKEN=...` invocation. The bootstrap then requires the clean-parent marker and token on stdin, starts absolute system Node under a second empty environment, and requires the supplied checkout to equal trusted Git's canonical worktree root with the pinned repository origin. Only then does it verify that its own canonical `.mjs` path is outside that complete checkout, operator-owned with exact mode `0500`, and contained by a private operator-owned directory. It discovers only protected absolute system tools, creates a private GitHub CLI home, binds the canonical repository, clean checkout, and release to the protected remote head, Git-blob-verifies the deployment entrypoint and its complete local import graph, and executes those sealed bytes. It owns the artifact-download directory under its private execution tree so terminal child failure is cleaned by the parent. The checkout-local deployment entrypoint and an npm script are not public operational interfaces.

Both the deployment and repository-settings polyglot bootstraps require protected root-owned `/usr/bin/node` as an explicit host prerequisite. Their shell launchers never search `PATH` or claim support for alternate Node locations.

12. Verify live `updates.json` and XPI MIME type, SHA-256, version, add-on ID, minimum Firefox version, source commit, and stable symlink targets.
13. Run the old-signed-to-new-signed stock-Firefox update smoke from `docs/TESTING.md`.
14. From the actual current Windows client, run the checked-in `scripts/firefox-signed-smoke.windows.ps1` command in `docs/TESTING.md` through its installed Firefox ESR, normal DNS, and production TLS path. Require the bounded result to report the Firefox and extension versions, `permanent-signed-active`, and final `none-found`; transfer it to protected release evidence and remove every task-created Windows input, result, profile, and process. Do not ask the user to perform this gate, stop their Firefox, or overwrite an installed profile XPI.

## Repository settings

Repository protection is managed out of band so a pull-request workflow cannot weaken its own controls. The source of truth requires a native pull request for every `main` change with zero required approvals, keeps only squash merge, disables GitHub auto-merge, deletes merged branches, restricts Actions to GitHub-owned actions, grants workflows read-only permissions by default, requires the four source-bound deterministic checks `analyze`, `dependency-review`, `firefox-e2e`, and `verify`, enforces protection for administrators, and requires resolved conversations without a self-approval rule. The final direct Codex review is the single qualitative layer: its review record must name the current PR head after the body and high-risk notes are final and the PR is Ready, any later source push requires a new review, and the acting owner or explicitly authorized operating agent verifies that identity immediately before the squash merge. No custom review-completion workflow or required status represents that procedural review because GitHub check runs are commit-scoped, can be reused by another PR with the same commit, and can only react asynchronously to PR or comment metadata changes. Native pull-request and required-conversation protection remain independent merge gates. Do not replace these controls with an unbound status context, duplicate bot review, approval-count gate, GitHub auto-merge, or unattended generic merge automation.

Refresh `scripts/repository-settings-bootstrap.js` from the protected exact `main` blob, verify its Git-blob identity, and install it outside the checkout at one recorded canonical absolute `.mjs` path with an owner-only parent and mode `0500`. From an already-running trusted administrator shell, run the value-free dry-run through that exact external bootstrap:

```bash
(
  if [ -n "${GITHUB_ACTIONS-}" ]; then exit 1; fi
  trap - DEBUG 2>/dev/null || true
  set +x
  set +v
  chzzk_settings_token="$CHZZK_REPOSITORY_ADMIN_TOKEN"
  unset ALL_PROXY BASH_ENV CDPATH CHZZK_RELEASE_ADMIN_TOKEN \
    CHZZK_REPOSITORY_ADMIN_TOKEN CURL_CA_BUNDLE ENV GH_ENTERPRISE_TOKEN \
    GH_TOKEN GITHUB_ENTERPRISE_TOKEN GITHUB_TOKEN GLOBIGNORE HOME HTTPS_PROXY \
    HTTP_PROXY LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD NODE_EXTRA_CA_CERTS \
    NODE_OPTIONS NODE_PATH NO_PROXY PS4 REQUESTS_CA_BUNDLE SSL_CERT_DIR \
    SSL_CERT_FILE XDG_CONFIG_HOME all_proxy http_proxy https_proxy no_proxy
  export -n BASHOPTS SHELLOPTS 2>/dev/null || true
  printf '%s\n' "$chzzk_settings_token" |
    /usr/bin/env -i CHZZK_REPOSITORY_SETTINGS_PARENT_BOUNDARY=1 \
      LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin \
      "/absolute/protected/chzzk-repository-settings-bootstrap.mjs" \
      "solitude0429/CHZZK" \
      "$PWD"
  chzzk_settings_status=$?
  unset chzzk_settings_token
  exit "$chzzk_settings_status"
)
```

Append `--apply` only after reviewing the dry-run JSON. The same no-trace trusted-parent boundary applies to this token. The bootstrap pins the canonical repository name and numeric ID, verifies the clean exact protected-head checkout and protected source blob, and executes the sealed configurator with protected absolute tools and a private tool home. Apply is sequential and fail-closed, not atomic: a mid-apply API failure emits a bounded value-free recovery report, and a fresh dry-run is used to converge safely. Before every mutation, any payload-preparation read completes first and the protected-branch head GET is then repeated as the final external read. The checkout configurator and an npm script are not public operational interfaces. Version-only dependency bot PRs are disabled; the operating agent consolidates current tooling updates into one tested maintenance PR while `npm audit`, dependency review, CodeQL, and GitHub vulnerability alerts remain active.

The configurator also inventories only the names and scopes of the two AMO signing secrets. It requires the protected-branch-only `firefox-signing` environment plus one complete credential pair at Repository Actions or environment scope. A complete existing Repository pair remains valid and is not copied or deleted. A complete environment pair is also valid and takes precedence by GitHub's name-resolution rules; a partial pair at either scope, no complete pair, or an incorrect environment policy rejects `--apply` before any mutation. The configurator never reads, writes, migrates, or deletes secret values.

When a workflow is retired, merge its file removal first, disable only that workflow's remaining server-side record where GitHub supports it, and verify the Actions API inventory contains exactly `ci.yml`, `codeql.yml`, `dependency-review.yml`, and `sign-unlisted.yml`. Preserve current release, verification, and provenance run evidence.

## Patch response

When CHZZK/NAVER changes break playback:

1. Export diagnostics JSON from the popup.
2. Confirm it contains no query/hash values, cookies, headers, account/session identifiers, keys, UUIDs, or connection identifiers.
3. Run `npm run diagnostics:analyze -- diagnostics.json`.
4. Add a failing redacted fixture before changing URL-shape handling.
5. Fix the smallest shared policy/runtime boundary.
6. Run `npm run verify` and the Firefox E2E before opening a PR.

## Local diagnostics

- Diagnostics stay in the browser extension's local storage.
- The extension runtime does not send diagnostics to an external collector.
- Local samples are schema-normalized and redacted before storage/export; host labels discard subdomains and ports.
- Manually review any export again before sharing it.

## Incident response

### Unrelated CDN traffic appears in diagnostics

1. Stop sharing the affected export.
2. Add a `shouldRecordDiagnostics` regression.
3. Harden context gates.
4. Run the full verification suite.
5. Add a privacy caveat to the next release note if exposure occurred.

### Playback fails completely

1. Disable the extension to confirm rollback behavior.
2. Check popup `lastDecision`.
3. Record only a redacted DevTools Network URL shape.
4. Add a parser fixture for `unknown-quality-shape`.
5. Expand domains only after proving the request is a CHZZK live playlist.

### A higher quality appears later

1. Run the diagnostics analyzer.
2. If `needsPolicyUpdate` is true, use `--apply`.
3. Review the generated candidate and tests before release.

## Operational boundaries

- Do not reintroduce DOM-selector fake menu labels or a global static DNR ruleset.
- Do not seed a fixed startup quality; resolve the highest actually available playlist per tab.
- Do not validate a release by closing Firefox or overwriting a profile XPI.
- Do not store unrelated CDN traffic or signed media URL query/hash values.
- Do not reintroduce external telemetry without explicit consent and Firefox data-consent UI.
- Do not describe Mozilla unlisted signing as NAVER approval.
