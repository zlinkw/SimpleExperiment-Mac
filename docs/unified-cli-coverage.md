# Unified CLI coverage

Mac 同步基线：Experiment Mac 0.5.319 / SimpleSFTP Mac 0.2.105，对应冻结 Windows 0.5.440 / 0.2.117。

> 历史设计/验收记录。涉及旧控制节点、旧端口、旧推送及旧运行策略的内容不作为当前操作说明；当前只使用单台或多台 Worker，请以 [配置说明](simple-experiment-setup.md) 和 [接入模板](experiment-integration.md) 为准。


## Contract and limits

One executable: `simpleex-mac`; B uses `simpleex-mac sftp …`. Legacy aliases/raw RPC commands are removed. `actions list` reads the running host catalog; its camelCase commands map to named kebab-case commands. Backend `invoke` does exist (legacy.ts:1555); the earlier contrary report was incorrect. Live methods/identity and backend validation remain mandatory.

Actions except a small read-only set require explicit `--confirm`. The catalog field `safe` is not a read-only guarantee. Confirmation fields cannot be hidden in a parameter file. Destructive cleanup actions redirect to the protected cleanup domains. Retired Hub/promotion actions refuse. GUI actions still run in VS Code and may open dialogs; no headless equivalence or real remote completion is claimed.

The tables separate command reachability from testing of the business effect. Loopback mocks prove routing/parameters/errors; actual cleanup services are additionally exercised with isolated bottom-layer ports. No real research job, transfer, remote stop, permanent deletion, or post-reload UI acceptance was performed.

## A RPC

| Function | Command (simpleex …) | Parameters / confirmation | Evidence |
| --- | --- | --- | --- |
| actions.list | `actions list` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| agents.lifecycle | `agents lifecycle ACTION --server-ids ids` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| config.get | `config get` | key, --value JSON/text or --file JSON; set/reset need --confirm; config --scope selects storage | CLI contract suite; cleanup also actual isolated service |
| config.list | `config list` | key, --value JSON/text or --file JSON; set/reset need --confirm; config --scope selects storage | CLI contract suite; cleanup also actual isolated service |
| config.reset | `config reset` | key, --value JSON/text or --file JSON; set/reset need --confirm; config --scope selects storage | CLI contract suite; cleanup also actual isolated service |
| config.set | `config set` | key, --value JSON/text or --file JSON; set/reset need --confirm; config --scope selects storage | CLI contract suite; cleanup also actual isolated service |
| drafts.cleanup | `draft cleanup` | paths + confirmedPaths + confirm + pathConfirmed; moves into clean_dir | CLI contract suite; cleanup also actual isolated service |
| drafts.cleanupCandidates | `draft candidates` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| drafts.list | `draft list` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| drafts.promote | `draft promote` | Local DRAFT_PROMOTION_RETIRED refusal; no RPC | CLI contract suite; cleanup also actual isolated service |
| drafts.promotionPreview | `draft promotion-preview` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| drafts.reject | `draft reject` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| drafts.review | `draft review` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| drafts.validate | `draft validate` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| flow.get | `flow get` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| flow.update | `flow update` | --file JSON: step, completed?, blocked?, appliedAt? | CLI contract suite; cleanup also actual isolated service |
| gpu.history | `gpu history` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| gpu.list | `gpu status` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| invoke | `actions NAME [--file parameters.json]` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| live.output | `log show/tail` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| operations.list | `experiment overview/inspect` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| panel.diagnostics | `panel diagnostics` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| plan.validate | `plan validate PLAN [--workspace ROOT]` | Plan file and optional workspace; full server result, ok:false exits 3; validation may sync files | CLI contract suite; cleanup also actual isolated service |
| plans.cleanup.cancel | `plan cleanup cancel` | Ordered exact node:path echo, frozen token/digest, two delete phases | CLI contract suite; cleanup also actual isolated service |
| plans.cleanup.confirm | `plan cleanup confirm` | Ordered exact node:path echo, frozen token/digest, two delete phases | CLI contract suite; cleanup also actual isolated service |
| plans.cleanup.continue | `plan cleanup continue` | Ordered exact node:path echo, frozen token/digest, two delete phases | CLI contract suite; cleanup also actual isolated service |
| plans.cleanup.execute | `plan cleanup execute` | Ordered exact node:path echo, frozen token/digest, two delete phases | CLI contract suite; cleanup also actual isolated service |
| plans.cleanup.list | `plan cleanup list` | Ordered exact node:path echo, frozen token/digest, two delete phases | CLI contract suite; cleanup also actual isolated service |
| plans.cleanup.preview | `plan cleanup preview` | Ordered exact node:path echo, frozen token/digest, two delete phases | CLI contract suite; cleanup also actual isolated service |
| plans.cleanup.recheck | `plan cleanup recheck` | Ordered exact node:path echo, frozen token/digest, two delete phases | CLI contract suite; cleanup also actual isolated service |
| plans.cleanup.restore | `plan cleanup restore` | Ordered exact node:path echo, frozen token/digest, two delete phases | CLI contract suite; cleanup also actual isolated service |
| plans.cleanup.resume | `plan cleanup resume` | Ordered exact node:path echo, frozen token/digest, two delete phases | CLI contract suite; cleanup also actual isolated service |
| plans.cleanup.status | `plan cleanup status` | Ordered exact node:path echo, frozen token/digest, two delete phases | CLI contract suite; cleanup also actual isolated service |
| plans.filter | `plan filter --file filter.json` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| plans.list | `plan list` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| project.bootstrap | `project bootstrap` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| project.bootstrap.operation | `project bootstrap-operation` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| project.prepare | `project prepare` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| results.list | `result list` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| server.testAll | `server test-all [--file options.json]` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| state | `state snapshot` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| state.get | `state get` | key, --value JSON/text or --file JSON; set/reset need --confirm; config --scope selects storage | CLI contract suite; cleanup also actual isolated service |
| state.list | `state list` | key, --value JSON/text or --file JSON; set/reset need --confirm; config --scope selects storage | CLI contract suite; cleanup also actual isolated service |
| state.reset | `state reset` | key, --value JSON/text or --file JSON; set/reset need --confirm; config --scope selects storage | CLI contract suite; cleanup also actual isolated service |
| state.set | `state set` | key, --value JSON/text or --file JSON; set/reset need --confirm; config --scope selects storage | CLI contract suite; cleanup also actual isolated service |
| status | `project status` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| tasks.analyze | `task analyze` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| tasks.dispatch | `task dispatch` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| tasks.list | `experiment list/overview` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| tasks.preflight | `task preflight start` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| tasks.preflight.cancel | `task preflight cancel` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| tasks.preflight.status | `task preflight status` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| tmux.capture | `tmux capture WINDOW --worker ID` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| tmux.list | `tmux list --worker ID` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| workflow.plan | `experiment run --check --dry-run` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |
| workflow.run | `experiment run` | Live backend parameters and confirmations; see domain help | CLI contract suite; cleanup also actual isolated service |

