const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function bootstrapCompletion(options) {
  const sandbox = { HUB_READY_STATUSES: new Set(["ok", "file_api_unavailable", "agent_ok"]) };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(extension, "projectBootstrapEndpointReadiness"),
    extractFunction(extension, "projectBootstrapCompletion"),
    "this.check = projectBootstrapCompletion;",
  ].join("\n"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.check(options)));
}

function bootstrapPlanSelection(plans, planFileInput, selectedPlanId) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(extension, "projectBootstrapPlanSelection") + "\nthis.check = projectBootstrapPlanSelection;", sandbox);
  return JSON.parse(JSON.stringify(sandbox.check(plans, planFileInput, selectedPlanId)));
}

function projectOnboardingState(options) {
  const sandbox = {
    path: require("node:path"),
    EMPTY_PROJECT_ONBOARDING_SOURCE: Object.freeze({}),
    projectOnboardingStateForWebviewCache: new WeakMap(),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(extension, "serverSetupMissingItems"),
    extractFunction(extension, "initialServerSetupComplete"),
    extractFunction(extension, "projectOnboardingStateForWebview"),
    "this.check = projectOnboardingStateForWebview;",
  ].join("\n"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.check(options)));
}

test("project onboarding keeps staged actions and respects readiness order", () => {
  assert.match(extension, /function projectOnboardingStateForWebview\(options\)/);
  assert.match(extension, /const projectOnboarding = projectOnboardingStateForWebview\(\{/);
  assert.match(panel, /id="projectOnboardingNotice"/);
  assert.match(panel, /function renderProjectOnboardingNotice\(state\)/);
  assert.match(panel, /function renderProjectOnboardingFlow\(state, project, meta\)/);
  const flow = extractFunction(panel, "renderProjectOnboardingFlow");
  for (const step of ["1. 基础设施", "2. Plan 与输出", "3. Agent 连接", "4. 运行与监控", "5. 结果文件"]) {
    assert.match(flow, new RegExp(step));
  }
  assert.match(flow, /const activeIndex = stepSpecs\.findIndex\(\(step\) => !step\.ok\)/);
  assert.match(flow, /pending: activeIndex >= 0 && index > activeIndex/);
  assert.match(panel, /function renderPlanRunActions\(state, selectedPlan, outputReady, adapterConfig, runtimeContractStage\)/);
  assert.doesNotMatch(panel, /data-command="runPlan"[^>]*>运行<\/button>/);
});
test("configured single-project workspaces keep onboarding visible until explicitly completed", () => {
  const setup = {
    savedSessionPath: "C:/Sessions/hub.xsh",
    agentProjectDir: "/srv/projects",
    workerTunnels: [{
      id: "worker-a",
      savedSessionPath: "C:/Sessions/worker-a.xsh",
      agentProjectDir: "/srv/projects",
      enabled: true,
    }],
  };
  const workspace = { root: "D:/GitRepo/Demo", name: "Demo", singleProject: true };
  const pending = projectOnboardingState({ workspace, setup, simpleSftp: { ready: true }, promptShown: 0 });
  assert.equal(pending.required, true);
  assert.equal(pending.completed, false);
  assert.match(pending.detail, /Demo/);

  const completed = projectOnboardingState({ workspace, setup, simpleSftp: { ready: true }, completed: true, promptShown: 1 });
  assert.equal(completed.required, false);
  assert.equal(completed.completed, true);
  const dismissed = projectOnboardingState({ workspace, setup, simpleSftp: { ready: true }, promptShown: 1 });
  assert.equal(dismissed.required, true);
  assert.equal(dismissed.ready, true);
  const noWorkspace = projectOnboardingState({ workspace: { ...workspace, singleProject: false }, setup, simpleSftp: { ready: true }, promptShown: 0 });
  assert.equal(noWorkspace.required, false);
  const missingWorker = projectOnboardingState({ workspace, setup: { ...setup, workerTunnels: [] }, simpleSftp: { ready: true }, promptShown: 0 });
  assert.equal(missingWorker.required, true);
  assert.equal(missingWorker.blocked, true);
  assert.match(missingWorker.detail, /至少一个启用的执行 Worker/);
});

test("quick project onboarding completes safe Plan and output setup in one flow", () => {
  assert.match(extension, /case "bootstrapProject":\s*await this\.bootstrapProjectFromUi\(\)/);
  assert.match(extension, /async bootstrapProjectFromUi\(\)/);
  assert.match(extension, /async pickProjectBootstrapPlan\(plans\)/);
  assert.match(extension, /title: "选择要接入并运行的 Plan"/);
  assert.match(extension, /插件不会默认使用列表第一项/);
  assert.match(extension, /selectionChanged[\s\S]{0,900}queueSelectedPlanResultParse\("识别工作区切换计划", planFile\)/);
  assert.match(extension, /async pickPlanBaseConfig\(configs, options = \{\}\)/);
  assert.match(extension, /async pickGuidedPlanEntry\(root, entries, stage\)/);
  assert.match(extension, /title: stage === "test" \? "选择评估入口" : "选择训练入口"/);
  assert.match(extension, /guidedPlanCommandUsesConfig\(trainCommand\).*guidedPlanCommandUsesConfig\(testCommand\)/);
  assert.match(extension, /await ensureGuidedFallbackConfig\(root, baseConfig\)/);
  assert.match(extension, /inputExistingWorkspaceConfig\(options\.root\)/);
  assert.match(extension, /const configReview = stages\.train \? await guidedPlanConfigReview\(root, baseConfig, generatedFallbackConfig\)/);
  assert.match(extension, /await confirmGuidedPlanCreation\(/);
  assert.match(extension, /title: "选择新 Plan 使用的配置"/);
  assert.match(extension, /if \(list\.length <= 1\)/);
  assert.match(extension, /if \(!plans\.length\) \{\s*await this\.generatePlanGuideFromUi\(false\);\s*if \(!this\.projectContextIsCurrent\(projectContext\)\)\s*return;\s*await this\.refreshLocalPlanMetadata\(\{ post: false, force: true \}\);/);
  assert.match(extension, /let gateDiagnostics = projectOutputGateDiagnostics\(project, selected\)/);
  assert.match(extension, /if \(gateReason && gateDiagnostics\.nextLabel === "接入配置" && !project\.adapterConfig\) \{\s*await this\.generateOutputAdapterFromUi\(\);\s*if \(!this\.projectContextIsCurrent\(projectContext\)\)\s*return;\s*await this\.refreshLocalPlanMetadata\(\{ post: false, force: true \}\);/);
  assert.match(extension, /return projectBootstrapCompletion\(/);
  assert.match(extension, /adapterConfig: project\.adapterConfig/);
  assert.match(extension, /offlineBundleActive: Boolean\(this\.offlineBundle\)/);
  assert.match(extension, /outputGateNextLabel: gateDiagnostics\.nextLabel/);
  assert.match(extension, /activeRun: activePlanRunEvidence\(state, planFile, selected\)/);
  assert.match(extension, /activeRun,/);
  assert.match(extension, /await this\.testTunnel\(false\)/);
  assert.match(extension, /handleProjectBootstrapAction\(next, \{/);
  assert.match(extension, /next === "准备 Agent 并启动"[\s\S]{0,100}this\.prepareAgentsForFirstRun\(false\)/);
  assert.match(extension, /next === "打开服务器设置"[\s\S]{0,100}openPanelAt\("settings", "settings-servers", \{ userInitiated: true \}\)/);
  assert.doesNotMatch(extension, /next === "开始一键配置"/);
  assert.match(extension, /next === "打开连接设置"[\s\S]{0,140}workbench\.action\.openSettings/);
  assert.match(extension, /next === "恢复在线连接"[\s\S]{0,180}clearOfflineImport\(\)[\s\S]{0,180}ensureRealtimeConnected\("resume from project onboarding"\)/);
  assert.match(extension, /next === "打开当前 Plan" && context\.planFile\)[\s\S]{0,120}openWorkspaceFileForProjectContext\(context\.planFile, projectContext\)/);
  assert.match(extension, /next === "打开接入配置" && context\.adapterConfig\)[\s\S]{0,120}openWorkspaceFileForProjectContext\(context\.adapterConfig, projectContext\)/);
  assert.match(extension, /next === "查看运行进度"[\s\S]{0,100}openPanelAt\("execution", "execution-operations", \{ userInitiated: true \}\)/);
  assert.match(extension, /next === "查看提交进度"[\s\S]{0,120}openPanelAt\("operations", "operations-list", \{ userInitiated: true \}\)/);
  assert.match(extension, /next === "校验并提交运行"[\s\S]{0,180}this\.runActionCommand\("runPlan"/);
  assert.match(extension, /const currentCompletion = \(\) => \{/);
  assert.match(extension, /const NEW_PROJECT_INFRASTRUCTURE_MAX_STEPS = 3/);
  assert.match(extension, /for \(let step = 0; step < NEW_PROJECT_INFRASTRUCTURE_MAX_STEPS; step \+= 1\)/);
  assert.match(extension, /const PROJECT_BOOTSTRAP_MAX_STEPS = 8/);
  assert.match(extension, /for \(let step = 0; step < PROJECT_BOOTSTRAP_MAX_STEPS; step \+= 1\)/);
  assert.match(extension, /const seenCompletions = new Set\(\)/);
  assert.match(extension, /seenCompletions\.has\(completionKey\)[\s\S]{0,100}stopAtProjectPanel\(completion\)/);
  assert.match(extension, /await stopAtProjectPanel\(currentCompletion\(\)\)/);
  assert.match(extension, /const continueFlow = await this\.handleProjectBootstrapAction\(next, \{/);
  assert.match(extension, /if \(!continueFlow\)\s*return/);
  assert.match(extension, /async addWorkerConfigFromUi\(showMessage = true\)[\s\S]{0,2200}return true/);
  assert.match(extension, /async assertPlanLocalConfigFiles\(body\)/);
  assert.match(extension, /当前 Plan 引用的配置文件不存在/);
  assert.match(extension, /label: "配置文件", ok: configReady/);
  assert.match(panel, /label: "配置文件", ok: configReady/);
  const bootstrapStart = extension.indexOf("async bootstrapProjectFromUi()");
  const bootstrapEnd = extension.indexOf("async generateOutputAdapterFromUi()", bootstrapStart);
  const bootstrap = extension.slice(bootstrapStart, bootstrapEnd);
  assert.equal([...bootstrap.matchAll(/await this\.handleProjectBootstrapAction\(/g)].length, 2);
  assert.ok(bootstrap.indexOf("const next = completion.action") < bootstrap.indexOf("handleProjectBootstrapAction(next"));
  assert.doesNotMatch(bootstrap, /gateDiagnostics = projectOutputGateDiagnostics\(project, selected\);\s*}\s*if \(planFile\)\s*await openWorkspaceFile\(planFile\)/);
  const planGuideStart = extension.indexOf("async generatePlanGuideFromUi(");
  const planGuideEnd = extension.indexOf("async pickGuidedPlanEntry(", planGuideStart);
  const planGuide = extension.slice(planGuideStart, planGuideEnd);
  assert.match(planGuide, /async generatePlanGuideFromUi\(openAfterCreate = true\)/);
  assert.match(planGuide, /const projectContext = this\.captureProjectContext\(\)/);
  assert.ok([...planGuide.matchAll(/projectContextIsCurrent\(projectContext\)/g)].length >= 14);
  assert.match(planGuide, /if \(openAfterCreate && this\.projectContextIsCurrent\(projectContext\)\)\s*await openWorkspaceFile\(relative\)/);
  assert.doesNotMatch(bootstrap, /generatePlanGuideFromUi\(\)/);
});

test("quick project onboarding never silently falls back to the first of multiple plans", () => {
  const plans = [
    { planFile: "experiments/plans/a.yaml", planId: "a" },
    { planFile: "experiments/plans/b.yaml", planId: "b" },
  ];
  const selectedByFile = bootstrapPlanSelection(plans, "experiments/plans/b.yaml", "");
  assert.equal(selectedByFile.plan.planId, "b");
  assert.equal(selectedByFile.needsChoice, false);

  const selectedById = bootstrapPlanSelection(plans, "", "a");
  assert.equal(selectedById.plan.planFile, "experiments/plans/a.yaml");

  const selectedFileWins = bootstrapPlanSelection(plans, "experiments/plans/b.yaml", "a");
  assert.equal(selectedFileWins.plan.planId, "b");

  const ambiguous = bootstrapPlanSelection(plans, "", "");
  assert.equal(ambiguous.plan, undefined);
  assert.equal(ambiguous.needsChoice, true);

  const only = bootstrapPlanSelection([plans[0]], "", "");
  assert.equal(only.plan.planId, "a");
  assert.equal(only.needsChoice, false);
});

test("quick project onboarding reports only the next action proven by current readiness", () => {
  const outputIncomplete = bootstrapCompletion({ outputGateReason: "缺少结果路径", realtimeMode: true, setupComplete: true, workers: [{ status: "ok" }], hubStatus: "ok" });
  assert.equal(outputIncomplete.state, "output_incomplete");
  assert.equal(outputIncomplete.action, "打开当前 Plan");
  assert.equal(bootstrapCompletion({ outputGateReason: "缺少结果路径", outputGateNextLabel: "接入配置", adapterConfig: "experiments/simple_project.yaml" }).action, "打开接入配置");
  assert.equal(bootstrapCompletion({ outputGateReason: "配置文件缺失", outputGateNextLabel: "配置文件", adapterConfig: "experiments/simple_project.yaml" }).action, "打开当前 Plan");
  assert.match(panel, /在当前 Plan 声明结果位置，或在插件设置中配置输出接入规则/);
  assert.equal(bootstrapCompletion({ setupComplete: false }).action, "打开服务器设置");
  const workerRequired = bootstrapCompletion({ setupComplete: true, workers: [] });
  assert.equal(workerRequired.state, "worker_required");
  assert.equal(workerRequired.action, "打开服务器设置");
  const offline = bootstrapCompletion({ realtimeMode: false, setupComplete: true, workers: [{ status: "ok" }] });
  assert.equal(offline.state, "offline_import");
  assert.equal(offline.action, "打开连接设置");
  const importedOffline = bootstrapCompletion({ realtimeMode: false, offlineBundleActive: true, setupComplete: true, workers: [{ status: "ok" }] });
  assert.equal(importedOffline.state, "offline_import");
  assert.equal(importedOffline.action, "恢复在线连接");
  const missingAgent = bootstrapCompletion({ realtimeMode: true, setupComplete: true, hubStatus: "ok", workers: [{ label: "Worker A", status: "agent_project_mismatch" }] });
  assert.equal(missingAgent.action, "准备 Agent 并启动");
  assert.match(missingAgent.message, /Worker A Agent 未通过当前项目检测/);
  const activeTasks = bootstrapCompletion({ realtimeMode: true, setupComplete: true, hubStatus: "local_port_closed", workers: [{ label: "Worker A", status: "unknown" }], activeRun: { active: true, taskCount: 2, operationCount: 1 } });
  assert.equal(activeTasks.state, "active_run");
  assert.equal(activeTasks.action, "查看运行进度");
  assert.match(activeTasks.message, /2 个任务、1 个提交操作/);
  const activeSubmission = bootstrapCompletion({ realtimeMode: true, setupComplete: true, workers: [{ status: "unknown" }], activeRun: { active: true, taskCount: 0, operationCount: 1 } });
  assert.equal(activeSubmission.action, "查看提交进度");
  const activeRunWins = bootstrapCompletion({ outputGateReason: "缺少结果路径", setupComplete: false, realtimeMode: false, activeRun: { active: true, taskCount: 1, operationCount: 1 } });
  assert.equal(activeRunWins.state, "active_run");
  assert.equal(activeRunWins.action, "查看运行进度");
  const completionStart = extension.indexOf("function projectBootstrapCompletion(options)");
  const completionEnd = extension.indexOf("function automaticResultParseReady", completionStart);
  const completionSource = extension.slice(completionStart, completionEnd);
  assert.ok(completionSource.indexOf("if (activeRun.active)") < completionSource.indexOf("const outputGateReason"));
  const ready = bootstrapCompletion({ realtimeMode: true, setupComplete: true, hubStatus: "file_api_unavailable", workers: [{ label: "Worker A", status: "ok" }] });
  assert.equal(ready.state, "ready");
  assert.equal(ready.action, "校验并提交运行");
  assert.match(ready.message, /校验并提交运行/);
});

test("quick project onboarding opens the exact panel destination", () => {
  assert.match(extension, /webviewReady = false/);
  const ready = extension.slice(extension.indexOf('case "webviewReady":'), extension.indexOf('case "webviewHeartbeatAck":'));
  assert.match(ready, /flushPendingPanelNavigation\(\)/);
  assert.match(extension, /if \(options\.userInitiated !== true\) return false/);
  assert.match(extension, /async openPanelAt\(section, anchor = section, options = \{\}\)/);
  assert.match(extension, /postMessage\(\{ type: "navigate", \.\.\.target \}\)/);
  assert.match(panel, /vscode\.postMessage\(\{ command: "webviewReady", documentGeneration: panelDocumentGeneration/);
  assert.match(panel, /item\.type === "navigate"/);
  assert.match(panel, /if \(item\.userInitiated === true \|\| item\.openResultMapping === true\) latestNavigationMessage = item/);
  assert.match(panel, /navigateToResourceTarget\(navigation\.section, navigation\.anchor, \{ force: true \}\)/);
});
