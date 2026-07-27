## Hardening checklist

- [ ] Redirect/session-rule behavior stays scoped to trusted CHZZK live HLS requests.
- [ ] No external telemetry endpoint is added to packaged runtime.
- [ ] No new host permission is added without explicit review.
- [ ] No Firefox data-collection consent surface is introduced unintentionally.
- [ ] Diagnostics do not store signed query/hash values.
- [ ] `npm run verify` passes.
- [ ] Generated runtime files are refreshed before manual distribution.
- [ ] This PR remained draft while the final exact-diff Codex review was pending.
- [ ] The final unedited review request was created after the current head entered the PR and names both the full current head SHA and the exact base ref/SHA.
- [ ] Codex reacted to that same request, and neither the head nor base changed afterward.
- [ ] Every actionable review thread is resolved; when review feedback existed, a fresh exact-diff request was submitted after the resolution and final source changes.
- [ ] High-risk release, permissions, deployment, or security-policy changes are identified explicitly in the PR body before requesting final review.
