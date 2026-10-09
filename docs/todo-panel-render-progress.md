# Panel render progress false-positive fix

- [x] Define stall as pending state plus no rendered-sequence progress since the previous heartbeat.
- [x] Track the previous heartbeat render sequence and reset progress state for each new document and disposal.
- [x] Preserve recovery reason and sequence-progress evidence in copied and persisted diagnostics.
- [x] Add healthy-lag, real-stall, recovery-after-progress, ACK integration, and reset regression tests.
- [x] Run the requested Panel tests individually, then build, runtime closure, and Webview `vm.Script` gates.
- [x] Bump the patch version, package, install once, and verify the installed extension entry.
- [x] Review and commit only this batch; push to `origin/master` and verify synchronization.
