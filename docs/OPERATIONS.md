# CHZZK Operations Runbook

## Release checklist

1. Start from a clean branch based on the exact remote `main`.
2. Choose one canonical SemVer change and update `package.json`, `package-lock.json`, and `manifest.json` together.
3. Run the complete local gate:

```bash
npm ci
npm run verify
npm run setup:firefox-e2e
FIREFOX_BINARY="$PWD/dist/e2e-tools/firefox/firefox" \
GECKODRIVER_BINARY="$PWD/dist/e2e-tools/geckodriver" \
npm run test:firefox-functional-e2e
```

4. Open a draft PR. The protected branch requires the five GitHub-Actions-bound checks `verify`, `firefox-e2e`, `dependency-review`, `analyze` (CodeQL), and `exact-head-review`, plus zero unresolved review threads.
5. After the last source push, keep the PR draft and record every high-risk release, permissions, deployment, or security-policy impact in the PR body. Resolve all known actionable threads, refresh the remote base, and then have the PR author create one new, unedited top-level comment in this exact form:

```text
@codex review

head: `<full current PR head SHA>`
base: `main@<full current base SHA>`
```

The request must be created after the named head entered the PR. While the PR remains draft, the trusted-base workflow polls only that immutable author comment. A successful Codex thumbs-up is converted into a repository-owned check attestation that records the request-comment ID, reaction ID/time, exact head, and exact base. The check is the durable completion evidence; later disappearance of the transient reaction does not erase an already verified attestation. Do not edit or delete the request. A later source push or force-push, base retarget, or PR title/body edit invalidates the request, while protected `main` disallows force-pushes and deletion. If Codex opens actionable threads, no successful attestation is produced: resolve the threads, make any required source changes, and submit a fresh exact-diff request. Feedback arriving after a successful attestation is governed by the native conversation-resolution gate; submit a fresh request whenever that feedback changes the source, base, PR title/body, or review request. Mark the PR ready only after the source-bound `exact-head-review` check succeeds for the current head/base and every conversation is resolved. A self-approval or approval-count gate is not required for this sole-owner repository.

6. Merge through protected `main`.
7. Refresh the external operator bootstrap from the protected exact `main` blob as described in `docs/SIGNING.md`.
8. From the clean exact-`main` checkout, run the fully sanitized, bounded `release` command in `docs/SIGNING.md` once. Do not replace it with a checkout script, npm command, or ambient `gh workflow run`.

9. Require the administrator preflight → nonce-bound dispatch/wait → authorize → prepare → sign → signed-XPI verification → stock-Firefox install → attest → draft stage → fresh administrator preflight → immutable publication chain. Do not waive a missing artifact or smoke.
10. Confirm the published Release is immutable and contains exactly the source ZIP, release metadata, and signed XPI:

```bash
gh release verify "v$VERSION" --repo solitude0429/CHZZK
```

11. Deploy the immutable release to the internal update host from an exact clean `main` checkout:

```bash
VERSION="$(node -p "require('./package.json').version")"
CHZZK_VERSION="$VERSION" \
CHZZK_GITHUB_REPOSITORY="solitude0429/CHZZK" \
npm run deploy:updates:internal
```

12. Verify live `updates.json` and XPI MIME type, SHA-256, version, add-on ID, minimum Firefox version, source commit, and stable symlink targets.
13. Run the old-signed-to-new-signed stock-Firefox update smoke from `docs/TESTING.md`.
14. From the actual current Windows client, run the checked-in `scripts/firefox-signed-smoke.windows.ps1` command in `docs/TESTING.md` through its installed Firefox ESR, normal DNS, and production TLS path. Require the bounded result to report the Firefox and extension versions, `permanent-signed-active`, and final `none-found`; transfer it to protected release evidence and remove every task-created Windows input, result, profile, and process. Do not ask the user to perform this gate, stop their Firefox, or overwrite an installed profile XPI.

## Repository settings

Repository protection is managed out of band so a pull-request workflow cannot weaken its own gate. The source of truth keeps only squash merge, deletes merged branches, disables protected-branch force-pushes and deletion, restricts Actions to GitHub-owned actions, grants workflows read-only permissions by default, requires the five source-bound checks `analyze`, `dependency-review`, `exact-head-review`, `firefox-e2e`, and `verify`, enforces protection for administrators, requires strict up-to-date status checks, and requires resolved conversations without a self-approval rule. The repository-owned `exact-head-review` context accepts only an unedited PR-author request created after the current head entered the PR while the PR remains draft. It binds the exact 40-character head SHA to the current base ref and 40-character base SHA, converts a matching Codex-connector reaction into a durable check attestation, serializes PR-state invalidation against active polling, rejects head/base or PR title/body transitions, and fails closed on incomplete timeline, reaction, or review-thread pagination. Conversation resolution remains a separate native branch-protection requirement. Do not replace this gate with an unbound status context or an approval-count rule.

```bash
CHZZK_GITHUB_REPOSITORY="solitude0429/CHZZK" \
CHZZK_RELEASE_OPERATOR_LOGIN="<exact owner login>" \
npm run configure:repository
```

Add `-- --apply` only from a trusted administrator session after reviewing the dry-run JSON. Version-only dependency bot PRs are disabled; the operating agent consolidates current tooling updates into one tested maintenance PR while `npm audit`, dependency review, CodeQL, and GitHub vulnerability alerts remain active.

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
