# Webview hidden-state recovery and traffic

- [x] Reproduce hidden-page sequence recovery and latched RAF with focused regression tests.
- [x] Gate sequence-stall checks on visible, healthy render state; preserve immediate explicit-unhealthy recovery.
- [x] Report document visibility with generation checks and suppress host full-state posts while hidden.
- [x] Resume one latest-state render on visibility return; reset progress per document without resetting global sequence.
- [x] Coalesce normal state posts using `uiBatchMs` and a tested 200 ms minimum interval; expose bounded traffic counters.
- [x] Keep recovery evidence tied to the failed document generation in copied and persisted diagnostics.
- [x] Run focused tests serially, `npm run build`, Panel Webview script health, VM script gate, and package `0.5.207`.
- [x] Install `0.5.207` after code and test completion; verified VS Code reports `simple-local.simple-experiment@0.5.207` and `simpleex --help` resolves.
- [ ] After the active experiment is safe and the user reloads the window, run `simpleex api panel.diagnostics` and verify hidden-page stability, latest-state resume, full-state rate, and visible-renderer recovery. Do not operate the current panel or restart Workers before then.