## B RPC

| Function | Command / parameters / confirmation | Evidence |
| --- | --- | --- |
| agents.lifecycle | 已命令化（批2c） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| config.get | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| config.list | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| config.reset | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| config.set | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| confirmations.reset | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| downloadScope.configure | 已命令化（批2b） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| files.cleanup.check | 已命令化（批2c） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| files.cleanup.confirm | 已命令化（批2c） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| files.cleanup.execute | 已命令化（批2c） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| files.cleanup.inspect | 已命令化（批2c） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| files.cleanup.observeBatch | 已命令化（批2c） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| files.cleanup.preview | 已命令化（批2c） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| files.cleanup.settle | 已命令化（批2c） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| files.cleanup.status | 已命令化（批2c） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| files.cleanup.verify | 已命令化（批2c） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| handoff.markReady | 已命令化（批2b） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| project.create | 已命令化（批2b） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| remote.listDirs | 已命令化（批2a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| servers.delete | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| servers.importSshConfig | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| servers.list | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| servers.save | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| servers.setActive | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| status | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| sync.deletePath | 已命令化（批2a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| sync.downloadMappedPaths | 已命令化（批2b） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| sync.downloadPaths | 已命令化（批2b） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| sync.fromRemote | 已命令化（批2b） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| sync.planLogPaths | 已命令化（批2a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| sync.projectFileStats | 已命令化（批2a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| sync.projectInventory | 已命令化（批2a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| sync.projectTree | 已命令化（批2a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| sync.projectTreeState | 已命令化（批2a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| sync.serverToServer | 已命令化（批2b） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| sync.serverToServerBatch | 已命令化（批2b） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| sync.serverToServerFpsync | 已命令化（批2b） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| target.show | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| target.update | 已命令化（批1a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| transfers.cancel | 已命令化（批2a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| transfers.list | 已命令化（批2a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| transfers.reconcile | 已命令化（批2a） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| upload.files | 已命令化（批2b） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |
| upload.workspace | 已命令化（批2b） | SFTP CLI contract suites; cleanup also actual CleanupFileApi with stub transport |

