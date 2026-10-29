const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const ts = require("typescript");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");
const html = renderPanelHtml();
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.includes("function renderTmuxOverview("));
const ast = ts.createSourceFile("panel.js", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function fn(name) {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `missing ${name}`);
  return declaration.getText(ast);
}

test("command receipt changes refresh the log button even when placement and status stay unchanged", () => {
  const rendered = [];
  const sandbox = {
    executionRenderKeysCacheState: null, executionRenderKeysCacheValue: null, executionRenderKeysCacheLocalSignature: "",
    selectedExecutionPlanFile: "", collapsedExecutionPlanKeys: new Set(), operationStatusFilter: "all",
    selectedOperationHistoryIds: new Set(), expandedTaskLogs: {}, lastExecutionPlanListKey: "",
    stableSectionSignature: JSON.stringify, asArray: value => Array.isArray(value) ? value : [],
    operationRowsForState: () => [], taskSectionViewModelForState: () => ({ allRows: [], taskView: { selectedRows: [] } }),
    compactTaskRowsForRenderStructureSignature: value => value, compactCapabilitiesForSignature: value => value,
    compactOperationRowsForSignature: value => value, normalizeFileTransferRows: value => value,
    distributedPlanRecoveryView: () => null,
    renderExecutionPlanList: value => rendered.push(value),
    patchExecutionProgressDom: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext(["executionRenderKeysForState", "executionPlanListKey", "renderExecutionPlanListIfChanged"].map(fn).join("\n"), sandbox);
  const state = commandId => ({ distributedPlans: [{ id: "run", planFile: "plans/a.yaml", jobs: [{
    index: 0, status: "running", workerId: "worker-a", gpuId: "0", outputDir: "work_dirs/attempt", commandId,
  }] }] });
  sandbox.renderExecutionPlanListIfChanged(state(""));
  sandbox.renderExecutionPlanListIfChanged(state(""));
  assert.equal(rendered.length, 1);
  sandbox.renderExecutionPlanListIfChanged(state("receipt-a"));
  assert.equal(rendered.length, 2);
  sandbox.renderExecutionPlanListIfChanged(state("receipt-b"));
  assert.equal(rendered.length, 3);
});
function fixture(options = {}) {
  const requests = [], navigations = [], notices = [], persisted = [], timers = new Map();
  let nextTimer = 0;
  const elements = Object.fromEntries(["tmuxOverview", "tmuxWorkersOverview", "tmuxListMeta", "tmuxCaptureMeta", "tmuxCapturePre", "tmuxWorkerSelect"].map(id => [id, { innerHTML: "", textContent: "", value: "", dataset: {} }]));
  const sandbox = {
    tmuxJobLogSelection: null, tmuxJobLogJumpTimeout: 0,
    tmuxSelectedWorkerId: "worker-b", tmuxWindowFilter: "all", tmuxSelectedTaskTarget: "", tmuxSelectedPaneTarget: "",
    tmuxLastCaptureTarget: "", tmuxListRequestId: 0, tmuxListBusy: false, tmuxListTimeout: 0,
    tmuxInitialRetryCount: 0, tmuxInitialRetryTimer: 0,
    tmuxListPendingWorkers: new Set(), tmuxCaptureBusy: new Set(),
    tmuxConfiguredWorkers: [{ id: "worker-a" }, { id: "worker-b" }], tmuxListsByWorker: {},
    tmuxListCache: { workerId: "worker-b", sessions: [], gpuIds: [], tmuxSessionPrefix: "custom" }, tmuxClearTaskTabsBusy: false,
    document: { hidden: false },
    vscode: { postMessage: row => requests.push(row) },
    panelDocumentGeneration: "4", console,
    el: id => elements[id] || null,
    esc: value => String(value ?? "").replaceAll("<", "&lt;"),
    escAttr: value => String(value ?? "").replaceAll('"', "&quot;"),
    navigateToResourceTarget: (...args) => navigations.push(args),
    showToast: text => notices.push(text), persistWebviewState: patch => persisted.push(patch),
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
  };
  const toastNodes = [];
  if (options.realToast) {
    delete sandbox.showToast;
    sandbox.document.createElement = () => ({ dataset: {}, style: {}, setAttribute() {} });
    sandbox.document.body = { appendChild: node => { elements[node.id] = node; toastNodes.push(node); } };
  }
  // Normal mode fixture: no authoritative trafficMode yet and no persisted low traffic hint, so
  // automatic display rounds stay allowed exactly as before.
  sandbox.lastState = {};
  sandbox.tmuxDisplayAutoHint = true;
  sandbox.displayRefreshAt = new Map();
  vm.createContext(sandbox);
  if (options.realToast) vm.runInContext(fn("showToast"), sandbox);
  vm.runInContext(["normalizeTmuxWindowFilter", "classifyTmuxWindow", "tmuxGpuIdFromSession", "tmuxCurrentGpuIdFromSession", "tmuxTaskStatusLabel", "tmuxTaskWindowLabel", "tmuxWindowCloseButton", "tmuxGpuSessionCloseButton", "getTmuxWindowCandidates",
    "renderTmuxFilterBar", "renderTmuxOverview", "renderTmuxWorkersOverview", "refreshTmuxList", "scheduleTmuxInitialRetry", "finishTmuxListRequest",
    "resolveJobTmuxWindow", "cancelJobTmuxLogJump", "failJobTmuxLogJump", "jumpToJobTmuxLog", "handleJobTmuxLogList", "tmuxResolveCaptureTarget", "refreshTmuxCapture",
    // r2 display gate helpers live in the same script scope in production, so the fixture loads them too.
    "lowTrafficModeFromState", "displayAutoAllowed", "displaySampleNotice", "recordDisplaySample", "renderDisplayAutoNotices"].map(fn).join("\n"), sandbox);
  const clickStart = script.indexOf('const jobTmuxLogButton = event.target.closest("button[data-job-tmux-log]")');
  const clickEnd = script.indexOf('const tmuxClearTaskTabs =', clickStart);
  assert.ok(clickStart >= 0 && clickEnd > clickStart);
  vm.runInContext("this.click = function(event) {" + script.slice(clickStart, clickEnd) + "};", sandbox);
  const listStart = script.indexOf('if (item.type === "tmuxList")');
  const listEnd = script.indexOf('if (item.type === "tmuxCapture")', listStart);
  vm.runInContext("this.deliver = function(input) { for (const item of [input]) {" + script.slice(listStart, listEnd) + "} };", sandbox);
  const click = (commandId = "command-new", outputDir = "work_dirs/plan/attempts/new", workerId = "worker-a") => {
    const values = { "data-worker-id": workerId, "data-command-id": commandId, "data-output-dir": outputDir };
    const button = { disabled: false, getAttribute: key => values[key] || "" };
    sandbox.click({ target: { closest: selector => selector === "button[data-job-tmux-log]" ? button : null }, preventDefault() {} });
  };
  const deliver = (workerId, sessions, requestId = sandbox.tmuxListRequestId, extra = {}) => sandbox.deliver({ type: "tmuxList", workerId, sessions,
    gpuIds: ["0"], tmuxSessionPrefix: "custom", workers: sandbox.tmuxConfiguredWorkers, requestId, ...extra });
  return { sandbox, requests, navigations, notices, persisted, elements, timers, click, deliver, toastNodes };
}

test("missing real tmux windows send native notification messages without a disappearing webpage toast", () => {
  const f = fixture({ realToast: true });
  f.click("closed-command", "work_dirs/a/attempts/closed");
  assert.doesNotThrow(() => f.deliver("worker-a", windows()));
  const notices = f.requests.filter(row => row.command === "webviewNotice");
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /窗口|标签/);
  assert.equal(notices[0].tone, "warning");
  assert.equal(notices[0].documentGeneration, "4");
  assert.equal(f.toastNodes.length, 0, "native notifications do not create a second webpage toast");
  assert.doesNotThrow(() => f.click("", "", ""));
  assert.equal(f.requests.filter(row => row.command === "webviewNotice").length, 2);
  assert.equal(f.toastNodes.length, 0);
  assert.equal(f.timers.size, 0, "no five-second auto-hide timer survives either failure");
});

