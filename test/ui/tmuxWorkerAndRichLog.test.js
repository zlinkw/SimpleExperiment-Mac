const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");
const { terminalHistoryLogBinding } = require("../../dist/features/DistributedPlanQueue.js");
const { readSource } = require("../_helpers/sourceReader");

test("Rich progress redraws replace old lines in the log view", () => {
  const html = renderPanelHtml();
  const start = html.indexOf("function terminalDisplayText(raw)");
  const end = html.indexOf("async function refreshTmuxCapture()", start);
  assert.ok(start >= 0 && end > start);
  const display = vm.runInNewContext(html.slice(start, end) + "; terminalDisplayText;");
  const progress = "start\nTrain 1/3 0%\nVal 1/3 0%\r\x1b[2K\x1b[1A\x1b[2KTrain 1/3 50%\nVal 1/3 50%\r\x1b[2K\x1b[1A\x1b[2KTrain 1/3 100%\nVal 1/3 100%";
  const result = display(progress);
  assert.match(result, /start/);
  assert.match(result, /Train 1\/3 100%/);
  assert.match(result, /Val 1\/3 100%/);
  assert.doesNotMatch(result, /(?:^|\s)(?:0%|50%)|\x1b/);
});

test("terminal attempts on one GPU keep immutable run and command log identities", () => {
  const first = terminalHistoryLogBinding({ id: "run-a" }, {
    status: "completed", commandId: "command-a", gpuId: "gpu-0", outputDir: "simple_cluster/runs/ebmc/attempts/run-a/job-42",
  });
  const second = terminalHistoryLogBinding({ id: "run-b" }, {
    status: "failed", commandId: "command-b", gpuId: "gpu-0", outputDir: "simple_cluster/runs/ebmc/attempts/run-b/job-42",
  });
  assert.equal(first.logPath, "simple_cluster/runs/ebmc/attempts/run-a/job-42/stdout.log");
  assert.deepEqual(first.historyLogIdentity, {
    commandId: "command-a", outputDir: "simple_cluster/runs/ebmc/attempts/run-a/job-42", runId: "run-a",
  });
  assert.equal(second.logPath, "simple_cluster/runs/ebmc/attempts/run-b/job-42/stderr.log");
  assert.notEqual(first.logPath, second.logPath);
  assert.equal(terminalHistoryLogBinding({ id: "run-a" }, {
    status: "running", commandId: "command-live", outputDir: "simple_cluster/runs/live",
  }), undefined);
});

test("tmux overview requests and retains all Worker session lists", () => {
  const panel = readSource("src/ui/PanelHtml.legacy.ts");
  const host = readSource("src/extension/legacy.ts");
  assert.match(panel, /allWorkers: !jobWorker/);
  assert.match(panel, /tmuxListsByWorker\[item\.workerId\]/);
  assert.match(panel, /data-tmux-worker/);
  assert.match(host, /Promise\.all\(workerIds\.map\(\(workerId\) => this\.fetchOneTmuxListFromUi\(workerId, _message\?\.requestId\)\)\)/);
});

test("tmux refresh releases only after every Worker replies and ignores stale replies", () => {
  const html = renderPanelHtml();
  const start = html.indexOf("function scheduleTmuxInitialRetry()");
  const end = html.indexOf("function tmuxResolveCaptureTarget", start);
  assert.ok(start >= 0 && end > start);
  const cleared = [];
  const refreshes = [];
  let retry;
  const sandbox = {
    tmuxListBusy: true,
    tmuxListRequestId: 2,
    tmuxListPendingWorkers: new Set(),
    tmuxListTimeout: 12,
    tmuxInitialRetryCount: 0,
    tmuxInitialRetryTimer: 0,
    tmuxConfiguredWorkers: [{ id: "nwpu2" }, { id: "nwpu3" }],
    tmuxListsByWorker: { nwpu2: { ok: false }, nwpu3: { ok: false } },
    document: { hidden: false },
    setTimeout: (callback) => { retry = callback; return 13; },
    refreshTmuxList: () => refreshes.push("retry"),
    clearTimeout: (id) => cleared.push(id),
  };
  vm.runInNewContext(html.slice(start, end), sandbox);
  const workers = [{ id: "nwpu2" }, { id: "nwpu3" }];
  sandbox.finishTmuxListRequest({ requestId: 1, workerId: "nwpu2", workers });
  assert.equal(sandbox.tmuxListBusy, true);
  sandbox.finishTmuxListRequest({ requestId: 2, workerId: "nwpu2", workers, ok: false });
  assert.equal(sandbox.tmuxListBusy, true);
  assert.deepEqual(cleared, []);
  sandbox.finishTmuxListRequest({ requestId: 2, workerId: "nwpu3", workers, ok: false });
  assert.equal(sandbox.tmuxListBusy, false);
  assert.deepEqual(cleared, [12]);
  assert.equal(sandbox.tmuxInitialRetryCount, 1, "initial failures retry without a Worker click");
  retry();
  assert.deepEqual(refreshes, ["retry"]);
});

test("Worker switch immediately replaces stale pane and capture state", () => {
  const html = renderPanelHtml();
  const start = html.indexOf("function selectTmuxWorker(workerId)");
  const end = html.indexOf("async function refreshTmuxList()", start);
  assert.ok(start >= 0 && end > start);
  const elements = {
    tmuxWorkerSelect: { value: "nwpu3" },
    tmuxWindowSelect: { selectedIndex: 2 },
    tmuxCapturePre: { textContent: "old pane", dataset: { captureTarget: "old", lastFetch: "old" } },
  };
  const calls = [];
  const context = {
    tmuxConfiguredWorkers: [{ id: "nwpu2" }, { id: "nwpu3" }],
    tmuxListsByWorker: { nwpu2: { sessions: [{ name: "zlk-gpu-0" }], workerId: "nwpu2" } },
    tmuxSelectedWorkerId: "nwpu3",
    tmuxWindowFilter: "zlk-gpu-0:2",
    tmuxSelectedPaneTarget: "%5",
    tmuxSelectedTaskTarget: "old",
    tmuxListCache: { sessions: [] },
    tmuxLastCaptureTarget: "old",
    el: (id) => elements[id],
    persistWebviewState: (state) => calls.push(["persist", state.tmuxSelectedWorkerId]),
    renderTmuxOverview: (sessions) => calls.push(["overview", sessions[0]?.name]),
    renderTmuxWorkersOverview: () => calls.push(["workers"]),
    refreshTmuxCapture: () => calls.push(["capture"]),
    refreshTmuxList: () => calls.push(["list"]),
  };
  vm.runInNewContext(html.slice(start, end) + "; selectTmuxWorker('nwpu2');", context);
  assert.equal(context.tmuxSelectedWorkerId, "nwpu2");
  assert.equal(elements.tmuxWorkerSelect.value, "nwpu2");
  assert.equal(elements.tmuxWindowSelect.selectedIndex, -1);
  assert.equal(elements.tmuxCapturePre.textContent, "");
  assert.equal(context.tmuxSelectedPaneTarget, "");
  assert.equal(context.tmuxWindowFilter, "all");
  assert.deepEqual(calls.map((call) => call[0]), ["persist", "overview", "workers", "capture", "list"]);
  assert.match(html, /document\.addEventListener\("click", function\(event\)[\s\S]*?button\[data-tmux-worker\]/);
});
