const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const readme = fs.readFileSync(path.join(__dirname, "../../README.md"), "utf8");
const legacyNotes = fs.readFileSync(path.join(__dirname, "../../docs/technical-notes.md"), "utf8");
const guide = fs.readFileSync(path.join(__dirname, "../../docs/simple-experiment-setup.md"), "utf8");

function loadHelpers() {
  const start = source.indexOf("const PROJECT_REMOTE_PATH_CONFIRMATIONS_PATH");
  const end = source.indexOf("function normalizeCodeSyncState", start);
  assert.ok(start > 0 && end > start, "remote path confirmation helpers missing");
  const sandbox = {
    fs: {
      readFile: fs.promises.readFile,
      writeFile: fs.promises.writeFile,
      mkdir: fs.promises.mkdir,
      unlink: fs.promises.unlink,
    },
    path,
    normalizeRemoteWorkRoot(value) {
      const text = String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/");
      return text && text !== "/" ? text.replace(/\/+$/, "") : undefined;
    },
    uniqueStrings(values) {
      return [...new Set(values.filter(Boolean))];
    },
    writeAtomicPluginStateJson: async (file, value) => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end) + "\nthis.api = { PROJECT_REMOTE_PATH_CONFIRMATIONS_PATH, normalizeRemoteWriteTargets, mergeRemotePathConfirmations, remoteWriteTargetsConfirmed, remoteWriteConfirmationDetail, agentStartupWriteConfirmationDetail, codeSyncConfirmationLabel, readProjectRemotePathConfirmationsState, writeProjectRemotePathConfirmationsState };", sandbox);
  return sandbox.api;
}

test("remote path confirmation state is project-local and keyed by all expected locations", async () => {
  const helpers = loadHelpers();
  assert.equal(helpers.PROJECT_REMOTE_PATH_CONFIRMATIONS_PATH, "simple_cluster/ui/remote_path_confirmations.json");
  const base = {
    id: "hub",
    role: "hub",
    label: "Hub",
    host: "EXAMPLE.COM",
    user: "alice",
    port: 22,
    remotePath: "/srv/simple_agent/simple_cluster/runtime/",
    expectedFiles: ["/srv/simple_agent/simple_cluster/runtime/cluster_agent.py"],
    relatedLocations: [{ label: "Agent 项目工作目录", path: "/srv/projects/demo" }],
    confirmedAt: "2026-07-17T00:00:00.000Z",
  };
  const first = helpers.normalizeRemoteWriteTargets([base])[0];
  const changedProject = helpers.normalizeRemoteWriteTargets([{ ...base, relatedLocations: [{ label: "Agent 项目工作目录", path: "/srv/projects/other" }] }])[0];
  assert.notEqual(first.key, changedProject.key);
  assert.match(first.key, /alice@example\.com:22/);
  assert.equal(helpers.remoteWriteTargetsConfirmed([base], [base]), true);
  assert.equal(helpers.remoteWriteTargetsConfirmed([base], [{ ...base, remotePath: "/srv/other" }]), false);
  assert.equal(helpers.remoteWriteTargetsConfirmed([], [base]), false);

  const reusableInput = [base];
  const reusable = helpers.normalizeRemoteWriteTargets(reusableInput);
  assert.equal(helpers.normalizeRemoteWriteTargets(reusableInput), reusable);
  assert.equal(helpers.normalizeRemoteWriteTargets(reusable), reusable);
  assert.notEqual(helpers.normalizeRemoteWriteTargets([...reusableInput]), reusable);
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.normalizeRemoteWriteTargets(undefined))), []);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-path-confirm-"));
  await helpers.writeProjectRemotePathConfirmationsState(root, [base]);
  const file = path.join(root, "simple_cluster", "ui", "remote_path_confirmations.json");
  assert.equal(fs.existsSync(file), true);
  const loaded = await helpers.readProjectRemotePathConfirmationsState(root);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].remotePath, "/srv/simple_agent/simple_cluster/runtime");
  assert.equal(loaded[0].relatedLocations[0].path, "/srv/projects/demo");
  await helpers.writeProjectRemotePathConfirmationsState(root, []);
  assert.equal(fs.existsSync(file), true);
  assert.equal((await helpers.readProjectRemotePathConfirmationsState(root)).length, 0);
});