test("manual recall keeps the exact command identity and cannot forward a historical attempt override", () => {
  const sandbox = { RESTORABLE_PLAN_FILE_PAYLOAD_COMMANDS: new Set(), ARTIFACT_SCOPE_COMMANDS: new Set(), el: () => null };
  vm.createContext(sandbox);
  vm.runInContext(["payloadFromButton", "pendingKeyForAction", "pendingKeyFromButtonDataset"].map(fn).join("\n"), sandbox);
  const button = { dataset: { command: "recallFailedJob", planFile: "plans/cpsc.yaml", planId: "workflow", jobIndex: "0", commandId: "old-command" } };
  const payload = sandbox.payloadFromButton(button);
  assert.equal(Object.hasOwn(payload,"attempt"), false); assert.equal(payload.jobIndex, 0); assert.equal(payload.commandId, "old-command");
  const key = sandbox.pendingKeyForAction(button.dataset.command, payload);
  assert.equal(sandbox.pendingKeyFromButtonDataset(button), key);
  const next = { ...payload, commandId: "new-command" };
  assert.notEqual(sandbox.pendingKeyForAction(button.dataset.command, next), key);
  assert.notEqual(sandbox.pendingKeyForAction(button.dataset.command, { ...payload, jobIndex: 1 }), key);
  button.dataset.attempt = "1";
  assert.equal(Object.hasOwn(sandbox.payloadFromButton(button), "attempt"), false);
  button.dataset.command = "markJobUnavailable";
  assert.equal(sandbox.payloadFromButton(button).attempt, 1, "the other retained action keeps its historical payload");
});
function windows(commandId = "command-new", outputDir = "work_dirs/plan/attempts/new") {
  return [{ name: "custom-gpu-0", windows: [
    { index: "1", target: "custom-gpu-0:1", task: { commandId: "command-old", outputDir: "work_dirs/plan/attempts/old", case: "same", seed: 42, status: "completed" } },
    { index: "2", target: "custom-gpu-0:2", task: { commandId, outputDir, case: "same", seed: 42, status: "running" } },
  ] }];
}

