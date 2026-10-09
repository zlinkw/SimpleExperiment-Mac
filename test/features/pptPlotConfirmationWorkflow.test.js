const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const bridge = readSource("src/PptPlotBridge.ts");

function loadHelpers() {
  const start = source.indexOf("const PROJECT_PPT_PATH_CONFIRMATIONS_PATH");
  const end = source.indexOf("const PROJECT_UI_LAYOUT_PATH", start);
  assert.ok(start > 0 && end > start, "PPT path confirmation helpers missing");
  const sandbox = {
    fs: {
      readFile: fs.promises.readFile,
      writeFile: fs.promises.writeFile,
      mkdir: fs.promises.mkdir,
      unlink: fs.promises.unlink,
    },
    path,
    process,
    uniqueStrings(values) { return [...new Set(values.filter(Boolean))]; },
    writeAtomicPluginStateJson: async (file, value) => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end) + "\nthis.api = { PROJECT_PPT_PATH_CONFIRMATIONS_PATH, PPT_PLOT_REQUEST_AUDIT_DIR, PPT_CHART_TYPE_LABELS, PPT_STYLE_MODE_LABELS, normalizePptPathConfirmationTarget, mergePptPathConfirmations, pptPathTargetConfirmed, pptPlotConfirmationDetail, pptPlotAuditRelativePath, readProjectPptPathConfirmationsState, writeProjectPptPathConfirmationsState };", sandbox);
  return sandbox.api;
}

test("PPT target confirmations are project-local, path-specific, and resettable", async () => {
  const helpers = loadHelpers();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-ppt-confirm-"));
  const first = helpers.normalizePptPathConfirmationTarget("slides/results.pptx", root);
  const same = helpers.normalizePptPathConfirmationTarget("slides/results.pptx", root);
  const changed = helpers.normalizePptPathConfirmationTarget("slides/other.pptx", root);
  assert.equal(helpers.PROJECT_PPT_PATH_CONFIRMATIONS_PATH, "simple_cluster/ui/ppt_path_confirmations.json");
  assert.equal(helpers.PPT_PLOT_REQUEST_AUDIT_DIR, "simple_cluster/results/ppt_plot_requests");
  assert.equal(first.key, same.key);
  assert.notEqual(first.key, changed.key);
  assert.equal(helpers.pptPathTargetConfirmed([first], same), true);
  assert.equal(helpers.pptPathTargetConfirmed([first], changed), false);

  await helpers.writeProjectPptPathConfirmationsState(root, [{ ...first, confirmedAt: "2026-07-19T00:00:00.000Z" }]);
  const file = path.join(root, "simple_cluster", "ui", "ppt_path_confirmations.json");
  assert.equal(fs.existsSync(file), true);
  const loaded = await helpers.readProjectPptPathConfirmationsState(root);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].key, first.key);
  await helpers.writeProjectPptPathConfirmationsState(root, []);
  assert.equal(fs.existsSync(file), true);
  assert.equal((await helpers.readProjectPptPathConfirmationsState(root)).length, 0);
});

test("PPT confirmation shows plan revision, final sources, contract, and target", () => {
  const helpers = loadHelpers();
  const detail = helpers.pptPlotConfirmationDetail({
    projectRoot: "D:/projects/demo",
    planFile: "experiments/plans/smoke.yaml",
    planRevision: "rev-7",
    sourcePaths: ["simple_cluster/results/by_plan/smoke/statistics.json"],
    plottingContractPath: "simple_cluster/results/by_plan/smoke/plotting_contract.json",
    chartType: "meanStdErrorBar",
    styleMode: "activePpt",
  }, helpers.normalizePptPathConfirmationTarget("D:/slides/results.pptx", "D:/projects/demo"));
  assert.match(detail, /【强制确认】绘图到 PPT/);
  assert.match(detail, /当前 Plan：experiments\/plans\/smoke\.yaml/);
  assert.match(detail, /Plan revision：rev-7/);
  assert.match(detail, /simple_cluster\/results\/by_plan\/smoke\/statistics\.json/);
  assert.match(detail, /PPT 绘图契约：simple_cluster\/results\/by_plan\/smoke\/plotting_contract\.json/);
  assert.match(detail, /目标 PPT：/);
  assert.match(detail, /本地请求审计目录：.*simple_cluster[\\/]results[\\/]ppt_plot_requests/);
  assert.match(detail, /执行绘图请求时会在上述目录写入轻量 JSON 请求和响应审计/);
  assert.match(detail, /取消不会创建请求审计或调用 PPT 插件/);
  assert.match(detail, /误差图/);
  assert.equal(helpers.PPT_CHART_TYPE_LABELS.meanStdErrorBar, "误差图");
  assert.equal(helpers.PPT_STYLE_MODE_LABELS.activePpt, "跟随当前 PPT");
  assert.match(source, /PPT_CHART_TYPE_LABELS\[chartType\] \|\| chartType/);
  assert.match(source, /PPT_STYLE_MODE_LABELS\[styleMode\] \|\| styleMode/);
  assert.match(panel, /PPT_CHART_TYPE_LABELS\[String\(value \|\| ""\)\]/);
  assert.match(panel, /PPT_STYLE_MODE_LABELS\[String\(value \|\| ""\)\]/);
  assert.match(bridge, /safeProjectPath\(projectRoot, "simple_cluster\/results\/ppt_plot_requests"\)/);
});

test("PPT success audit paths stay inside the current project", () => {
  const helpers = loadHelpers();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-ppt-audit-"));
  const request = path.join(root, "simple_cluster", "results", "ppt_plot_requests", "ppt-1.json");
  assert.equal(helpers.pptPlotAuditRelativePath(root, request), "simple_cluster/results/ppt_plot_requests/ppt-1.json");
  assert.throws(() => helpers.pptPlotAuditRelativePath(root, path.join(root, "..", "outside.json")), /不在当前项目内/);
});

