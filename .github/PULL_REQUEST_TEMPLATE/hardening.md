## Hardening checklist

- [ ] Redirect/session-rule behavior stays scoped to trusted CHZZK live HLS requests.
- [ ] No external telemetry endpoint is added to packaged runtime.
- [ ] No new host permission is added without explicit review.
- [ ] No Firefox data-collection consent surface is introduced unintentionally.
- [ ] Diagnostics do not store signed query/hash values.
- [ ] `npm run verify` passes.
- [ ] Generated runtime files are refreshed before manual distribution.
- [ ] The PR body and every high-risk impact note were finalized before the final review request.
- [ ] One unedited author comment requests Codex review and names the exact current 40-character head and base SHAs.
- [ ] No source push, base change, PR reopen, PR metadata edit, or request edit/deletion occurred after that request.
- [ ] The source-bound `exact-head-review` check succeeds for the current head/base pair.
- [ ] Every actionable review thread is resolved, and checks were rerun after the last source push.
- [ ] High-risk release, permissions, deployment, or security-policy changes are identified explicitly in the PR body.
