"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { EXPERIMENT_ROOT, SFTP_ROOT, REPOSITORY, run, npm, json, fingerprint, assertSource } = require("./mac-release-common");
const { createPackageProjection, assertPackageProjection } = require("./mac-package-projection");

// 单文件宿主超时例外（用户 2026-10-27 明确批准，仅限下列一行）：
// test/agent/gpuCollectorFrame.test.js 在开发机上稳定耗时 20.96 秒（11/11 通过），
// 20 秒宿主上限会把它误判为超时；其余所有行仍是 20000 毫秒，禁止未经批准扩大本表。
const ROW_TIMEOUT_EXCEPTIONS = new Map([["experiment|test/agent/gpuCollectorFrame.test.js", 40000]]);
const rowTimeout = (component, file) => ROW_TIMEOUT_EXCEPTIONS.get(component + "|" + file) || 20000;
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
    // 跨仓用例（docs/unified-cli-coverage.md 前置条件）需要显式指向配套 SimpleSFTP Mac 检出根；未配置时按设计失败而非跳过。
    // 超时默认 20 秒；仅 ROW_TIMEOUT_EXCEPTIONS 里经用户批准的行可放宽，node --test 的用例内超时仍是 20000。
    run(nodeExecutable, ["--test", "--test-force-exit", "--test-timeout", "20000", row.file],
      row.component === "experiment" ? EXPERIMENT_ROOT : SFTP_ROOT,
      { inherit: true, timeout: rowTimeout(row.component, row.file), env: row.component === "experiment" ? { ...process.env, SIMPLE_TEST_SFTP_ROOT: path.resolve(SFTP_ROOT) } : undefined });
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
同步 Windows Experiment 0.5.416/45209ae43da37a0c4a2c9d82ca2aad88caef7b44 与 SimpleSFTP 0.2.114/b2329b5de8b1723d03d7470af8dbb0dad96898d5，只做 macOS 适配，未改动 Windows 侧仓库。
新增多项目分支与工作树登记、统一 CLI 命名动作面（只允许命名命令，无原始调用透传）、结果对比与 HEAD 核对、科研 PR 与祖先快进、缓存清理的 observe/isolate 批次与忙时整体拒绝、插件日志保留、查看操作完整日志入口。
配套 SimpleSFTP Mac 提供暂存槽两代保留与过期回收、一次确认提前释放、consumer root、本地暂存收敛、交接标记新位置与传输忙快照。
统一 CLI 的发现文件改走 Mac 身份目录与环境量（Mac 命令不会再连到 Windows 插件的 api.json），限流命中改为按已确证的延后时间提示并跨窗口持久化，不再当作检查失败。
macOS 清理沿用直接父目录核对、指纹复核、darwin 句柄证明与两次绝对路径确认；一键开启隧道与不依赖 Xshell 会话文件的约定保持不变。

本地验证
两仓构建、面板脚本与 vm 门禁、678 行源码指纹对冻结快照双向校验（Experiment 554、SimpleSFTP 124）、发布门禁逐文件串行执行（每文件 20 秒上限、失败即停、完整日志留存）。逐文件结果与因宿主契约移出宿主门禁的说明见 docs/windows-alignment-2026-10-27.md；文中的历史计数，不表示本版本验收完成。发布准备必须在 macOS 执行：门禁清单含只在 darwin 通过的 POSIX 路径校验、libproc 句柄与真实隧道用例，在 Windows 主机上无法全部通过。

M5 真机验证
未在M5真机执行：一键隧道的实际连通、libproc 句柄证明、darwin 中继与交接标记实际落点、真机删除与真机更新安装。本版本对这些内容不宣称任何真机通过。

安装与更新
从同一Release先安装SimpleSFTP Mac ${versions[0]}，再安装SimpleExperiment Mac ${versions[1]}并重载窗口；两者必须成对更新，单侧更新会被拒绝。
插件更新不会部署远端Agent。任务空闲后用户主动通过“准备项目与 Agent”核对/确认上传，插件不自动改写远端运行时。

源码提交
SimpleSFTP-Mac ${commits[0]}
SimpleExperiment-Mac ${commits[1]}
`;
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { main, buildReleaseNotes, runValidationTests, getReleaseValidationInventory, ROW_TIMEOUT_EXCEPTIONS };
