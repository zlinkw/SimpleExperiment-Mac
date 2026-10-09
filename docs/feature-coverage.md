# Feature Coverage

This document maps the product workflow to source modules, tests, scenarios, and docs. It is intentionally lightweight and file-based.

| Workflow | Source modules | Tests | Scenarios | Docs |
| --- | --- | --- | --- | --- |
| Startup, state, Webview | `src/extension.ts`, `src/panel.ts`, `src/state/*`, `src/ui/*` | `test/sshAndGpuUi.test.js`, `test/engineeringHardening.test.js` | `run-plan-success.json` | `docs/testing.md`, `docs/state-model.md` |
| SSH transport | `src/ssh/SshPolicy.ts`, `src/remote/RemoteFileStore.ts` | `test/engineeringHardening.test.js`, `test/sshAndGpuUi.test.js` | `worker-offline-during-run.json` | `docs/ssh-transport.md` |
| Hub Agent and runtime | `src/agent/*`, `src/runtime/*`, `src/services/AgentService.ts` | `test/engineeringHardening.test.js` | `agent-restart-recover.json`, `stream-journal-gap.json`, `runtime-upgrade-rollback.json` | `docs/runtime-agent.md` |
| Scheduling and lifecycle | `src/features/PlanBuilder.ts`, `src/features/SmartScheduler.ts`, `src/clusterSchedulerRuntime.ts` | `test/experimentPlatform.test.js`, `test/planManagement.test.js` | `plan-builder-grid.json`, `smart-scheduler-worker-failover.json`, `experiment-retry-from-failed.json` | `docs/architecture.md` |
| Archive, sync, delete | `src/syncState.ts`, `src/cluster/StateMerge.ts`, `src/features/Archive*` where present | `test/syncState.test.js`, `test/codeSync.test.js` | `delete-sync-race.json`, `delete-recycle-view.json` | `docs/state-model.md`, `docs/troubleshooting.md` |
| Result registry and parsing | `src/features/Results.ts` | `test/resultManagement.test.js`, `test/resultAdvanced.test.js` | `results-parse-standard-long.json`, `results-parse-custom-wide.json` | `docs/acceptance-matrix.md` |
| Result schema, leaderboard, paper table | `src/features/Results.ts` | `test/resultAdvanced.test.js`, `test/resultManagement.test.js` | `results-paper-table-export.json`, `results-leaderboard-medical-segmentation.json` | `docs/acceptance-matrix.md` |
| Comparison and reproduction | `src/features/Comparison.ts` | `test/comparisonManagement.test.js` | `comparison-baseline-study.json`, `comparison-paper-reproduction.json`, `comparison-fairness-violation.json` | `docs/acceptance-matrix.md` |
| Output contract and quality | `src/features/Quality.ts` | `test/qualityManagement.test.js` | `output-contract-missing-case-csv.json`, `quality-gate-missing-primary-metric.json` | `docs/acceptance-matrix.md` |
| Statistics | `src/features/Quality.ts`, `src/features/Comparison.ts` | `test/qualityManagement.test.js`, `test/comparisonManagement.test.js` | `statistics-auto-update-paper-table.json`, `comparison-reproduce-gap-report.json` | `docs/acceptance-matrix.md` |
| Case-level and leakage analysis | `src/features/Quality.ts` | `test/qualityManagement.test.js` | `case-level-error-analysis-segmentation.json`, `case-level-error-analysis-classification.json`, `data-leakage-patient-overlap.json` | `docs/acceptance-matrix.md` |
| Small-scale paper workflow | `src/features/SmallScale.ts` | `test/smallScaleManagement.test.js` | `small-scale-10-experiments.json`, `full-workflow-fake-acceptance.json` | `docs/acceptance-matrix.md` |
| Diagnostics and audit | `src/diagnostics/*`, `src/core/OperationQueue.ts`, `src/core/ErrorModel.ts` | `test/engineeringHardening.test.js`, `test/scenarioRunner.test.js` | `full-workflow-fake-acceptance.json` | `docs/troubleshooting.md` |

## Automated Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm run typecheck` | Type-check source. |
| `npm run lint` | Run repository smoke lint. |
| `npm test` | Run unit and integration tests against `dist/`. |
| `npm run test:scenarios` | Run fake scenario suite. |
| `npm run smoke` | Build, lint, syntax-check generated JS, CLI status, package VSIX. |
| `npm run acceptance` | Run the full fake/mock release gate and write an acceptance report. |

## Non-Goals

- No external database acceptance path.
- No real SSH requirement for automated acceptance.
- No million-row case-level load test.
- No destructive delete test against real user artifacts.