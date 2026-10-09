# Plan startup latency work

- [x] Read project constraints and capture the dirty worktree; preserve both user-modified `.pyc` files.
- [x] Decouple durable queue acknowledgement from task launch and wake one processor per Worker without lost wakeups.
- [x] Persist Worker code-sync proofs, validate compact dispatches with stat checks, and retain the legacy manifest path.
- [x] Make request inactivity timeout honor the actual request option and record validate submit, terminal wait, and Agent durations.
- [x] Add regression coverage for acceptance, wakeup, proof validation, compact payloads, warm sync, and timeout behavior.
- [x] Run scoped tests serially, rebuild and repackage after the final timing change, pass the VM script gate, and pass `git diff --check`. The Worker telemetry contract file has one unrelated `getResultsSummary` rejection expectation failure; its capability/action tests pass.
- [x] Review the scoped diff, preserve user-owned `.pyc` changes, and verify `master` is even with `origin/master` before publishing.
- [ ] Defer Agent deployment, plugin installation, and window reload until `experiments/plans/comparison/drf.yaml` is finished; then collect real before/after timings.