test("strong confirmation text shows expected directories and files", () => {
  const helpers = loadHelpers();
  const detail = helpers.remoteWriteConfirmationDetail("上传 Agent runtime", [{
    id: "worker-a",
    role: "worker",
    label: "Worker A",
    host: "10.0.0.8",
    user: "alice",
    port: 22,
    remotePath: "/srv/simple_agent/simple_cluster/runtime",
    expectedFiles: ["/srv/simple_agent/simple_cluster/runtime/cluster_agent.py"],
    expectedFileCount: 3,
    relatedLocations: [{ label: "Agent 项目工作目录", path: "/srv/projects/demo" }],
  }], "D:/projects/demo");
  assert.match(detail, /【强制路径确认】上传 Agent runtime/);
  assert.match(detail, /本地项目目录：D:\/projects\/demo/);
  assert.match(detail, /alice@10\.0\.0\.8:22/);
  assert.match(detail, /预期远端目录：\/srv\/simple_agent\/simple_cluster\/runtime/);
  assert.match(detail, /预期远端文件位置（已列 1 \/ 共 3）：/);
  assert.match(detail, /- \/srv\/simple_agent\/simple_cluster\/runtime\/cluster_agent\.py/);
  assert.match(detail, /Agent 项目工作目录：\/srv\/projects\/demo/);
  assert.match(detail, /其余 2 个预期文件均位于上述远端目录内/);
  assert.equal(helpers.codeSyncConfirmationLabel("run"), "提交实验前上传 Hub/Worker 项目代码");
});

test("Agent startup strong confirmation always shows local and remote file locations", () => {
  const helpers = loadHelpers();
  const startupTargets = [{ id: "hub", filePath: "C:/Sessions/hub.xsh" }];
  const runtimeTargets = [{
    id: "hub",
    role: "hub",
    label: "Hub",
    host: "10.0.0.7",
    user: "alice",
    port: 22,
    remotePath: "/srv/simple_agent/simple_cluster/runtime",
    expectedFiles: ["/srv/simple_agent/simple_cluster/runtime/cluster_agent.py"],
    relatedLocations: [{ label: "Agent 项目工作目录", path: "/srv/projects/demo" }],
  }];
  const prepare = helpers.agentStartupWriteConfirmationDetail(startupTargets, runtimeTargets, true);
  assert.match(prepare, /【强制确认】准备 Agent 并启动/);
  assert.match(prepare, /hub 会话：C:\/Sessions\/hub\.xsh/);
  assert.match(prepare, /hub 固定备份：C:\/Sessions\/hub\.xsh\.simple-backup/);
  assert.match(prepare, /预期上传的远端文件位置：/);
  assert.match(prepare, /\/srv\/simple_agent\/simple_cluster\/runtime\/cluster_agent\.py/);
  assert.match(prepare, /Agent 项目工作目录：\/srv\/projects\/demo/);

  const writeOnly = helpers.agentStartupWriteConfirmationDetail(startupTargets, runtimeTargets, false);
  assert.match(writeOnly, /【强制确认】写入 Agent 自启动路径/);
  assert.match(writeOnly, /本操作不上传/);
  assert.match(writeOnly, /只写入上述本地 \.xsh 及固定备份/);
});

