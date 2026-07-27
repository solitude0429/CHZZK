## Hardening checklist

- [ ] Redirect/session-rule behavior stays scoped to trusted CHZZK live HLS requests.
- [ ] No external telemetry endpoint is added to packaged runtime.
- [ ] No new host permission is added without explicit review.
- [ ] No Firefox data-collection consent surface is introduced unintentionally.
- [ ] Diagnostics do not store signed query/hash values.
- [ ] `npm run verify` passes.
- [ ] Generated runtime files are refreshed before manual distribution.
- [ ] This PR remained draft until the final exact-diff Codex review check succeeded.
- [ ] The PR author created the final unedited review request after the current head entered the PR and named both the full current head SHA and exact base ref/SHA.
- [ ] The repository-owned check recorded the matching request-comment ID and Codex reaction ID/time as durable evidence, and neither the head, base, PR title/body, nor request changed before attestation.
- [ ] Every actionable review thread is resolved. A fresh exact-diff request was submitted after any source, base, PR title/body, or request change; feedback that did not change the diff is handled by the native conversation-resolution gate.
- [ ] High-risk release, permissions, deployment, or security-policy changes are identified explicitly in the PR body before requesting final review.
