## Hardening checklist

- [ ] Redirect/session-rule behavior stays scoped to trusted CHZZK live HLS requests.
- [ ] No external telemetry endpoint is added to packaged runtime.
- [ ] No new host permission is added without explicit review.
- [ ] No Firefox data-collection consent surface is introduced unintentionally.
- [ ] Diagnostics do not store signed query/hash values.
- [ ] `npm run verify` passes.
- [ ] Generated runtime files are refreshed before manual distribution.
- [ ] The final source push is complete, the PR body and every high-risk impact note are finalized, and the PR is marked Ready before the final direct Codex review.
- [ ] The final direct Codex review inspected the current 40-character head SHA, and no source push occurred afterward.
- [ ] Every actionable review thread is resolved, and all four protected checks were rerun after the last source push.
- [ ] High-risk release, permissions, deployment, or security-policy changes are identified explicitly in the PR body.