## Named host actions

Every listed baseline command is resolved against the current live catalog, not an accepted constant count. Use `simpleex actions describe NAME` for live metadata and `--file parameters.json` for handler fields. The backend validates business fields. The resolver/confirmation framework is tested; the 174 handlers and their GUI/remote effects were not individually live-tested.

| Host function | Command | Confirmation / protected equivalent |
| --- | --- | --- |
| abortScheduler | `simpleex actions abort-scheduler` | explicit --confirm plus original handler requirements |
| addWorkerConfig | `simpleex actions add-worker-config` | explicit --confirm plus original handler requirements |
| analyzeRuntimeLog | `simpleex actions analyze-runtime-log` | explicit --confirm plus original handler requirements |
| answerRunConfirmation | `simpleex actions answer-run-confirmation` | explicit --confirm plus original handler requirements |
| applyPlanDatasetMapping | `simpleex actions apply-plan-dataset-mapping` | explicit --confirm plus original handler requirements |
| archiveArtifacts | `simpleex actions archive-artifacts` | explicit --confirm plus original handler requirements |
| archivePlan | `simpleex actions archive-plan` | explicit --confirm plus original handler requirements |
| archivePlanCopy | `simpleex actions archive-plan-copy` | explicit --confirm plus original handler requirements |
| autoMatchPlanDatasets | `simpleex actions auto-match-plan-datasets` | explicit --confirm plus original handler requirements |
| bootstrapProject | `simpleex actions bootstrap-project` | explicit --confirm plus original handler requirements |
| cancelPlanSubmission | `simpleex actions cancel-plan-submission` | explicit --confirm plus original handler requirements |
| checkClaimEvidence | `simpleex actions check-claim-evidence` | explicit --confirm plus original handler requirements |
| checkOutputContract | `simpleex actions check-output-contract` | explicit --confirm plus original handler requirements |
| checkPluginUpdates | `simpleex actions check-plugin-updates` | Original handler requirements |
| chooseNewPptPath | `simpleex actions choose-new-ppt-path` | explicit --confirm plus original handler requirements |
| choosePptPath | `simpleex actions choose-ppt-path` | explicit --confirm plus original handler requirements |
| chooseResultCsvDir | `simpleex actions choose-result-csv-dir` | explicit --confirm plus original handler requirements |
| cleanupDrafts | `simpleex actions cleanup-drafts` | Refuses this route; use draft cleanup |
| cleanupPlan | `simpleex actions cleanup-plan` | Refuses this route; use plan cleanup |
| clearCache | `simpleex actions clear-cache` | explicit --confirm plus original handler requirements |
| clearLegacyTasks | `simpleex actions clear-legacy-tasks` | explicit --confirm plus original handler requirements |
| clearOperations | `simpleex actions clear-operations` | explicit --confirm plus original handler requirements |
| clearTmuxTaskTabs | `simpleex actions clear-tmux-task-tabs` | explicit --confirm plus original handler requirements |
| compareWithBestConfig | `simpleex actions compare-with-best-config` | explicit --confirm plus original handler requirements |
| completeThreeWay | `simpleex actions complete-three-way` | explicit --confirm plus original handler requirements |
| configure | `simpleex actions configure` | explicit --confirm plus original handler requirements |
| configureAgentSessions | `simpleex actions configure-agent-sessions` | explicit --confirm plus original handler requirements |
| configureCodeSyncIncludes | `simpleex actions configure-code-sync-includes` | explicit --confirm plus original handler requirements |
| configureDownloadScope | `simpleex actions configure-download-scope` | explicit --confirm plus original handler requirements |
| configurePorts | `simpleex actions configure-ports` | explicit --confirm plus original handler requirements |
| configureServerSyncScope | `simpleex actions configure-server-sync-scope` | explicit --confirm plus original handler requirements |
| configureSessions | `simpleex actions configure-sessions` | explicit --confirm plus original handler requirements |
| configureWorkers | `simpleex actions configure-workers` | explicit --confirm plus original handler requirements |
| copyLastCheckStaticReport | `simpleex actions copy-last-check-static-report` | explicit --confirm plus original handler requirements |
| copyTensorBoardUrl | `simpleex actions copy-tensor-board-url` | explicit --confirm plus original handler requirements |
| copyText | `simpleex actions copy-text` | explicit --confirm plus original handler requirements |
| createDebugBundle | `simpleex actions create-debug-bundle` | explicit --confirm plus original handler requirements |
| deleteArtifacts | `simpleex actions delete-artifacts` | Refuses this route; use plan cleanup |
| deleteWorkerConfig | `simpleex actions delete-worker-config` | explicit --confirm plus original handler requirements |
| deployLatestAgent | `simpleex actions deploy-latest-agent` | explicit --confirm plus original handler requirements |
| diagnoseResultAnomaly | `simpleex actions diagnose-result-anomaly` | explicit --confirm plus original handler requirements |
| dispatchJobs | `simpleex actions dispatch-jobs` | explicit --confirm plus original handler requirements |
| distributeCodeToWorkers | `simpleex actions distribute-code-to-workers` | explicit --confirm plus original handler requirements |
| downloadDebugBundle | `simpleex actions download-debug-bundle` | explicit --confirm plus original handler requirements |
| downloadRemoteResult | `simpleex actions download-remote-result` | explicit --confirm plus original handler requirements |
| dryRunPlan | `simpleex actions dry-run-plan` | explicit --confirm plus original handler requirements |
| editResultColumnMapping | `simpleex actions edit-result-column-mapping` | explicit --confirm plus original handler requirements |
| excludeResults | `simpleex actions exclude-results` | explicit --confirm plus original handler requirements |
| exportCaseAnalysis | `simpleex actions export-case-analysis` | explicit --confirm plus original handler requirements |
| exportPaperTable | `simpleex actions export-paper-table` | explicit --confirm plus original handler requirements |
| exportPlottingContract | `simpleex actions export-plotting-contract` | explicit --confirm plus original handler requirements |
| fetchTmuxCapture | `simpleex actions fetch-tmux-capture` | Original handler requirements |
| fetchTmuxList | `simpleex actions fetch-tmux-list` | Original handler requirements |
| generateOutputAdapter | `simpleex actions generate-output-adapter` | explicit --confirm plus original handler requirements |
| generatePlanGuide | `simpleex actions generate-plan-guide` | explicit --confirm plus original handler requirements |
| getTensorBoardStatus | `simpleex actions get-tensor-board-status` | Original handler requirements |
| gpuWindowSamples | `simpleex actions gpu-window-samples` | Original handler requirements |
| inferConfigFromRun | `simpleex actions infer-config-from-run` | explicit --confirm plus original handler requirements |
| inspectDataset | `simpleex actions inspect-dataset` | explicit --confirm plus original handler requirements |
| installPluginUpdates | `simpleex actions install-plugin-updates` | explicit --confirm plus original handler requirements |
| killTmuxWindow | `simpleex actions kill-tmux-window` | explicit --confirm plus original handler requirements |
| loadGpuHistory | `simpleex actions load-gpu-history` | Original handler requirements |
| manualGpuSnapshot | `simpleex actions manual-gpu-snapshot` | explicit --confirm plus original handler requirements |
| manualSchedulerSnapshot | `simpleex actions manual-scheduler-snapshot` | explicit --confirm plus original handler requirements |
| manualTracesSnapshot | `simpleex actions manual-traces-snapshot` | explicit --confirm plus original handler requirements |
| markJobUnavailable | `simpleex actions mark-job-unavailable` | explicit --confirm plus original handler requirements |
| offline | `simpleex actions offline` | explicit --confirm plus original handler requirements |
| openAdvancedCommandsSetting | `simpleex actions open-advanced-commands-setting` | explicit --confirm plus original handler requirements |
| openAuditTail | `simpleex actions open-audit-tail` | explicit --confirm plus original handler requirements |
| openFullLog | `simpleex actions open-full-log` | explicit --confirm plus original handler requirements |
| openLastCheckStaticReport | `simpleex actions open-last-check-static-report` | explicit --confirm plus original handler requirements |
| openLocalResultTable | `simpleex actions open-local-result-table` | explicit --confirm plus original handler requirements |
| openPlan | `simpleex actions open-plan` | explicit --confirm plus original handler requirements |
| openPptAutomationGuide | `simpleex actions open-ppt-automation-guide` | explicit --confirm plus original handler requirements |
| openResultArtifact | `simpleex actions open-result-artifact` | explicit --confirm plus original handler requirements |
| openScalarViewer | `simpleex actions open-scalar-viewer` | explicit --confirm plus original handler requirements |
| openSetupGuide | `simpleex actions open-setup-guide` | explicit --confirm plus original handler requirements |
| openTensorBoard | `simpleex actions open-tensor-board` | explicit --confirm plus original handler requirements |
| openTensorBoardUrl | `simpleex actions open-tensor-board-url` | explicit --confirm plus original handler requirements |
| overwriteGithub | `simpleex actions overwrite-github` | HUB_REMOVED; refuses |
| parseCaseLevel | `simpleex actions parse-case-level` | explicit --confirm plus original handler requirements |
| parseResults | `simpleex actions parse-results` | explicit --confirm plus original handler requirements |
| pauseAll | `simpleex actions pause-all` | explicit --confirm plus original handler requirements |
| pauseStream | `simpleex actions pause-stream` | explicit --confirm plus original handler requirements |
| planCheckpointRetention | `simpleex actions plan-checkpoint-retention` | explicit --confirm plus original handler requirements |
| plotResultsToPpt | `simpleex actions plot-results-to-ppt` | explicit --confirm plus original handler requirements |
| prepareAgents | `simpleex actions prepare-agents` | explicit --confirm plus original handler requirements |
| promoteDraft | `simpleex actions promote-draft` | Refuses this route; use retired refusal |
| publishGithub | `simpleex actions publish-github` | HUB_REMOVED; refuses |
| queueRemainingJobs | `simpleex actions queue-remaining-jobs` | explicit --confirm plus original handler requirements |
| quickSetup | `simpleex actions quick-setup` | explicit --confirm plus original handler requirements |
| realCheck | `simpleex actions real-check` | explicit --confirm plus original handler requirements |
| reassignWorkerTask | `simpleex actions reassign-worker-task` | explicit --confirm plus original handler requirements |
| rebuildProjectResultTables | `simpleex actions rebuild-project-result-tables` | explicit --confirm plus original handler requirements |
| recallFailedJob | `simpleex actions recall-failed-job` | explicit --confirm plus original handler requirements |
| recallPlanToLocalQueue | `simpleex actions recall-plan-to-local-queue` | explicit --confirm plus original handler requirements |
| reconcileDeletions | `simpleex actions reconcile-deletions` | Refuses this route; use plan cleanup |
| recoverPlanFromRun | `simpleex actions recover-plan-from-run` | explicit --confirm plus original handler requirements |
| refreshJobArtifacts | `simpleex actions refresh-job-artifacts` | explicit --confirm plus original handler requirements |
| refreshLocalResults | `simpleex actions refresh-local-results` | explicit --confirm plus original handler requirements |
| refreshPptAutomation | `simpleex actions refresh-ppt-automation` | explicit --confirm plus original handler requirements |
| refreshResults | `simpleex actions refresh-results` | explicit --confirm plus original handler requirements |
| rejectDraft | `simpleex actions reject-draft` | explicit --confirm plus original handler requirements |
| repairPorts | `simpleex actions repair-ports` | explicit --confirm plus original handler requirements |
| reproducePlan | `simpleex actions reproduce-plan` | explicit --confirm plus original handler requirements |
| resetPptPathConfirmations | `simpleex actions reset-ppt-path-confirmations` | explicit --confirm plus original handler requirements |
| resetRemotePathConfirmations | `simpleex actions reset-remote-path-confirmations` | explicit --confirm plus original handler requirements |
| resetUiLayout | `simpleex actions reset-ui-layout` | explicit --confirm plus original handler requirements |
| restart | `simpleex actions restart` | explicit --confirm plus original handler requirements |
| restoreArchivedPlan | `simpleex actions restore-archived-plan` | explicit --confirm plus original handler requirements |
| restoreJobAvailability | `simpleex actions restore-job-availability` | explicit --confirm plus original handler requirements |
| resumeNetwork | `simpleex actions resume-network` | explicit --confirm plus original handler requirements |
| resumeStream | `simpleex actions resume-stream` | explicit --confirm plus original handler requirements |
| retryDistributedJob | `simpleex actions retry-distributed-job` | explicit --confirm plus original handler requirements |
| retryExperiment | `simpleex actions retry-experiment` | explicit --confirm plus original handler requirements |
| retryJobArtifactSync | `simpleex actions retry-job-artifact-sync` | explicit --confirm plus original handler requirements |
| retryPlanSubmission | `simpleex actions retry-plan-submission` | explicit --confirm plus original handler requirements |
| reviewDraft | `simpleex actions review-draft` | explicit --confirm plus original handler requirements |
| reviewIsolatedPlanBatches | `simpleex actions review-isolated-plan-batches` | explicit --confirm plus original handler requirements |
| runAllPlans | `simpleex actions run-all-plans` | explicit --confirm plus original handler requirements |
| runCheckStatic | `simpleex actions run-check-static` | explicit --confirm plus original handler requirements |
| runDraftDebug | `simpleex actions run-draft-debug` | explicit --confirm plus original handler requirements |
| runLeakageCheck | `simpleex actions run-leakage-check` | explicit --confirm plus original handler requirements |
| runPlan | `simpleex actions run-plan` | explicit --confirm plus original handler requirements |
| runQualityGate | `simpleex actions run-quality-gate` | explicit --confirm plus original handler requirements |
| runStatistics | `simpleex actions run-statistics` | explicit --confirm plus original handler requirements |
| runSubgroupAnalysis | `simpleex actions run-subgroup-analysis` | explicit --confirm plus original handler requirements |
| saveAgentDefaults | `simpleex actions save-agent-defaults` | explicit --confirm plus original handler requirements |
| savePlan | `simpleex actions save-plan` | explicit --confirm plus original handler requirements |
| savePptPlotConfig | `simpleex actions save-ppt-plot-config` | explicit --confirm plus original handler requirements |
| saveProjectAdapterRules | `simpleex actions save-project-adapter-rules` | explicit --confirm plus original handler requirements |
| saveRemoteRootPolicy | `simpleex actions save-remote-root-policy` | explicit --confirm plus original handler requirements |
| saveResultColumnMapping | `simpleex actions save-result-column-mapping` | explicit --confirm plus original handler requirements |
| saveResultCsvDir | `simpleex actions save-result-csv-dir` | explicit --confirm plus original handler requirements |
| saveSchedulerConfig | `simpleex actions save-scheduler-config` | explicit --confirm plus original handler requirements |
| saveTopologyMode | `simpleex actions save-topology-mode` | explicit --confirm plus original handler requirements |
| saveUiLayout | `simpleex actions save-ui-layout` | explicit --confirm plus original handler requirements |
| saveWorkerConfig | `simpleex actions save-worker-config` | explicit --confirm plus original handler requirements |
| script | `simpleex actions script` | explicit --confirm plus original handler requirements |
| selectExperiment | `simpleex actions select-experiment` | explicit --confirm plus original handler requirements |
| selectLogRunKey | `simpleex actions select-log-run-key` | explicit --confirm plus original handler requirements |
| selectPlan | `simpleex actions select-plan` | explicit --confirm plus original handler requirements |
| selfCheck | `simpleex actions self-check` | explicit --confirm plus original handler requirements |
| showLogHistory | `simpleex actions show-log-history` | explicit --confirm plus original handler requirements |
| showRegistry | `simpleex actions show-registry` | Original handler requirements |
| snapshot | `simpleex actions snapshot` | explicit --confirm plus original handler requirements |
| splitProjectResultTable | `simpleex actions split-project-result-table` | explicit --confirm plus original handler requirements |
| start | `simpleex actions start` | explicit --confirm plus original handler requirements |
| startAgentEndpoint | `simpleex actions start-agent-endpoint` | explicit --confirm plus original handler requirements |
| startAgents | `simpleex actions start-agents` | explicit --confirm plus original handler requirements |
| startAll | `simpleex actions start-all` | explicit --confirm plus original handler requirements |
| startAllConnections | `simpleex actions start-all-connections` | explicit --confirm plus original handler requirements |
| startHub | `simpleex actions start-hub` | HUB_REMOVED; refuses |
| startPptAutomation | `simpleex actions start-ppt-automation` | explicit --confirm plus original handler requirements |
| startTensorBoard | `simpleex actions start-tensor-board` | explicit --confirm plus original handler requirements |
| startTunnelEndpoint | `simpleex actions start-tunnel-endpoint` | explicit --confirm plus original handler requirements |
| startWorker | `simpleex actions start-worker` | explicit --confirm plus original handler requirements |
| status | `simpleex actions status` | Original handler requirements |
| stopAllPlans | `simpleex actions stop-all-plans` | explicit --confirm plus original handler requirements |
| stopAndClearPlan | `simpleex actions stop-and-clear-plan` | explicit --confirm plus original handler requirements |
| stopAndClearPlans | `simpleex actions stop-and-clear-plans` | explicit --confirm plus original handler requirements |
| stopExperiment | `simpleex actions stop-experiment` | explicit --confirm plus original handler requirements |
| stopTensorBoard | `simpleex actions stop-tensor-board` | explicit --confirm plus original handler requirements |
| syncAllResultArtifacts | `simpleex actions sync-all-result-artifacts` | explicit --confirm plus original handler requirements |
| syncArtifacts | `simpleex actions sync-artifacts` | explicit --confirm plus original handler requirements |
| syncGithub | `simpleex actions sync-github` | explicit --confirm plus original handler requirements; GitHub is independent of retired Hub topology |
| syncPendingPlanArtifacts | `simpleex actions sync-pending-plan-artifacts` | explicit --confirm plus original handler requirements |
| test | `simpleex actions test` | explicit --confirm plus original handler requirements |
| testAll | `simpleex actions test-all` | explicit --confirm plus original handler requirements |
| uploadProjectToHub | `simpleex actions upload-project-to-hub` | HUB_REMOVED; refuses |
| uploadProjectToWorkers | `simpleex actions upload-project-to-workers` | explicit --confirm plus original handler requirements |
| validatePlan | `simpleex actions validate-plan` | explicit --confirm plus original handler requirements |
| verifyAgentVersion | `simpleex actions verify-agent-version` | explicit --confirm plus original handler requirements |
| writeAgentCommands | `simpleex actions write-agent-commands` | explicit --confirm plus original handler requirements |

