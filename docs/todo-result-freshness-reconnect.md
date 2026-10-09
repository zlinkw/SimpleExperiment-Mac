# TODO: authoritative result freshness and reconnect UX

## Goal and scope

Keep result rows, downloaded artifacts, local dataset tables, and historical logs bound to the latest complete distributed run for each Plan. Preserve old attempt artifacts for audit. Remove manual reconnect prompts from ordinary transient-disconnect paths while retaining hard-error and explicit pause recovery.

## Work items

- [x] Add one pure freshness helper that selects the latest complete same-revision distributed Plan run and carries run/job/artifact identity; use PlanArtifactSync only as historic fallback.
- [x] Route current-Plan sync, all-Plan metric sync, result-table rebuild, and completed-job metric recovery through that helper; reject summaries with missing or conflicting run identity when a current distributed run exists.
- [x] Make metrics sync publish current distributed results, and prevent an old shared formal CSV from suppressing latest-attempt recovery.
- [x] Stamp run identity into distributed rebuild manifests and project adapter provenance; replace each Plan's current method/dataset rows by run identity without mixing runs, keeping old raw attempts.
- [x] Bind completed historical logs to commandId + outputDir + runId and test reused-GPU attempts cannot cross-read logs.
- [x] Remove ordinary toolbar/manual reconnect actions and replace outcome-pending wording with refresh/automatic-wait guidance; preserve explicit pause and hard configuration/auth recovery.
- [x] Add same-revision run A → run B regressions across metric sync, result-table registry, raw downloads, logs, and reconnect behavior.
- [x] Run requested tests serially, then typecheck/build/VM gate/package; preserve the two dirty `.pyc` files.
- [ ] Validate real MultiModal `ebmc` against `distributed-plan-1790793606055-ws60vj`, including raw `job_dir`, method-table seeds, `results.list` run identity/value provenance, after the updated Extension Host is loaded.

## Validation and delivery record

- Baseline checked on 2026-10-02: `git status` contained only the two protected dirty `.pyc` files; HEAD was `efacd98b`.
- Passed serial Node tests: `pendingResultMetricSync` 26/26, `projectResultSyncCompleteness` 16/16, `projectResultTables` 17/17, `distributedRerunAndWorkerDelta` 8/8, `runCompletionResultRefresh` 1/1, `tmuxWorkerAndRichLog` 5/5, `realtimeReconnect` 4/4, `manualConnectionRecovery` 9/9, and `planRunFreshness` 5/5.
- Passed MultiModal `tests.test_distributed_results`: 5/5, using the documented `zlk` Python environment.
- Passed MultiModal result-table consistency and all-config checks; `npm run build`, `npm run package` (0.5.211), and the explicit `vm.Script` gate passed. `npm run install:latest` installed 0.5.211 once; installed extension and `simpleex.cmd`/CLI entry were verified.
- Live pre-update read-only baseline: SimpleExperiment API 0.5.210 `results.list` returned 8 rows for `experiments/plans/comparison/ebmc.yaml`, with no completed/run ID and source `experiments/results/formal/ebmc.csv`; SimpleExperiment CLI was unavailable, so reads used the discovered loopback HTTP API after capabilities/OpenAPI checks.
- Read-only local queue verification found the exact target run complete at 6/6, attempt 2, with each job's `commandId`, attempt-scoped `outputDir`, and artifact hashes present. Post-install API/panel access is paused until the user runs **Developer: Reload Window**; exact-run live acceptance remains pending. Do not report live repair until `distributed-plan-1790793606055-ws60vj` is verified after reload.
