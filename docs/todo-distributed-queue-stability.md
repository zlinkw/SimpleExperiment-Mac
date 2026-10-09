# TODO: distributed queue cache stability

## Goal

Keep the durable distributed Plan queue visible and stable during 500 ms ticks; prevent self-conflicts from shared cache mutation while retaining protection against genuine external edits.

## Scope

- In scope: queue load/save signatures, independent tick work copies, stable display snapshot, terminal log-path pinning, queue-storage tests, live state sampling.
- Out of scope: tick interval changes, UI behavior workarounds, scheduler semantics, deleting queue/history data.
- Protected: the two pre-existing dirty `dist/runtime/__pycache__/*.pyc` files.

## Work items

- [x] Capture current API baseline and build deterministic queue-cache regressions.
- [x] Replace mutable-cache equality with an immutable disk signature and working-copy base revision.
- [x] Keep the display snapshot isolated; on conflict reload disk atomically or retain last-known-good state with stale/conflict diagnostics.
- [x] Prevent terminal jobs from accepting shared live tmux log paths on later ticks.
- [x] Audit all queue save callers and prove the unified storage function is the only disk writer.
- [x] Run requested tests serially, then build and Webview `vm.Script` gate; preserve dirty `.pyc` files.
- [x] Package/install the patch; perform post-reload 30-sample live verification after the user reloads the Extension Host.

## Validation record

- Starting HEAD: `34c0ca64ad1e51f56feb50d1297e4be5ffdc1f56`; starting `git status` contains only the two protected dirty `.pyc` files.
- Current source has `loadDistributedQueue()` returning the shared cache object; `tickDistributedQueueCore()` mutates it before save; `saveDistributedQueue()` compares JSON against that mutable cache and clears it on conflict. `serverPlanProgress()` returns an empty list while the cache is unset.
- Pre-fix live baseline sampled `distributedPlans/deferredPlans` 12 times as `28/3` throughout this short sample; the user's longer `0↔28` evidence was not reproduced during these 12 reads.
- Added bounded SHA-256 disk signatures to loaded queue work copies, isolated deep clones for queue writes, stable display-cache swaps, and stale/conflict diagnostics. A genuine external edit reloads the new disk snapshot and rejects the stale write; a failed read retains the last-known-good snapshot.
- Worker task log paths now remain attempt-bound after terminal status; shared tmux paths are accepted only while the task is live.
- `distributedQueueCacheStability.test.js` proves 20 tick-equivalent writes keep 28 Plans visible, 10 repeated terminal-log reconciliations stay stable, cache/work copies are isolated, and external edits do not empty or overwrite the display queue.
- Direct queue-file writer audit: `distributedQueuePath()` and all `saveDistributedQueue()` calls are in `src/extension/legacy.ts`; its `saveDistributedQueue()` is the only source-level queue file writer.
- Passing serial checks: `distributedQueueCacheStability` 4/4, `distributedPlanQueue` 23/23, `distributedQueueStartup` 19/19, `distributedRerunAndWorkerDelta` 8/8, `tmuxWorkerAndRichLog` 5/5, `executionCompactOverview` 13/13, `resourceMutationRouting` 2/2; `npm run build` and Webview `vm.Script` passed.
- Packaged and installed version `0.5.212`; VS Code reports `simple-local.simple-experiment@0.5.212`, and `simpleex` resolves to `C:\Users\ZLK\AppData\Roaming\npm\simpleex.ps1` for package bin `./dist/cli.js`.
- Supplementary full `planStopClear.test.js` remains red in five unrelated existing VM/Python fixture cases; its concurrent queue append/save case passes after updating the mock to model disk reads and atomic rename.
- Post-install 30-sample live verification is pending because the Extension Host must be reloaded after installing 0.5.212.
