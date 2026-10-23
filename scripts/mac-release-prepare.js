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
  const rootsByComponent = { experiment: EXPERIMENT_ROOT, sftp: SFTP_ROOT };
  const proofFile = process.env.SIMPLE_MAC_VALIDATION_PROOF;
  const validated = proofFile ? require("./mac-release-validation").assertValidationProof(
    proofFile, rootsByComponent, getReleaseValidationInventory(rootsByComponent), commits)
    : new Set([path.resolve(EXPERIMENT_ROOT, "test/features/panelWebviewScriptHealth.test.js")]);
  runValidationTests(run, rootsByComponent, process.execPath, validated);
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
  if (proofFile) require("./mac-release-validation").assertValidationProof(
    proofFile, rootsByComponent, getReleaseValidationInventory(rootsByComponent), commits);
  for (let index = 0; index < 2; index++) if (assertSource(roots[index], repos[index]) !== commits[index]) throw new Error("Build changed release source");
  const manifest = { protocolVersion: 1, channel: "preview", releaseTag: tag, publishedAt: new Date().toISOString(), minimumMacOS: "26.0", components };
  fs.writeFileSync(path.join(directory, "release.json"), JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  const notes = buildReleaseNotes(commits, [packages[0].version, packages[1].version]);
  fs.writeFileSync(path.join(directory, "release-notes.md"), notes, { encoding: "utf8", flag: "wx" });
  // 禁止发布脚本跑完后脏树：构建期 compact:plan 若改写了 plan，必须在提交前审查并重新准备。
  for (const [root, name] of [[SFTP_ROOT, "SimpleSFTP-Mac"], [EXPERIMENT_ROOT, "SimpleExperiment-Mac"]]) {
    if (run("git", ["status", "--porcelain"], root)) throw new Error(`${name} 在发布准备后工作树不再干净（如构建期文档压缩改写了计划文件）；请先审查压缩结果、提交后重新准备。`);
  }
  process.stdout.write(`Prepared immutable paired preview: ${directory}\n`);
}

