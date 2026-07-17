## Hardening checklist

- [ ] Redirect/session-rule behavior stays scoped to trusted CHZZK live HLS requests.
- [ ] No external telemetry endpoint is added to packaged runtime.
- [ ] No new host permission is added without explicit review.
- [ ] No Firefox data-collection consent surface is introduced unintentionally.
- [ ] Diagnostics do not store signed query/hash values.
- [ ] `npm run verify` passes.
- [ ] Generated runtime files are refreshed before manual distribution.
- [ ] Release/security-sensitive changes have a successful configured automated-review check on this exact head.
- [ ] Every actionable review thread is resolved, and reviews/checks were rerun after the last push.
- [ ] High-risk release, permissions, deployment, or security-policy changes are marked for Pro/manual or Codex review in the PR body.
- [ ] Compatibility-affecting changes passed the minimum/current signed-Firefox gate; Android was checked manually or the support exception is explicit.
- [ ] Release/supply-chain changes received independent human review, or the exception and rationale are recorded explicitly.