test("job click refreshes its Worker and selects the exact real task tab once without inline log reads", () => {
  const f = fixture();
  f.click();
  assert.equal(f.navigations.length, 1);
  assert.deepEqual(Array.from(f.navigations[0]).slice(0, 2), ["tmux", "tmux-overview"]);
  assert.equal(f.requests[0].command, "fetchTmuxList");
  assert.equal(f.requests[0].workerId, "worker-a");
  assert.equal(f.requests[0].allWorkers, false, "the jump only probes its own Worker");
  assert.equal(f.requests.filter(row => row.command === "fetchTmuxCapture").length, 0);
  f.deliver("worker-b", windows("command-new", "work_dirs/plan/attempts/new"));
  assert.equal(f.requests.filter(row => row.command === "fetchTmuxCapture").length, 0);
  f.deliver("worker-a", windows());
  assert.equal(f.sandbox.tmuxWindowFilter, "custom-gpu-0");
  assert.equal(f.sandbox.tmuxSelectedTaskTarget, "custom-gpu-0:2");
  assert.match(f.elements.tmuxOverview.innerHTML, /tmuxTaskTab is-active[^>]*data-tmux-task-target="custom-gpu-0:2"/);
  assert.deepEqual(f.requests.filter(row => row.command === "fetchTmuxCapture").map(row => [row.workerId, row.window]), [["worker-a", "custom-gpu-0:2"]]);
  assert.equal(f.navigations.length, 1, "async results must not scroll the page again");
  assert.equal(f.timers.has(f.sandbox.tmuxJobLogJumpTimeout), false);
  assert.ok(f.requests.every(row => ["fetchTmuxList", "fetchTmuxCapture"].includes(row.command)));
});

test("closed historical windows and ambiguous identities cannot fall back to another job on the same GPU", () => {
  const f = fixture();
  f.click("missing-command", "work_dirs/plan/attempts/missing");
  f.deliver("worker-a", windows());
  assert.equal(f.requests.filter(row => row.command === "fetchTmuxCapture").length, 0);
  assert.match(f.notices.at(-1), /窗口|标签/);
  assert.equal(f.sandbox.tmuxResolveCaptureTarget(), "");
  const match = f.sandbox.resolveJobTmuxWindow;
  assert.equal(match({ workerId: "worker-a", commandId: "command-new", outputDir: "wrong-attempt" }, { workerId: "worker-a", sessions: windows() }), null);
  assert.equal(match({ workerId: "worker-a", outputDir: "work_dirs/plan/attempts/new" }, { workerId: "worker-b", sessions: windows() }), null);
  const duplicated = windows();
  duplicated[0].windows.push({ ...duplicated[0].windows[1], index: "3", target: "custom-gpu-0:3" });
  assert.equal(match({ workerId: "worker-a", commandId: "command-new" }, { workerId: "worker-a", sessions: duplicated }), null);
});

