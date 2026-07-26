## Hardening checklist

- [ ] Redirect/session-rule behavior stays scoped to trusted CHZZK live HLS requests.
- [ ] No external telemetry endpoint is added to packaged runtime.
- [ ] No new host permission is added without explicit review.
- [ ] No Firefox data-collection consent surface is introduced unintentionally.
- [ ] Diagnostics do not store signed query/hash values.
- [ ] `npm run verify` passes.
- [ ] Generated runtime files are refreshed before manual distribution.
- [ ] I reviewed the final diff directly; no separate bot-review round is required.
- [ ] Every actionable review thread is resolved, and checks were rerun after the last push.
- [ ] High-risk release, permissions, deployment, or security-policy changes are identified explicitly in the PR body.
