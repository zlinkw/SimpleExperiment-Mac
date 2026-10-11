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
参考Windows从Mac分叉基线8934ed8b之后至42902a5a的17个提交，以及SimpleSFTP至acae730的对应改动，集中同步功能页和方法。保留Mac独立身份、静态preview更新、Termius手动端点、POSIX路径、认证、中转与共享租约。对应入口和提交矩阵见仓库docs/windows-sync-2026-10-12.md。
GPU快照支持初始化/重连恢复与最后有效采样，当前用户任务只认本机派发身份及新鲜完整Worker回执，不按登录名或Plan名认领。保留按GPU编号的固定容器与内部任务标签；旧窗口不迁移、不自动关闭。
执行与结果区同步长期面板恢复、失败召回、明确不可用、新鲜度和实际收集阶段。新正式任务使用Plan声明的稳定目录/CSV，不新建attempt，不直接覆盖；旧attempt历史只读、draft真实执行明确拒绝。所有格式结果只读入内存，保存摘要/来源大小和SHA，不新建原始下载副本，保留已有文件。
持久启动前拒绝回执按精确身份显示failed/neverStarted，丢即时回执后可由Worker快照恢复；未启动任务不显示tmux日志操作。新派发要求Worker declaredJobPaths能力，不会偷偷绕过旧Agent。
Plan区“清除 PLAN 及关联产物”同步独立审核、完整路径/所有权/Git祖先预检、阶段进度、离线未完成节点与手动重新预览。macOS可靠打开句柄证明尚缺，实际清理报HANDLE_CHECK_UNAVAILABLE并阻断，永久删除两次确认及物理直接父目录保护不放宽。

本地验证
两仓build、234/28模块依赖闭包、生成面板脚本与vm门禁、原Mac回归以及本轮Windows功能同步回归，全部逐文件串行20秒，Python只隔离函数10秒。正式目录/CSV、内存结果、精确GPU归属、持久拒绝及清理审核均覆盖；旧fixture按正式协议修正，不恢复已退休自动attempt。实际VSIX和源码快照另行核验。没有运行完整Agent/科研实验，没有连接服务器、传输真实文件、执行真实清理、部署Agent或安装开发机扩展。

M5 真机验证
用户2026-10-11报告仍为.309/.97，部分最小启动、更新入口/失败恢复、Termius端点、密码传输、中文空格%20及共享写入保护取得证据；本轮新增页面/正式执行/结果/清理审核尚待真机。在线安装/重载/补装、完整密钥与ssh-agent、断连中转及三拓扑科研仍未验。原方案18已验证、11/29剩余，整体保持paused，不以本地模拟代替M5。

首次安装与更新
先SimpleSFTP Mac 0.2.100，再SimpleExperiment Mac 0.5.313并重载。以后点击底部Mac preview状态栏，或⇧⌘P“检查 preview 配套更新”，或面板“设置 → 插件配套更新 → 检查更新”，发现新版点击“更新并重载”。旧版若仍受更新租约阻塞，等本地传输完成后下载本Release两份VSIX依次手动安装，无需删锁。
插件更新不会升级远端Agent。已有任务照常运行；任务空闲后用户主动“准备项目与 Agent”核对并确认上传，再在Termius手动处理Agent并点击检测。不要为验证新版中断现有实验。本次发布零远端任务操作、零开发机安装、零Actions。

源码提交
SimpleSFTP-Mac ${commits[0]}
SimpleExperiment-Mac ${commits[1]}
`;
  fs.writeFileSync(path.join(directory, "release-notes.md"), notes, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Prepared immutable paired preview: ${directory}\n`);
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { main };