// One callable source of truth for execution and review inventory. This function
// does not build or contact GitHub. A test completed by the successful build is
// counted in the inventory and skipped here so it executes only once.
function runValidationTests(execute, roots, nodeExecutable, alreadyRun = new Set()) {
  const EXPERIMENT_ROOT = roots.experiment, SFTP_ROOT = roots.sftp;
  const seen = new Set();
  function run(command, args, cwd, options) {
    const file = path.resolve(cwd, args[args.length - 1]);
    if (seen.has(file)) throw new Error("Duplicate release regression: " + file);
    seen.add(file);
    if (!alreadyRun.has(file)) return execute(command, args, cwd, options);
  }
  const files = ["macSchedulerGpuTabs", "tmuxGpuSessionClose", "tmuxClearTaskTabs", "tmuxTaskTabClose", "abortSchedulerStopRouting", "planStopClear", "macCacheCleanup", "simpleSftpIntegrationPreflight", "commandPaletteClarity", "macVsix", "macPreviewRelease", "macUpdateTransaction", "macBootstrap", "macCliLauncher", "macCliApi", "macCliWorkflow", "macWorkflowBinding", "macPlanIdentity", "macPlanFiles", "macAgentPlanIdentity", "macPlanLaunchPaths", "macResultIdentity", "macResultSummaryScope", "macMappedResultIdentity", "macResultFiles", "macLocalMetricParsing", "macResultOperationScope", "wrapperResultPersistence", "pendingResultMetricSync", "metricsDownloadEndToEnd", "resultsSummaryWebviewCache", "macResultCandidates", "macPlanResultCandidates", "jsonConfigOnboarding", "projectResultLocationClarity", "backendOutputDerivationCaches", "outputCandidateDedupRegression", "planScopedResultCandidateCache", "planSelectionPreviewAndWorkerEmptyState", "planOutputEvidenceSignals", "projectResultTables", "manualDistributedResultSync", "projectResultSyncCompleteness", "remoteResultInspectionWorkflow", "resultCsvDirectoryConfig", "datasetResultCatalog", "distributedPlanExecutionMode", "planRunModeWorkflow", "distributedProjectContract", "distributedPlanQueue", "distributedJobAutoRetry", "planSafeRetry", "distributedPlanSubmissionRouting", "planSubmissionVisiblePreflight", "macUpdateGate", "macUpdatePanel", "macHostLeasePaths", "macSetupGuide", "macPanelTheme", "macManualTunnel", "macProjectPrepare", "macPosixPaths", "topologyMode"];
  for (const file of files) run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", `test/features/${file}.test.js`], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macAgentOutputContract.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macAgentResultFiles.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macAgentParseResults.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macArchiveEvidenceRead.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macProjectAggregateRead.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macClaimEvidenceRead.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macPlanAnalysisRead.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macCaseAnalysisRead.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/scripts/macPackageProjection.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/macUpdateLeaseRecovery.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  for (const file of ["sourceReaderLineEndings", "compactTargetModePlan", "macRelease", "macPreviewIndex"]) run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", `test/scripts/${file}.test.js`], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/core/workspacePathMapper.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  for (const file of ["macBootstrap", "macCliLauncher", "macCliApi", "publicBranding", "api", "workspacePathMapper", "workspaceIntegration", "macLeasePaths", "macAuthentication", "macRelay", "macPosixPaths", "macRelativePaths", "macDownloadScope", "apiUploadProgress", "macTransferExitProof", "macNativeAcceptanceRecovery", "transferRecovery", "transferSettlement"]) run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", `test/${file}.test.js`], SFTP_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/ui/cacheCleanupPanel.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/ui/tmuxOtherSessionsDisclosure.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  // Frozen Windows feature synchronization gates, serial and bounded like the native gates.
  for (const file of ["test/agent/failedAttemptQuarantine.test.js","test/agent/gpuJobIdentity.test.js","test/features/distributedSchedulingModes.test.js","test/features/failedJobRecovery.test.js","test/features/formalJobExecution.test.js","test/features/gpuSubmittedJobOwnership.test.js","test/features/idleGpuDispatchLifecycle.integration.test.js","test/features/jobUnavailable.test.js","test/features/mergedGpuWebviewCache.test.js","test/features/panelOvernightRecovery.test.js","test/features/panelStateProjection.test.js","test/features/planCleanup.test.js","test/features/planCleanupPanelBridge.test.js","test/features/planCleanupReconnect.test.js","test/features/planOutputRetention.test.js","test/features/planResultPathContract.test.js","test/features/planRunFreshness.test.js","test/features/preflightDispatchRejection.test.js","test/features/vsixRuntimeClosure.test.js","test/tunnel/gpuWorkerSnapshotRecovery.test.js","test/ui/executionCompactOverview.test.js","test/ui/extensionStatePost.test.js","test/ui/gpuMissingServerRows.test.js","test/ui/gpuOwnerMatching.test.js","test/ui/jobTmuxLogNavigation.test.js","test/ui/jobUnavailable.test.js","test/ui/resultCommandPhaseRouting.test.js","test/scripts/runtimeVersionHeader.test.js"]) run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", file], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/cleanupFiles.test.js"], SFTP_ROOT, { inherit: true, timeout: 20000 });
  // Additional frozen Windows 7bb96599 / SFTP ed75a5d regressions.
  for (const file of ["test/features/macFormalIdentity.test.js","test/features/formalIdentityTmux.test.js","test/features/executionShellEnvironment.test.js","test/features/executionShellPreflight.test.js","test/features/formalJobPreflightProgress.test.js","test/features/failedJobCleanup.test.js","test/features/completedPlanWorkerMirror.test.js","test/features/formalJobPreflightApi.test.js","test/features/formalJobStop.test.js","test/features/formalJobRejectedRecovery.test.js","test/features/formalJobPreflightFailure.test.js","test/features/manualOnlyResultSync.test.js","test/features/distributedQueueStartup.test.js","test/features/distributedRerunAndWorkerDelta.test.js","test/features/planArtifactSyncStatus.test.js","test/features/prequeueRecallLifecycle.test.js","test/agent/prequeueRecall.test.js"]) run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", file], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  for (const file of ["test/formalJobCleanupOwner.test.js", "test/pairedUpdateDrain.test.js"]) run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", file], SFTP_ROOT, { inherit: true, timeout: 20000 });
  // 079 lifecycle/sync/download regressions plus the new OpenSSH/delete/auth gates, serial like every other entry.
  for (const file of ["test/api/localApi.test.js","test/features/extensionUpdates.test.js","test/features/macOpenSshTunnels.test.js","test/features/macSyncDelete.test.js","test/features/panelWebviewScriptHealth.test.js","test/features/stopRoutingAndResultParseDedup.test.js","test/tunnel/noDirectSsh.test.js","test/sshAndGpuUi.test.js"]) run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", file], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  for (const file of ["test/compressedWorkerBatch.test.js","test/compressionNegotiation.test.js","test/installPolicy.test.js","test/mappedBatchDownload.test.js","test/macTunnelAuthBridge.test.js","test/packedSyncProgress.test.js","test/serverToServerSync.test.js"]) run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", file], SFTP_ROOT, { inherit: true, timeout: 20000 });
  for (const file of ["test/features/macResultPlanDirectoryKey.test.js", "test/features/serverQueueLifecycle.integration.test.js", "test/agent/durablePlanQueue.test.js", "test/features/metricAliasRebuildWorkflow.test.js", "test/features/syncResolution.test.js"])
    run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", file], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  // 083 reverse-impact regressions for strict POSIX launch paths and current runtime dependencies.
  for (const file of ["test/agent/failureStopPolicy.test.js", "test/agent/idleGpuDurableAdmission.test.js", "test/agent/schedulerAvailabilityRuntime.test.js", "test/agent/schedulerOriginalError.test.js", "test/agent/serverPlanQueue.test.js", "test/features/schedulerConfigRendering.test.js", "test/features/schedulerDependencyPreflight.test.js"])
    run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", file], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/transferErrors.test.js"], SFTP_ROOT, { inherit: true, timeout: 20000 });
  // Native Windows publication recovery and shared lease obligations must remain in the release inventory.
  for (const file of ["test/features/projectResultPublication.test.js", "test/core/hostOperationLease.test.js", "test/core/resourceLeaseCompatibility.test.js"])
    run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", file], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/hostOperationLease.test.js"], SFTP_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/panelBuildManifest.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/features/panelBuildIdentity.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  // Frozen .403/.107 reverse-impact inventory, plus the full companion suite.
  // This list contains only additions to the original gates; run() rejects duplicates.
  for (const row of require("./mac-release-regressions.json")) {
    if (!["experiment", "sftp"].includes(row.component) || !/^test\/[^\\:]+\.test\.js$/.test(row.file)
      || row.file.split("/").includes("..")) throw new Error("Unsafe release regression path");
    run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", row.file],
      row.component === "experiment" ? EXPERIMENT_ROOT : SFTP_ROOT, { inherit: true, timeout: 20000 });
  }
}

