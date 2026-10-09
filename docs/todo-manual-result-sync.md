# TODO: one-click verified latest-result synchronization

## Scope and baseline

- Starting HEAD: `b93bc46d9d76b276fe381e6034d1d3fe96e46101`, version `0.5.213`.
- Preserve the two pre-existing dirty runtime `.pyc` files. Do not interrupt the user's ongoing sync, run experiments, or delete remote outputs.
- Live Extension Host and all three Worker probes report `0.5.213`; project is `D:\GitRepo\MultiModal`. nwpu2's configured project root is `/data/qgking/zlk/MultiModal`.
- Current sync reports missing-content verification failures on nwpu2 and a queue write conflict. Mirror/fragment markers still list nwpu2 after the user cleared its work_dirs; these markers are not current filesystem proof.

## Work items

- [x] Capture bounded live transfer/state evidence and inspect latest attempt contents through SimpleSFTP.
- [x] Reproduce first-click behavior at the actual manual postprocess/artifact/queue-write seam before changing it.
- [x] Make one manual request verify and repair stale mirrors, including missing result fragments and unavailable original sources, without restoring old generations.
- [x] Keep concurrent callers on one complete pipeline; preserve real external queue-write conflict protection.
- [x] Remove unsolicited section navigation after action completion; retain explicit navigation controls.
- [x] Show submission/sync failures in a user-facing modal and distinguish ongoing result synchronization from active old-revision training.
- [x] Group compatible files across Plans per source/destination and prefer compressed transfer; do not mix result generations or bypass hash checks.
- [x] Add regressions for empty destinations, source fallback, warm caches, concurrent queue patches and latest-only transfers.
- [x] Run affected tests sequentially, build and Webview syntax gates; review, package and install the scoped batch.
- [x] Report actual nwpu2 run identities/completeness and separate live limitations from code verification.

## Validation

- New manual sync fixture reproduced the old implementation's deleted-mirror, missing-source and scope-upgrade failures before fixing it. Current manual sync 7/7, failure visibility 4/4, queue cache stability 7/7 and auto-scroll 3/3 pass. Submission is blocked before adapter uploads or Worker selection for the whole manual sync/download scope; cancelling a submission does not cancel that scope.
- SimpleSFTP compressed Worker batches 3/3 and stream progress 7/7 pass. The compression fixture actually packs repository files with the production helper and verifies that gunzip produces the same tar stream; this is not a remote throughput measurement.
- 40 actual test files / 353 tests pass sequentially, including result freshness/completeness/tables, distributed startup/rerun/conflicts, Plan active guards, execution/log UI, Panel projection/ACK/backpressure/recovery and transport APIs. A mistyped `test/features/runtimeManifest.test.js` command was corrected to `test/runtimeManifest.test.js`; no test was deleted.
- SimpleSFTP mapped download 16/16 includes a real gzip decoder and truncated-footer rejection before final publication. Result downloads group compatible Plan files per Worker and request compression; old API callers retain the explicit/default uncompressed compatibility mode.
- SimpleExperiment `0.5.214` build, Webview `vm.Script`, 169-module VSIX runtime closure and packaging pass. SimpleSFTP `0.2.46` syntax gates and packaging pass. Both were installed once without force or downgrade; `code --list-extensions` confirms those versions and the `simpleex` entry remains present. Panel/API interaction stopped after installation, pending Developer: Reload Window.
- Repository bases were verified against each configured `origin/master` before scoped publication. Only this batch's source, tests, docs and generated runtime files are eligible to stage; cached `.pyc` files and existing/generated VSIX archives are excluded.
- The old completion regression imported the entire Agent and regenerated its pre-existing dirty `.pyc` at `2026-10-02 16:33:11Z`. It now extracts only the tested dependency closure, disables Python bytecode writes, sets a 10-second timeout and hides the child window. Both dirty `.pyc` files stay unstaged; they are excluded from the VSIX. No reset or restoration was used.

## Live evidence, before installing the new build

- The user's transfer list was empty at `2026-10-02 16:04:21Z`; no transfer was started, cancelled or deleted by this task.
- nwpu2 inventory at `2026-10-02 16:24:52Z`: 396 files, 39,151,644,895 bytes, 12 attempt directories in 4 methods. All present attempt directories match the latest retained queue job identities; no non-latest directory or present-file hash mismatch was found.
- The current queue has 17 Plan identities / 102 latest job outputs. All 102 are incomplete on nwpu2 against their recorded required paths. ebmc jobs 0-3 have weights/logs but are missing both result fragment CSVs; jobs 4-5 are absent. Thus newest identity alone does not prove synchronization completed.
- The live `results.list` aggregate has no `summary.completedRunId`. Both inspected local BUS ebmc raw CSVs still refer to old `distributed-plan-1790368578933-eevk1p`, with seeds 42/43 only; the required latest complete authority is `distributed-plan-1790793606055-ws60vj`.
- End-to-end one-click restoration and current table provenance must be checked after the user reloads both updated extensions. Do not claim the live results are repaired before that check.
