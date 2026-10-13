"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { EXPERIMENT_ROOT, SFTP_ROOT, REPOSITORY, run, npm, json, fingerprint, assertSource } = require("./mac-release-common");
const { createPackageProjection, assertPackageProjection } = require("./mac-package-projection");

function main() {
  const roots = [SFTP_ROOT, EXPERIMENT_ROOT], repos = ["SimpleSFTP-Mac", "SimpleExperiment-Mac"];
  const commits = roots.map((root, index) => assertSource(root, repos[index]));
  const packages = roots.map(root => json(path.join(root, "package.json")));
  for (let index = 0; index < 2; index++) {
    if (`${packages[index].publisher}.${packages[index].name}` !== ["simple-local.simple-sftp-mac", "simple-local.simple-experiment-mac"][index]) throw new Error("Unexpected Mac extension identity");
    if (!/^\d+\.\d+\.\d+$/.test(packages[index].version)) throw new Error("Invalid package version");
    npm(["run", "build"], roots[index]);
  }
  const files = ["macSchedulerGpuTabs", "tmuxGpuSessionClose", "tmuxClearTaskTabs", "tmuxTaskTabClose", "abortSchedulerStopRouting", "planStopClear", "macCacheCleanup", "simpleSftpIntegrationPreflight", "commandPaletteClarity", "macVsix", "macPreviewRelease", "macUpdateTransaction", "macBootstrap", "macCliLauncher", "macCliApi", "macCliWorkflow", "macWorkflowBinding", "macPlanIdentity", "macPlanFiles", "macAgentPlanIdentity", "macPlanLaunchPaths", "macResultIdentity", "macResultSummaryScope", "macMappedResultIdentity", "macResultFiles", "macLocalMetricParsing", "macResultOperationScope", "wrapperResultPersistence", "pendingResultMetricSync", "metricsDownloadEndToEnd", "resultsSummaryWebviewCache", "macResultCandidates", "macPlanResultCandidates", "jsonConfigOnboarding", "projectResultLocationClarity", "backendOutputDerivationCaches", "outputCandidateDedupRegression", "planScopedResultCandidateCache", "planSelectionPreviewAndWorkerEmptyState", "planOutputEvidenceSignals", "projectResultTables", "manualDistributedResultSync", "projectResultSyncCompleteness", "remoteResultInspectionWorkflow", "resultCsvDirectoryConfig", "datasetResultCatalog", "distributedPlanExecutionMode", "planRunModeWorkflow", "distributedProjectContract", "distributedPlanQueue", "distributedJobAutoRetry", "planSafeRetry", "distributedPlanSubmissionRouting", "planSubmissionVisiblePreflight", "macUpdateGate", "macUpdatePanel", "macHostLeasePaths", "macSetupGuide", "macPanelTheme", "macManualTunnel", "macProjectPrepare", "macPosixPaths", "topologyMode"];
  for (const file of files) run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", `test/features/${file}.test.js`], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macAgentOutputContract.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macAgentResultFiles.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macAgentParseResults.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macArchiveEvidenceRead.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macProjectAggregateRead.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macClaimEvidenceRead.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macPlanAnalysisRead.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macCaseAnalysisRead.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/scripts/macPackageProjection.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macUpdateLeaseRecovery.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  for (const file of ["sourceReaderLineEndings", "compactTargetModePlan", "macRelease", "macPreviewIndex"]) run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", `test/scripts/${file}.test.js`], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/core/workspacePathMapper.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  for (const file of ["macBootstrap", "macCliLauncher", "macCliApi", "publicBranding", "api", "workspacePathMapper", "workspaceIntegration", "macLeasePaths", "macAuthentication", "macRelay", "macPosixPaths", "macRelativePaths", "macDownloadScope", "apiUploadProgress", "macTransferExitProof", "macNativeAcceptanceRecovery", "transferRecovery", "transferSettlement"]) run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", `test/${file}.test.js`], SFTP_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/ui/cacheCleanupPanel.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/ui/tmuxOtherSessionsDisclosure.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  // Frozen Windows feature synchronization gates, serial and bounded like the native gates.
  for (const file of ["test/agent/failedAttemptQuarantine.test.js","test/agent/gpuJobIdentity.test.js","test/features/distributedSchedulingModes.test.js","test/features/failedJobRecovery.test.js","test/features/formalJobExecution.test.js","test/features/gpuSubmittedJobOwnership.test.js","test/features/idleGpuDispatchLifecycle.integration.test.js","test/features/jobUnavailable.test.js","test/features/mergedGpuWebviewCache.test.js","test/features/panelOvernightRecovery.test.js","test/features/panelStateProjection.test.js","test/features/planCleanup.test.js","test/features/planCleanupPanelBridge.test.js","test/features/planCleanupReconnect.test.js","test/features/planOutputRetention.test.js","test/features/planResultPathContract.test.js","test/features/planRunFreshness.test.js","test/features/preflightDispatchRejection.test.js","test/features/vsixRuntimeClosure.test.js","test/tunnel/gpuWorkerSnapshotRecovery.test.js","test/ui/executionCompactOverview.test.js","test/ui/extensionStatePost.test.js","test/ui/gpuMissingServerRows.test.js","test/ui/gpuOwnerMatching.test.js","test/ui/jobTmuxLogNavigation.test.js","test/ui/jobUnavailable.test.js","test/ui/resultCommandPhaseRouting.test.js","test/scripts/runtimeVersionHeader.test.js"]) run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", file], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/cleanupFiles.test.js"], SFTP_ROOT, { inherit: true, timeout: 20000 });
  // Additional frozen Windows 7bb96599 / SFTP ed75a5d regressions.
  for (const file of ["test/features/macFormalIdentity.test.js","test/features/formalIdentityTmux.test.js","test/features/executionShellEnvironment.test.js","test/features/executionShellPreflight.test.js","test/features/formalJobPreflightProgress.test.js","test/features/failedJobCleanup.test.js","test/features/completedPlanWorkerMirror.test.js","test/features/formalJobPreflightApi.test.js","test/features/formalJobStop.test.js","test/features/formalJobRejectedRecovery.test.js","test/features/formalJobPreflightFailure.test.js","test/features/manualOnlyResultSync.test.js","test/features/distributedQueueStartup.test.js","test/features/distributedRerunAndWorkerDelta.test.js","test/features/planArtifactSyncStatus.test.js","test/features/prequeueRecallLifecycle.test.js","test/agent/prequeueRecall.test.js"]) run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", file], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  for (const file of ["test/formalJobCleanupOwner.test.js", "test/pairedUpdateDrain.test.js"]) run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", file], SFTP_ROOT, { inherit: true, timeout: 20000 });
  npm(["run", "verify:package-runtime"], EXPERIMENT_ROOT);
  run(process.execPath, ["-e", "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8'))"], EXPERIMENT_ROOT);
  const tag = `preview-v${packages[1].version}`, directory = path.join(EXPERIMENT_ROOT, "release-artifacts", tag);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (fs.existsSync(directory)) throw new Error(`Prepared version already exists; inspect retained artifacts: ${directory}`);
  fs.mkdirSync(directory);
  const { inspectVsix, verifyVsix } = require("../dist/mac/Vsix");
  const components = roots.map((root, index) => {
    const pkg = packages[index], name = `${pkg.name}-${pkg.version}-darwin-arm64.vsix`, file = path.join(directory, name);
    const projection = createPackageProjection(root);
    run(process.execPath, [require.resolve("@vscode/vsce/vsce", { paths: [root] }), "package", "--no-dependencies", "--target", "darwin-arm64", "--out", file], projection.directory, { inherit: true, timeout: 60000 });
    assertPackageProjection(projection);
    const metadata = fingerprint(file), actual = inspectVsix(fs.readFileSync(file));
    const component = { extensionId: `${pkg.publisher}.${pkg.name}`, version: pkg.version, sourceCommit: commits[index], sourceRepository: `zlinkw/${repos[index]}`, targetPlatform: "darwin-arm64", vscodeEngine: pkg.engines.vscode, downloadUrl: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`, size: metadata.size, sha256: metadata.sha256 };
    verifyVsix(fs.readFileSync(file), component);
    if (actual.files.has("extension/baseline-source.zip") || [...actual.files.keys()].some(name => /\/release-artifacts\//.test(name))) throw new Error("Package contains local release artifacts");
    return component;
  });
  for (let index = 0; index < 2; index++) if (assertSource(roots[index], repos[index]) !== commits[index]) throw new Error("Build changed release source");
  const manifest = { protocolVersion: 1, channel: "preview", releaseTag: tag, publishedAt: new Date().toISOString(), minimumMacOS: "26.0", components };
  fs.writeFileSync(path.join(directory, "release.json"), JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  const notes = `Apple Silicon macOS 26 及以上 preview。

本版变化
参考Windows42902a5a至7bb96599的9次提交及SFTP acae730至ed75a5d的2次提交，采用正式任务身份/精确停止、进度与真实shell预检、人工拒绝恢复、失败job审核、全部正式Plan成功后的Worker镜像及更新等待优化。提交/操作矩阵见docs/windows-sync-2026-10-13.md。保留Mac独立身份/preview静态索引/Termius手动端点/POSIX/认证/本机中转/共享租约/GPU内部标签，未复制Windows发布或自动部署。
正式任务身份通过独立shell传递，清除继承的其他job环境与Agent token；停止只针对原command绑定Pane，不关闭共享GPU容器。正式控制无需attempt；历史attempt只读，现有任务不迁移。Worker缺匹配正式身份/停止/环境预检能力时明确拒绝新控制。
启动前预检只按真实资产进度延长等待，重复阶段心跳/停滞/计数倒退/坏JSON/取消都拒绝并保留neverStarted回执。预检和执行使用同一配置shell/解释器，缺环境先失败。tasks.preflight、tasks.preflight.status、tasks.preflight.cancel仅诊断原失败job，不训练或改队列；environmentOnly只检查原环境，调用前须读discovery和live capabilities。
失败卡片“重新排队此 job”遇占用输出可进入“审核遗留文件”。只读预览冻结workflow/index/command，只处理独占正式目录和声明CSV，经完整终态owner及SHA核验。归档batch纳入不可变摘要/精确确认，CSV先于owner目录；成功同伴、PLAN和共享引用保留。全部节点完成后仍需返回原卡片人工确认重排，不自动清理或重跑。
全部正式Plan成功后通过SimpleSFTP在启用Worker间镜像其声明权重、日志、配置和CSV，冻结原run身份、路径、owner/hash，持久回执合并、重连只补缺项。失败/运行中/取消/不可用/恢复不完整/历史attempt不触发；活动writer、清理hold、来源身份或目标内容冲突均阻止覆盖。本机解析、汇总、归档及论文发布继续手动，原始指标不自动下载到本机。
更新门禁保留已有传输续租/验主，可取消更新等待且原传输继续。未知安装回执即使首项无完成记录也保持业务封锁；原批次/清单冻结，重载后仅提示用户点击补装，不自动安装。未完成入场ticket和存活/无法证明退出的持有者都要等待；协议要求SFTP Mac至少0.2.101。
macOS仍缺可靠打开句柄证明，实际清理报HANDLE_CHECK_UNAVAILABLE并阻断。永久删除两次完整路径确认、物理直接父目录与最短子项执行器不放宽。

本地验证
全部构建与验证在本机完成：两仓build、生成面板脚本及vm、234/28运行模块闭包，旧门禁保留并加入本轮回归，逐文件串行20秒，Python函数隔离10秒。真实专属WSL tmux/Git Bash/std库环境探针只处理新建夹具，没有科研训练；所有服务器API/传输/清理动作均替身。历史旧GPU生成脚本10秒终止及8秒闭包枚举失败回执保留，修正固定AST夹具/路径/更新hook后必须以本版完整门禁验证，不把旧失败写成通过。实际VSIX消费者及源码快照另行核验。

M5 真机验证
用户现有报告仍为.309/.97，已证明部分最小启动、更新检查恢复、隧道、密码传输、中文空格%20及共享写入保护。本轮新增正式执行/预检/停止、完成Worker镜像、失败审核和更新恢复仍待M5；没有连接生产服务器、启停现有任务、部署Agent、真实传输/清理、开发机安装或Actions。固定原目标29条，18已验证11剩余，整体paused。

安装与更新
从同一Release先安装SimpleSFTP Mac 0.2.101，再安装SimpleExperiment Mac 0.5.314并重载；首次过渡先等待本地传输完成，旧锁阻断时无需删锁，直接依次安装两份VSIX。以后点击底部Mac preview状态栏，或⇧⌘P“检查 preview 配套更新”，或面板“设置 → 插件配套更新 → 检查更新”；发现新版点击更新并重载，未完成时点击“安装 preview 配套更新”补原批次。
插件更新不会部署远端Agent。任务空闲后用户主动通过“准备项目与 Agent”核对/确认上传，再在Termius手动处理并检测；不要为验证新runtime中断现有实验。

源码提交
SimpleSFTP-Mac ${commits[0]}
SimpleExperiment-Mac ${commits[1]}
`;
  fs.writeFileSync(path.join(directory, "release-notes.md"), notes, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Prepared immutable paired preview: ${directory}\n`);
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { main };
