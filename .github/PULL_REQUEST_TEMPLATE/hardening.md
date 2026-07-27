## Hardening checklist

- [ ] Redirect/session-rule behavior stays scoped to trusted CHZZK live HLS requests.
- [ ] No external telemetry endpoint is added to packaged runtime.
- [ ] No new host permission is added without explicit review.
- [ ] No Firefox data-collection consent surface is introduced unintentionally.
- [ ] Diagnostics do not store signed query/hash values.
- [ ] `npm run verify` passes.
- [ ] Generated runtime files are refreshed before manual distribution.
- [ ] This PR remained draft while the final exact-head Codex review was pending.
- [ ] The completed review names the current PR head SHA; no source commit was pushed afterward.
- [ ] Every actionable review thread is resolved, and checks were rerun after the last source push.
- [ ] High-risk release, permissions, deployment, or security-policy changes are identified explicitly in the PR body.