test("plotting confirmation precedes PPT automation and keeps Debug blocked", () => {
  const handler = source.slice(source.indexOf("async plotResultsToPptFromUi"), source.indexOf("async saveProjectAdapterRulesFromUi"));
  assert.ok(handler.indexOf("confirmPptPlotTarget(input)") < handler.indexOf("new PptPlotBridge_1.PptPlotBridge().plot(input, signal)"));
  const confirmation = source.match(/async confirmPptPlotTarget\(input\)[\s\S]*?async plotResultsToPptFromUi/)?.[0] || "";
  assert.match(confirmation, /if \(target\.presentationPath\)\s*input\.presentationPath = target\.presentationPath/);
  assert.match(confirmation, /const generation = this\.projectContextGeneration/);
  assert.ok([...confirmation.matchAll(/generation !== this\.projectContextGeneration \|\| root !== workspaceRoot\(\)/g)].length >= 2);
  assert.match(confirmation, /if \(generation === this\.projectContextGeneration && root === workspaceRoot\(\)\)\s*this\.postState\(true\)/);
  assert.match(confirmation, /未调用 PPT 插件，也未写入绘图请求审计/);
  assert.match(handler, /打开请求审计/);
  assert.match(handler, /打开响应审计/);
  assert.match(handler, /pptPlotAuditRelativePath\(root, result\.requestPath\)/);
  assert.match(handler, /pptPlotAuditRelativePath\(root, result\.responsePath\)/);
  assert.match(handler, /openWorkspaceFile\(auditPath\)/);
  assert.match(handler, /const projectContext = this\.captureProjectContext\(\);[\s\S]*?const generation = projectContext\.generation/);
  assert.ok([...handler.matchAll(/generation !== this\.projectContextGeneration \|\| root !== workspaceRoot\(\)/g)].length >= 5);
  assert.match(handler, /\.then\(\(choice\) => \{\s*if \(generation !== this\.projectContextGeneration \|\| root !== workspaceRoot\(\)\)\s*return undefined/);
  assert.match(handler, /if \(generation === this\.projectContextGeneration && root === workspaceRoot\(\)\)\s*void vscode\.window\.showErrorMessage/);
  assert.match(source, /pptPathConfirmations: \{\s*count: this\.confirmedPptPaths\.length/);
  assert.match(source, /case "resetPptPathConfirmations":\s*await this\.resetPptPathConfirmationsFromUi\(\)/);
  const reset = source.match(/async resetPptPathConfirmationsFromUi\(\)[\s\S]*?async resetRemotePathConfirmationsFromUi/)?.[0] || "";
  assert.match(reset, /const root = assertSingleProjectWorkspace\("恢复 PPT 路径提醒"\)/);
  assert.match(reset, /const generation = this\.projectContextGeneration/);
  assert.ok([...reset.matchAll(/generation !== this\.projectContextGeneration \|\| root !== workspaceRoot\(\)/g)].length >= 3);
  assert.match(panel, /data-command="resetPptPathConfirmations"/);
  assert.match(panel, /section === "servers"[\s\S]*data\.remotePathConfirmations[\s\S]*data\.pptPathConfirmations/);
  assert.match(panel, /section === "settings"[\s\S]*data\.remotePathConfirmations[\s\S]*data\.pptPathConfirmations/);
  assert.match(panel, /const DEBUG_MODE_BLOCKED_UI_COMMANDS = new Set\([^;]*plotResultsToPpt/);
  assert.match(panel, /function debugModeBlockedUiCommand\(command\) \{\s*return DEBUG_MODE_BLOCKED_UI_COMMANDS\?\.has/);
});

test("PPT path dialogs cannot write stale project state", () => {
  const save = source.match(/async savePptPlotConfigFromUi\(message\)[\s\S]*?async choosePptPathFromUi/)?.[0] || "";
  assert.match(save, /const projectContext = this\.captureProjectContext\(\)/);
  assert.ok([...save.matchAll(/projectContextIsCurrent\(projectContext\)/g)].length >= 2);
  assert.match(save, /await this\.persistProjectPptPlotConfigState\(\);\s*if \(!this\.projectContextIsCurrent\(projectContext\)\)\s*return/);
  assert.match(save, /await this\.context\.globalState\.update\(keys\.pptPlotConfig, undefined\);\s*if \(!this\.projectContextIsCurrent\(projectContext\)\)\s*return/);
  const choose = source.match(/async choosePptPathFromUi\(\)[\s\S]*?async refreshPptAutomationReadiness/)?.[0] || "";
  assert.match(choose, /const generation = this\.projectContextGeneration/);
  assert.match(choose, /const root = workspaceRoot\(\)/);
  assert.ok([...choose.matchAll(/generation !== this\.projectContextGeneration \|\| root !== workspaceRoot\(\)/g)].length >= 2);
  const update = source.match(/async updatePptPresentationPath\(presentationPath\)[\s\S]*?async refreshPptAutomationReadiness/)?.[0] || "";
  assert.match(update, /const projectContext = this\.captureProjectContext\(\)/);
  assert.match(update, /await this\.persistProjectPptPlotConfigState\(\)/);
  assert.ok([...update.matchAll(/projectContextIsCurrent\(projectContext\)/g)].length >= 3);
  assert.match(update, /await this\.persistProjectPptPlotConfigState\(\);\s*if \(!this\.projectContextIsCurrent\(projectContext\)\)\s*return/);
  assert.match(update, /await this\.context\.globalState\.update\(keys\.pptPlotConfig, undefined\);\s*if \(!this\.projectContextIsCurrent\(projectContext\)\)\s*return/);
});
