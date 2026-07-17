# Firefox compatibility and operational assurance

## Support matrix

| Environment            | Declared minimum            | Verification                                                                                   | Support level                                       |
| ---------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Firefox desktop        | `140.0`                     | AMO-signed permanent-install smoke on minimum/current stock Firefox for Linux x64 and arm64    | Fully gated                                         |
| Firefox Android        | `142.0`                     | Manual release smoke on a disposable test profile/device                                       | Best effort until automated Android coverage exists |
| Production update host | HTTPS immutable release set | Daily schema, MIME, path, size, digest, metadata, source ZIP, and signed-XPI structural canary | Fully monitored                                     |

`policy/compatibility-policy.json` is the source of truth for the desktop minimum, Android
minimum, checksum-pinned stock-Firefox profiles, and geckodriver artifacts. `npm run
validate:compatibility` fails when the manifest and this policy drift.

## Signed desktop compatibility gate

The `Signed Firefox compatibility` workflow accepts an exact staged draft or published release and
runs the production signed-install smoke across four combinations:

- `minimum` stock Firefox on Linux x64;
- `current` stock Firefox on Linux x64;
- `minimum` stock Firefox on Linux arm64;
- `current` stock Firefox on Linux arm64.

Both browser profiles and both architectures use new disposable profiles, preserve Firefox's
default signature enforcement, and require the AMO-signed XPI to install permanently with the exact
add-on ID, version, update URL, and signed state. The workflow also checks that the runner's actual
Node architecture matches the selected policy record. Draft and immutable release assets must pass
provenance verification against the exact source digest and `sign-unlisted.yml`.

After the signing workflow has staged a draft, manually dispatch `Signed Firefox compatibility`
with the draft tag before running the out-of-band finalizer. A published release triggers the same
workflow again, and a weekly schedule rechecks the latest immutable release. Pull requests that
change this compatibility or signed-release harness run it against the latest published release;
legacy non-immutable releases are accepted only for that read-only harness regression check.

CI separately runs the full repository verification twice for pull requests: once on the exact PR
head and once on GitHub's effective pull-request event tree. The Firefox functional E2E remains on
the effective event tree.

## Firefox profile freshness

`npm run check:firefox-compatibility-freshness` compares the policy with Mozilla's official
`firefox_versions.json` response. It requires the pinned `current` profile to equal Mozilla's latest
stable Firefox release and requires the declared desktop minimum to remain in the active ESR major.
The dedicated workflow runs daily and on relevant pull requests from the exact source tree.

A new stable Firefox release intentionally makes this check fail until both x64 and arm64 archives
are checksum-pinned and the signed compatibility matrix passes. The official next-release date is
reported for maintenance planning but does not weaken the exact-version requirement.

## Android release smoke

Android remains an explicit manual gate. For each user-facing release:

1. Use Firefox Android `142.0` or the oldest practically available supported build on a disposable
   test profile or device.
2. Install the final AMO-signed XPI through the supported add-on installation path.
3. Open a CHZZK live page, begin playback, and confirm a lower numeric playlist can resolve to the
   highest available quality without changing the signed query or fragment.
4. Confirm the diagnostics popup remains bounded and redacted.
5. Record the Firefox version, Android version, device architecture, release tag, and outcome in
   the release notes or release checklist.

A skipped Android smoke must be stated as a release exception; it must not be silently treated as
fully tested support.

## Production update canary

`npm run check:live-update` downloads all four hosted production objects without following
redirects:

- `updates.json`;
- canonical release metadata;
- the deterministic source ZIP;
- the advertised AMO-signed XPI.

It enforces bounded nonempty bodies and expected MIME types, decodes JSON as strict UTF-8, checks
the exact update/metadata schema and canonical versioned paths, validates the source ZIP against
release metadata, checks the advertised signed-XPI SHA-256, and runs the same strict structural
source/XPI verifier used by the release pipeline. The scheduled workflow and relevant pull
requests execute the real external check.

## Repository-settings audit

Repository files cannot prove that GitHub's server-side branch protection is still applied. Before
a release and after any repository-administration change, create a dedicated fine-grained token
restricted to this repository with read-only access sufficient for Administration, Actions,
Issues, and metadata inspection. Do not reuse the release administrator token, a generic
`GH_TOKEN`, or a write-capable credential.

Run the Actions-external audit with only that dedicated token:

```bash
unset CHZZK_RELEASE_ADMIN_TOKEN GH_TOKEN GITHUB_TOKEN \
  GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
CHZZK_REVIEW_GATE_AUDIT_TOKEN="<dedicated-read-only-token>" \
CHZZK_GITHUB_REPOSITORY="solitude0429/CHZZK" \
CHZZK_AUTOMATED_REVIEW_LOGIN="<exact-reviewer-login>" \
CHZZK_RELEASE_OPERATOR_LOGIN="<exact-operator-login>" \
npm run audit:review-gate-settings
```

The wrapper refuses ambient GitHub or release credentials, resolves a root-owned non-writable
system `gh`, creates a private temporary GitHub CLI home, passes only the dedicated token and
required identities to the dry-run inspector, and removes the temporary state afterward. It fails
when required variables, labels, source-bound status checks, conversation resolution, or
administrator enforcement have drifted. It intentionally refuses to run in GitHub Actions.

## Independent review boundary

Automated review, CodeQL, fuzzing, and signed-browser tests are necessary but do not provide an
independent human trust boundary. Changes to signing, finalization, release verification,
permissions, update deployment, or review-gate policy should receive review by a person other than
the author. When that is unavailable, the PR and release record must state the exception and its
reason explicitly.