## Stable entry

`scripts/install-cli-shim.js` copies a version-independent launcher and command wrappers to the existing npm global command directory. It preflights every file, replaces only recognized SimpleExperiment wrappers, and retains obsolete package links. The launcher handshakes with the running A host and chooses exactly that installed version, never the highest installed version or a path from discovery. Stopped/mismatched/ambiguous identities refuse. Non-default installations can set `SIMPLE_CLI_EXTENSIONS_ROOT`.

For cross-repository tests set `SIMPLE_TEST_SFTP_ROOT` to the normalized absolute B checkout root (on Windows use path.resolve). Missing configuration fails instead of skipping.

## Evidence and delivery status

- Linux final CLI/service inventory: `/tmp/unified-cli/cli-final-hz0n9gkd/manifest.json`; first two unchanged passes referenced from `cli-final-ny7v9wij/manifest.json`. Total 51 unique files passed. Original failures are retained.
- Long-host-handler timeout correction and version generation: `/tmp/pi-test-8mpx_41u/result.json` plus generator/compile logs; subsequent native checks cover the changed candidate.
- Stable upgrade/mismatch fixture: `/tmp/pi-test-3wxckyhd/result.json`. Actual PlanCleanup reordered-echo regression is included in the final service file.
- Native Windows acceptance covers 247 A files and 64 B files. `.audit/native-cli/run-27w3nH/manifest.json` retains the original exit 1 caused solely by three new Python bytecode caches; `verification-publishable.json` proves their provenance, unchanged sources, and absence from the VSIX. No failed record was rewritten.
- Final GitHub/Hub classification correction: `.audit/final-actions-qqcko5/result.json` records four affected CLI files, closure check and non-overwriting A repack, all exit 0. Lock root bin metadata matches current manifests; dependency/version data did not change and neither lock is in the packages. The earlier A VSIX remains historical, use the final-actions archive.
- No installation, Release, PR merge or real server operation is implied by source coverage. Each state requires its own receipt; merging still needs candidate-bound approval/authorization.

Historical per-slice narrative is retained at `.audit/unified-cli-coverage-before-parent.md`; raw logs remain unchanged.