function getReleaseValidationInventory(roots = { experiment: EXPERIMENT_ROOT, sftp: SFTP_ROOT }) {
  const inventory = [];
  runValidationTests((command, args, cwd, options) => inventory.push({ command, args, cwd, timeout: options.timeout,
    file: path.resolve(cwd, args[args.length - 1]) }), roots, process.execPath);
  return inventory;
}

/** Pure, network-free release-notes builder. The template literal below must
 * never contain a raw backtick: an unescaped one silently closes the template
 * early and turns the rest into template-subtraction expressions. SSH option
 * names are therefore written without backticks. */
function buildReleaseNotes(commits, versions) {
  return `Apple Silicon macOS 26 及以上 preview。

本版变化
新增机器级GPU单源采集与请求绑定准入、项目/程序/机器状态/产物四根保护、独立隔离重跑审核与批次账本，精确busy拒绝及系统Python解析修复。Mac保留精确POSIX身份与合法尾空格；冷构建从已跟踪源码生成checksum，用户模板不依赖随包文档。
同步 Windows Experiment 0.5.403/c30d607f1b63d224e8a65ab94371d86b4dd81c0d 及 SFTP 0.2.107/fc962236210ca692397dd58eefbefd0bf108f85a，采用正式任务身份/精确停止、进度与真实shell预检、人工拒绝恢复、失败job审核、全部正式Plan成功后的Worker镜像及更新等待优化。批次、平台边界与提交矩阵见docs/windows-alignment-2026-10-24.md。另修复隧道 -L 改按 ssh -G 单源判定、隧道生命周期身份/nonce与kill/取消只报告已验证事实、同步范围整树冻结与写前复查、macOS尾空格Plan文件选择及workflow工作区严格POSIX身份。保留Mac独立身份/preview静态索引/Termius手动端点/POSIX/认证/本机中转/共享租约/GPU内部标签，未复制Windows发布或自动部署。
正式任务身份通过独立shell传递，清除继承的其他job环境与Agent token；停止只针对原command绑定Pane，不关闭共享GPU容器。正式控制无需attempt；历史attempt只读，现有任务不迁移。Worker缺匹配正式身份/停止/环境预检能力时明确拒绝新控制。
启动前预检只按真实资产进度延长等待，重复阶段心跳/停滞/计数倒退/坏JSON/取消都拒绝并保留neverStarted回执。预检和执行使用同一配置shell/解释器，缺环境先失败。tasks.preflight、tasks.preflight.status、tasks.preflight.cancel仅诊断原失败job，不训练或改队列；environmentOnly只检查原环境，调用前须读discovery和live capabilities。
失败卡片“重新排队此 job”遇占用输出可进入“审核遗留文件”。只读预览冻结workflow/index/command，只处理独占正式目录和声明CSV，经完整终态owner及SHA核验。归档batch纳入不可变摘要/精确确认，CSV先于owner目录；成功同伴、PLAN和共享引用保留。全部节点完成后仍需返回原卡片人工确认重排，不自动清理或重跑。
全部正式Plan成功后通过SimpleSFTP在启用Worker间镜像其声明权重、日志、配置和CSV，冻结原run身份、路径、owner/hash，持久回执合并、重连只补缺项。失败/运行中/取消/不可用/恢复不完整/历史attempt不触发；活动writer、清理hold、来源身份或目标内容冲突均阻止覆盖。本机解析、汇总、归档及论文发布继续手动，原始指标不自动下载到本机。
更新门禁保留已有传输续租/验主，可取消更新等待且原传输继续。未知安装回执即使首项无完成记录也保持业务封锁；原批次/清单冻结，重载后仅提示用户点击补装，不自动安装。未完成入场ticket和存活/无法证明退出的持有者都要等待；本版配套最低要求SFTP Mac至少0.2.103；共同更新等待协议继续兼容已安装的0.2.102，以便正常升级本配套。
macOS清理已接入原生句柄证明及整树冻结；权限、ABI或句柄证据不完整时仍报HANDLE_CHECK_UNAVAILABLE并阻断。本轮未验证真机libproc或实际删除。永久删除两次完整路径确认、物理直接父目录与最短子项执行器不放宽。

本地验证
全部构建与验证在本机完成：两仓build、生成面板脚本及vm，发布门禁逐文件串行执行（每文件20秒上限、失败即停、完整日志留存），Windows派生回归与本轮隧道生命周期、映射下载、更新恢复门禁包含在内；测试仅在替身传输下运行，所有服务器API/传输/清理动作均为替身，没有科研训练。Windows PowerShell安装策略与真实Extension Host集成门禁由配套发布流程在真实Windows执行，其结果以该真实执行记录为准，本文件不代为宣称。macOS真机（M5）验收本轮未完成，本版本不宣称任何真机通过。历史失败日志与回执保留原样，旧结果不记为本版通过，本版以完整门禁日志为准。

M5 真机验证
本版本的隧道 ssh -G 单源探测、隧道生命周期诚实报告、同步整树冻结复查、尾空格Plan选择、workflow工作区POSIX身份、正式执行/预检/停止、完成Worker镜像、失败审核与更新恢复均未在M5真机执行，属发布后待验证项。用户既有 .309/.97 真机报告只覆盖旧版本，不构成本版本的真机验证。本轮没有连接生产服务器、启停现有任务、部署Agent、真实传输/清理、开发机安装或Actions操作。固定原目标清单仍整体paused；历史"18已验证/11剩余"仅为历史计数，不表示本版本验收完成。

安装与更新
从同一Release先安装SimpleSFTP Mac ${versions[0]}，再安装SimpleExperiment Mac ${versions[1]}并重载；首次过渡先等待本地传输完成，旧锁阻断时无需删锁，直接依次安装两份VSIX。以后点击底部Mac preview状态栏，或⇧⌘P“检查 preview 配套更新”，或面板“设置 → 插件配套更新 → 检查更新”；发现新版点击更新并重载，未完成时点击“安装 preview 配套更新”补原批次。
插件更新不会部署远端Agent。任务空闲后用户主动通过“准备项目与 Agent”核对/确认上传，再在Termius手动处理并检测；不要为验证新runtime中断现有实验。

源码提交
SimpleSFTP-Mac ${commits[0]}
SimpleExperiment-Mac ${commits[1]}
`;
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { main, buildReleaseNotes, runValidationTests, getReleaseValidationInventory };
