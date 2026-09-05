# Patched image-size buffer API

This private development dependency replaces `web-ext -> addons-linter -> image-size`
through the root npm override. It is excluded from extension and release packages
with the rest of `scripts/`. Mozilla's linter consumes only the buffer API;
the unused filesystem and CLI entry points are not included.

The code and MIT license come from the published `image-size@2.0.2` package.
The original `dist/index.cjs` SHA-256 is recorded below. The published version
is the baseline, not a claim that the publisher released this local patch.

```text
aeb11b9ec9d0d670c40d66dcb4fc7032aa32722499f6740b715e21a20eab1b62
```

Local changes normalize ISO BMFF zero-sized boxes to the remaining input length
so HEIF and JXL loops always advance, reject undersized box headers, and reject
zero, undersized, truncated, or out-of-bounds ICNS entries. These address
[CVE-2025-71329](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) and
[CVE-2025-71330](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr).

`tests/unit/image-size-security.test.js` exercises the dependency resolved by
Mozilla's linter in bounded child processes, including valid inputs. Keep these
tests when replacing the local dependency with a maintained published release.