test("all SimpleExperiment SFTP write paths pass through the strong confirmation gate", () => {
  const preparation = source.slice(source.indexOf("async prepareAgentsForFirstRun"), source.indexOf("async configureXshellRealtimeTunnel"));
  const startup = source.slice(source.indexOf("async writeXshellAgentStartupCommands"), source.indexOf("async startAllXshellConnections"));
  const deploy = source.slice(source.indexOf("async deployLatestAgentRuntime"), source.indexOf("    agentRuntimeDeployTargets() {"));
  const downloadScope = source.slice(source.indexOf("async configureDownloadScope"), source.indexOf("async ensureCodeReadyForRun"));
  const sync = source.slice(source.indexOf("async syncCodeTargets"), source.indexOf("async confirmRemoteWriteTargets"));
  const confirm = source.slice(source.indexOf("async confirmRemoteWriteTargets"), source.indexOf("async prepareSftpTargets"));
  const prepareSftp = source.slice(source.indexOf("async prepareSftpTargets"), source.indexOf("    sftpServerOptions"));

  assert.ok(preparation.indexOf("confirmRemoteWriteTargets") < preparation.indexOf("writeXshellAgentStartupCommands"));
  assert.match(preparation, /deployLatestAgentRuntime\(false, true, \[\], true\)/);
  assert.ok(startup.indexOf("confirmRemoteWriteTargets") < startup.indexOf("updateXshellSessionLoginCommand"));
  assert.match(startup, /写入 Agent 自启动路径/);
  assert.match(startup, /agentStartupWriteConfirmationDetail\(targets, runtimeTargets, false\)/);
  assert.match(preparation, /agentStartupWriteConfirmationDetail\(targets, runtimeTargets, true\)/);
  assert.ok(deploy.indexOf("confirmRemoteWriteTargets") < deploy.indexOf('executeCommand("simpleSftp.uploadFiles"'));
  assert.ok(downloadScope.indexOf("confirmRemoteWriteTargets") < downloadScope.indexOf('executeCommand("simpleSftp.configureDownloadScope"'));
  assert.ok(sync.indexOf("confirmRemoteWriteTargets") < sync.indexOf('executeCommand("simpleSftp.uploadWorkspace"'));
  assert.match(confirm, /showWarningMessage\(remoteWriteConfirmationDetail\(operation, normalized, localProjectRoot\), \{ modal: true \}/);
  assert.match(confirm, /assertSingleProjectWorkspace\(operation\)/);
  assert.match(prepareSftp, /assertSingleProjectWorkspace\("SFTP 上传或目录配置"\)/);
  assert.match(confirm, /"确认位置并继续"/);
  assert.match(confirm, /"确认，此后不再提醒该路径"/);
  assert.match(confirm, /persistProjectRemotePathConfirmationsState\(\)/);
  assert.match(prepareSftp, /assertSingleProjectWorkspace\("SFTP 上传或目录配置"\)[\s\S]{0,180}ensureSimpleSftpReadyForSetup\("文件传输"\)/);
  assert.match(source, /loadProjectRemotePathConfirmationsState\(\)\.catch\(\(\) => undefined\)/);
  assert.equal([...source.matchAll(/executeCommand\("simpleSftp\.(?:uploadWorkspace|uploadFiles)"/g)].length, 6);
  assert.equal([...source.matchAll(/executeCommand\("simpleSftp\.configureDownloadScope"/g)].length, 1);
  assert.match(legacyNotes, /所有由 SimpleExperiment 发起的项目代码和 Agent runtime SFTP 上传都会先经过强制路径确认窗口/);
  assert.match(legacyNotes, /simple_cluster\/ui\/remote_path_confirmations\.json/);
  assert.match(legacyNotes, /取消窗口不会上传远端文件，也不会留下运行中状态/);
});

test("path confirmation precedes profile writes and upload-start state", () => {
  const preparation = source.slice(source.indexOf("async prepareAgentsForFirstRun"), source.indexOf("async configureXshellRealtimeTunnel"));
  const deploy = source.slice(source.indexOf("async deployLatestAgentRuntime"), source.indexOf("    agentRuntimeDeployTargets() {"));
  const downloadScope = source.slice(source.indexOf("async configureDownloadScope"), source.indexOf("async ensureCodeReadyForRun"));
  const sync = source.slice(source.indexOf("async syncCodeTargets"), source.indexOf("async confirmRemoteWriteTargets"));
  const prepareSftp = source.slice(source.indexOf("async prepareSftpTargets"), source.indexOf("    sftpServerOptions"));

  assert.ok(preparation.indexOf("confirmRemoteWriteTargets") < preparation.indexOf("writeSftpManagerServerProfiles("));
  assert.ok(deploy.indexOf("confirmRemoteWriteTargets") < deploy.indexOf("writeSftpManagerServerProfiles("));
  assert.ok(deploy.indexOf("writeSftpManagerServerProfiles(") < deploy.indexOf('executeCommand("simpleSftp.uploadFiles"'));
  assert.ok(downloadScope.indexOf("confirmRemoteWriteTargets") < downloadScope.indexOf("writeSftpManagerServerProfiles("));
  assert.ok(downloadScope.indexOf("writeSftpManagerServerProfiles(") < downloadScope.indexOf('executeCommand("simpleSftp.configureDownloadScope"'));
  assert.ok(sync.indexOf("confirmRemoteWriteTargets") < sync.indexOf("writeSftpManagerServerProfiles("));
  assert.ok(sync.indexOf("writeSftpManagerServerProfiles(") < sync.indexOf("notifyLocalActionStarted"));
  assert.ok(sync.indexOf("notifyLocalActionStarted") < sync.indexOf('executeCommand("simpleSftp.uploadWorkspace"'));
  assert.doesNotMatch(prepareSftp, /writeSftpManagerServerProfiles/);
  assert.ok(prepareSftp.indexOf('ensureSimpleSftpReadyForSetup("文件传输")') < prepareSftp.indexOf("ensureSftpManagerCommand"));
  assert.doesNotMatch(prepareSftp, /syncXshellConfigBeforeNetwork|writeSftpManagerServerProfiles/);
  assert.ok(prepareSftp.indexOf("ensureSftpManagerCommand") < prepareSftp.indexOf("assertTopologyActualWorkRoots"));
  assert.match(source, /writeSftpManagerServerProfiles\(targetIds\)[\s\S]{0,300}requestedIds\.has\(target\.id\)/);
  assert.match(legacyNotes, /操作确认前不会更新对应 SimpleSFTP 共享目标或显示上传已开始/);
  assert.match(legacyNotes, /操作确认前不会更新对应 SimpleSFTP 共享目标、修改 `\.xsh` 或显示上传已开始/);
});

test("remembered remote paths can be reset from project settings", () => {
  assert.match(source, /this\.confirmedRemotePaths = mergeRemotePathConfirmations\(/);
  assert.match(source, /REMOTE_PATH_CONFIRMATIONS_WORKSPACE_KEY = "simpleExperiment\.remotePathConfirmations"/);
  assert.match(source, /mergeRemotePathConfirmations\(\s*loaded\.value,\s*this\.context\.workspaceState\.get\(REMOTE_PATH_CONFIRMATIONS_WORKSPACE_KEY, \[\]\),\s*\)/);
  assert.match(source, /await this\.context\.workspaceState\.update\(\s*REMOTE_PATH_CONFIRMATIONS_WORKSPACE_KEY,\s*mergeRemotePathConfirmations\(this\.confirmedRemotePaths\),\s*\)/);
  assert.match(source, /remotePathConfirmations: \{\s*count: this\.confirmedRemotePaths\.length/);
  assert.match(source, /case "resetRemotePathConfirmations":\s*await this\.resetRemotePathConfirmationsFromUi\(\)/);
  assert.match(source, /async resetRemotePathConfirmationsFromUi\(\)/);
  const reset = source.match(/async resetRemotePathConfirmationsFromUi\(\)[\s\S]*?async loadProjectLocalOperationsState/)?.[0] || "";
  assert.match(reset, /const root = assertSingleProjectWorkspace\("恢复上传路径提醒"\)/);
  assert.match(reset, /const generation = this\.projectContextGeneration/);
  assert.ok([...reset.matchAll(/generation !== this\.projectContextGeneration \|\| root !== workspaceRoot\(\)/g)].length >= 3);
  assert.match(source, /this\.confirmedRemotePaths = \[\];\s*await this\.persistProjectRemotePathConfirmationsState\(\);\s*await this\.context\.workspaceState\.update\(REMOTE_PATH_CONFIRMATIONS_WORKSPACE_KEY, undefined\)/);
  assert.match(source, /服务器配置、SimpleSFTP 配置和远端文件不会改变/);
  assert.match(panel, /data-anchor="settings-path-confirmations"/);
  assert.match(panel, /当前项目状态文件/);
  assert.match(panel, /data-command="resetRemotePathConfirmations"/);
  assert.match(panel, /当前项目已记住/);
  assert.match(panel, />恢复提醒<\/button>/);
  assert.match(legacyNotes, /上传路径提醒.*恢复提醒/);
  assert.match(legacyNotes, /设置 -> 服务器.*恢复提醒/);
});