test("a targeted jump supersedes pre-click polls and old replies cannot resolve a newer jump", () => {
  const f = fixture();
  f.sandbox.refreshTmuxList();
  f.click();
  assert.equal(f.requests.length, 2);
  f.deliver("worker-a", windows(), 1);
  assert.equal(f.requests.filter(row => row.command === "fetchTmuxCapture").length, 0);
  assert.equal(f.sandbox.tmuxListRequestId, 2);
  f.click("command-second", "work_dirs/plan/attempts/second");
  f.deliver("worker-a", windows(), 2);
  assert.equal(f.sandbox.tmuxListRequestId, 3);
  f.deliver("worker-a", windows("command-second", "work_dirs/plan/attempts/second"), 2);
  assert.equal(f.requests.filter(row => row.command === "fetchTmuxCapture").length, 0);
  f.deliver("worker-a", windows("command-second", "work_dirs/plan/attempts/second"), 3);
  assert.equal(f.requests.filter(row => row.command === "fetchTmuxCapture").length, 1);
  assert.equal(f.sandbox.tmuxListBusy, false, "an unrelated Worker cannot hold the targeted request open");
  f.sandbox.refreshTmuxList();
  assert.equal(f.requests.at(-1).allWorkers, true, "normal all-Worker polling remains available");
});

test("one timer is replaced on re-click and explicit tmux selection cancels the pending jump", () => {
  const f = fixture();
  f.click();
  const oldTimer = f.sandbox.tmuxJobLogJumpTimeout;
  f.click();
  assert.equal(f.timers.has(oldTimer), false);
  const currentTimer = f.sandbox.tmuxJobLogJumpTimeout;
  f.sandbox.cancelJobTmuxLogJump();
  assert.equal(f.timers.has(currentTimer), false);
  assert.equal(f.sandbox.tmuxJobLogSelection, null);
  f.deliver("worker-a", windows());
  assert.equal(f.sandbox.tmuxSelectedTaskTarget, "");
  assert.equal(f.navigations.length, 2);
});

test("missing dispatch identity, failed reads, and bounded timeout never capture a guessed window", () => {
  const f = fixture();
  f.click("", "", "");
  assert.equal(f.requests.length, 0);
  f.click();
  f.deliver("worker-a", [], undefined, { ok: false, error: "disconnected" });
  assert.equal(f.sandbox.tmuxResolveCaptureTarget(), "");
  f.click();
  const expire = f.timers.get(f.sandbox.tmuxJobLogJumpTimeout);
  expire();
  assert.equal(f.sandbox.tmuxJobLogJumpTimeout, 0);
  assert.equal(f.sandbox.tmuxJobLogSelection.status, "unavailable");
  assert.equal(f.requests.filter(row => row.command === "fetchTmuxCapture").length, 0);
});

test("a selected job whose tmux window disappears does not switch to another retained task", () => {
  const f = fixture();
  f.click(); f.deliver("worker-a", windows());
  f.sandbox.tmuxListCache.sessions[0].windows.pop();
  assert.equal(f.sandbox.tmuxResolveCaptureTarget(), "");
  assert.equal(f.sandbox.tmuxSelectedTaskTarget, "custom-gpu-0:2");
  f.deliver("worker-a", windows("another-command", "work_dirs/other/attempts/new"));
  assert.equal(f.sandbox.tmuxJobLogSelection.status, "unavailable");
  assert.equal(f.elements.tmuxCapturePre.textContent, "");
});

test("a missing Worker or reply without the request identity cannot select a different server", () => {
  const f = fixture();
  f.click();
  f.sandbox.deliver({ type: "tmuxList", workerId: "worker-a", sessions: windows(), workers: f.sandbox.tmuxConfiguredWorkers });
  assert.equal(f.sandbox.tmuxJobLogSelection.status, "waiting");
  assert.equal(f.requests.filter(row => row.command === "fetchTmuxCapture").length, 0);
  f.deliver("worker-b", [], undefined, { workers: [{ id: "worker-b" }] });
  assert.equal(f.sandbox.tmuxJobLogSelection.status, "unavailable");
  assert.equal(f.requests.filter(row => row.command === "fetchTmuxCapture").length, 0);
});
