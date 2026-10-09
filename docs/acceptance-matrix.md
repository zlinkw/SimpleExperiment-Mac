# Acceptance Matrix

This matrix defines the repeatable fake/mock acceptance gate for the SimpleExperiment extension. It is the source of truth for final release checks. Real SSH cluster checks are optional and live in `docs/manual-acceptance-checklist.md`.

Run:

```powershell
npm run acceptance
```

The command writes JSON and Markdown reports to `simple_cluster/reports/acceptance/`.

| Area | Required behavior | Automated evidence | Fake/mock only |
| --- | --- | --- | --- |
| Basic stability | build, typecheck, package, `node -c dist/extension.js`, `node -c dist/panel.js`, CLI status | `npm run acceptance`, `npm run smoke`, `test/features/*.test.js` | Yes |
| Webview | panel script loads as external webview JS and old VS Code webview compatibility holds | `test/sshAndGpuUi.test.js`, `node -c dist/panel.js` | Yes |
| Config recovery | corrupt JSON returns lastKnownGood, migrations fill defaults | `test/engineeringHardening.test.js` | Yes |
| SSH policy | ControlMaster, persistent shell, oneshot order; realtime/background suppress frequent oneshot | `test/engineeringHardening.test.js`, `test/sshAndGpuUi.test.js`, `docs/ssh-transport.md` | Yes |
| Agent stream | snapshot freshness, event schema, terminal state protection, journal gap scenarios | `test/engineeringHardening.test.js`, `test/scenarioRunner.test.js`, `scenarios/stream-journal-gap.json`, `scenarios/agent-restart-recover.json` | Yes |
| Runtime | manifest, hash verify, deploy, rollback | `test/engineeringHardening.test.js`, `scenarios/runtime-upgrade-rollback.json` | Yes |
| Worker failure | one worker failure does not block all scheduling | `test/experimentPlatform.test.js`, `scenarios/worker-offline-during-run.json`, `scenarios/smart-scheduler-worker-failover.json` | Yes |
| Plan management | registry, schema, template, builder, matrix, constraints, dry-run, resource estimate | `test/planManagement.test.js`, `scenarios/plan-builder-grid.json`, `scenarios/plan-constraint-filtering.json` | Yes |
| Lifecycle | retry, reproduce, revision diff, timeline, terminal state protection | `test/planManagement.test.js`, `test/experimentPlatform.test.js`, `scenarios/experiment-retry-from-failed.json`, `scenarios/plan-retry-failed.json` | Yes |
| Archive and sync | three-end completion, hub state no unknown regression, sync does not overwrite deleted | `test/syncState.test.js`, `test/codeSync.test.js`, `scenarios/delete-sync-race.json` | Yes |
| Delete | tombstone priority, no restore after delete, residue visible, path safety | `test/syncState.test.js`, `test/engineeringHardening.test.js`, `scenarios/delete-recycle-view.json` | Yes |
| Result management | registry, long and wide CSV parsing, presets, schemas, alias, dimension extraction, validation | `test/resultManagement.test.js`, `test/resultAdvanced.test.js`, `scenarios/results-parse-standard-long.json`, `scenarios/results-parse-custom-wide.json` | Yes |
| Leaderboard and paper table | inclusion policy, aggregation, Markdown/CSV/LaTeX export, dashboard, consistency checker | `test/resultManagement.test.js`, `test/resultAdvanced.test.js`, `scenarios/results-paper-table-export.json` | Yes |
| Comparison and reproduction | study registry, protocol, methods, checklist, deviation log, plan generator, fairness | `test/comparisonManagement.test.js`, `scenarios/comparison-paper-reproduction.json`, `scenarios/comparison-fairness-violation.json` | Yes |
| Statistical analysis | baseline improvement, lower-is-better, paired test, paper/local separation | `test/comparisonManagement.test.js`, `test/qualityManagement.test.js`, `scenarios/statistics-auto-update-paper-table.json` | Yes |
| Output contract | project output contract, checker, guide, Python snippets, capability matrix | `test/qualityManagement.test.js`, `test/smallScaleManagement.test.js`, `scenarios/output-capability-matrix.json` | Yes |
| Quality gate | gate result, leaderboard/paper inclusion policy, warnings not hidden | `test/qualityManagement.test.js`, `scenarios/quality-gate-missing-primary-metric.json` | Yes |
| Case-level analysis | parser, worst cases, FP/FN basis, subgroup analysis, leakage warning when patient_id missing | `test/qualityManagement.test.js`, `scenarios/case-level-error-analysis-segmentation.json`, `scenarios/data-leakage-patient-overlap.json` | Yes |
| Small-scale workflow | default small mode, <=10 concurrent experiments, completeness matrix, missing-only rerun, manual review, paper freeze | `test/smallScaleManagement.test.js`, `scenarios/small-scale-10-experiments.json`, `scenarios/full-workflow-fake-acceptance.json` | Yes |
| Engineering | OperationQueue, ClusterStore, ErrorModel, AuditLog, diagnostics, debug bundle, safe paths | `test/scenarioRunner.test.js`, `test/engineeringHardening.test.js`, `test/experimentPlatform.test.js` | Yes |

## Release Gate

A release candidate passes automated acceptance only when:

- `npm run acceptance` exits with code `0`.
- The generated acceptance report says `overall=passed`.
- No database dependency is present in `package.json`.
- All checks use fake/mock runtime and require no real SSH server.

## Known Manual-Only Scope

The following cannot be fully proven without a real cluster and is covered by the optional checklist:

- Real network latency and SSH daemon behavior.
- Real `rsync` throughput and permissions.
- Real GPU process listing accuracy.
- Real tmux session survival after machine restart.
