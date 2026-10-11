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
修复P4旧更新租约恢复：新更新窗口使用宿主/PID身份；精确旧Mac更新UUID记录只有在过期且ESRCH证明退出时才兼容恢复，包括被旧固定恢复槽阻塞的情况。活跃持有者、EPERM、未知身份和未过期记录继续保护，不删除用户锁记录。
修复P3恢复入口：只提供原operationId/operationInstanceId时，优先使用持久化精确目标并重新验证原requestKey；缺目标明确要求retryMethod/retryParams/requestKey，不能猜配置或重放。中转诊断等全部SSH关闭再报告来源/目标退出码、信号及stream阶段，避免冻结目标undefined。原真实中转失败根因尚未查明，退出证明不表示文件已传成功。
保留.310/.98的用户前缀识别及GPU任务展示修复。当前用户GPU按设置前缀与物理编号归属，任务标签显示在GPU内部，历史会话及未绑定窗口统一折叠，保留手动查看入口。新run-plan调度使用固定GPU容器的独立内部标签，不再每Plan创建sch-run-plan会话；CPU Hub使用一个固定control容器。停止绑定稳定Pane与PID启动身份，保留共享GPU和其他任务，旧记录保持兼容，不迁移或自动关闭。GPU任务建标签失败不再另建独立任务会话。
SimpleSFTP Mac修复取消安全认证输入后仍重复询问；上传先只读认证，中转先分别认证两端再获取清单，失败标明来源/目标。旧upload.files阻塞可按正式reconcile核实本机及精确目标退出并持久化回执；新的两次路径已确认请求才恢复同目标旧记录。证明不全仍保留保护，不重放旧上传、不把退出证明当上传成功。没有放宽SSH认证或使用Termius私有凭据。

本地验证
两仓build、227/26模块依赖闭包、面板脚本及逐文件串行20秒目标门禁。隔离编译Python函数的GPU标签/Hub控制容器/未知GPU拒绝/跨用户拒绝/稳定Pane与PID启动身份通过，Python子进程10秒上限，未加载完整Agent或调度模块。实际JS消费者覆盖身份变化、重复关闭、部分失败、安全输入取消、两端认证前置、旧单文件上传严格退出证明、持久化失败继续阻塞与只读认证取消退出；保留流式中转/更新/Plan/结果/租约等回归。不执行真实科研、SSH、远端任务启停/删除、Agent部署或开发机扩展安装。

M5 真机验证
用户2026-10-11两份报告实际仍为.309/.97：M5/24GB/macOS27/VSCode1.141，无服务器最小启动、四个更新入口、网络失败正确显示及恢复检查通过；Termius手动端点、密码工作区传输、中文空格%20文件哈希及SecretStorage有部分证据。C11两插件真实重叠写入保护/首项完成后主动重试通过。P4尝试.310/.98但被旧租约拒绝，没有安装任何组件；P3第二轮失败仍未结算。新.310/.98及.311/.99修复仍待M5复验。实际在线安装/重载/补装、完整密钥/ssh-agent及三拓扑科研未验；独立Agent版本按钮曾客户端超时，缺最终回执仍待验。私钥口令未知、系统agent与独立终端SSH均被服务器拒绝，不能宣称服务器认证问题已修好。原方案18已验证、剩余11/29。

首次安装与更新
先安装SimpleSFTP Mac，再安装SimpleExperiment Mac。旧版若仍被P4阻塞，等本地传输完成后从本Release下载两份VSIX，在扩展页“从VSIX安装”依次安装SimpleSFTP 0.2.99、SimpleExperiment 0.5.311并重载；旧代码无法靠检查按钮安装自身修复，无需删除锁。以后点击底部右侧Mac preview状态栏，按⇧⌘P运行“检查 preview 配套更新”，或在面板“设置 → 插件配套更新”点击“检查更新”，发现新版点击“更新并重载”。用户识别与展示修复在插件更新后生效；调度创建规则属于远端Agent runtime，须任务空闲后由用户主动通过“准备项目与 Agent”确认更新并在Termius处理，旧Agent仍按旧实现运行。此次发布不更新任何现有Agent、不迁移或停止现有任务；不要为验证新版中断正在运行的实验。只有preview，无Actions，无开发机安装。

源码提交
SimpleSFTP-Mac ${commits[0]}
SimpleExperiment-Mac ${commits[1]}
`;
  fs.writeFileSync(path.join(directory, "release-notes.md"), notes, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Prepared immutable paired preview: ${directory}\n`);
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { main };
