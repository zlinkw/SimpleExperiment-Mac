const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

function extractBetween(html, startText, endText) {
  const start = html.indexOf(startText);
  const end = html.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, startText);
  return html.slice(start, end);
}

function elementFromTag(tag) {
  const attrs = {};
  const attr = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
  let matched;
  while ((matched = attr.exec(tag))) attrs[matched[1]] = matched[2];
  const classes = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
  return {
    attrs,
    disabled: Object.prototype.hasOwnProperty.call(attrs, "disabled"),
    classList: { contains: (name) => classes.has(name) },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    closest(selector) {
      if (selector === "[data-tmux-clear-task-tabs]" && this.hasAttribute("data-tmux-clear-task-tabs")) return this;
      if (selector === "[data-tmux-close]" && this.hasAttribute("data-tmux-close")) return this;
      if (selector === "button[data-tmux-worker]" && this.hasAttribute("data-tmux-worker")) return this;
      return null;
    },
  };
}

function clickEvent(target) {
  return {
    target,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

function sessions() {
  return [{
    name: "zlk-gpu-0",
    windows: [
      { index: "0", target: "zlk-gpu-0:0", name: "bash" },
      { index: "2", target: "zlk-gpu-0:2", task: { status: "running", case: "case-a", seed: 1 }, active: true },
      { index: "2", target: "zlk-gpu-0:2", task: { status: "running", case: "case-a", seed: 1 } },
      { index: "3", target: "zlk-gpu-0:3", task: { status: "failed", case: "case-b", seed: 2 } },
      { index: "9", target: "zlk-gpu-0-agent:9", name: "agent", task: { status: "running", case: "agent" } },
    ],
  }, {
    name: "zlk-gpu-1",
    windows: [{ index: "1", target: "zlk-gpu-1:1", task: { status: "running", case: "other" } }],
  }];
}

test("GPU title renders one clear button and a click keeps the current filter", () => {
  const html = renderPanelHtml();
  const posted = [];
  const toasts = [];
  const elements = {};
  const listeners = [];
  const document = {
    addEventListener(type, handler, capture) { listeners.push({ type, handler, capture: capture === true }); },
    getElementById() { return null; },
  };
  const context = {
    document,
    window: { setTimeout, clearTimeout, addEventListener() {} },
    setTimeout,
    clearTimeout,
    console,
    Date,
    Math,
    tmuxConfiguredWorkers: [{ id: "NWPU3" }, { id: "worker-b" }],
    tmuxListsByWorker: { NWPU3: { workerId: "NWPU3", fetchedAt: "t0", sessions: sessions() } },
    tmuxSelectedWorkerId: "NWPU3",
    tmuxWindowFilter: "zlk-gpu-0",
    tmuxSelectedTaskTarget: "zlk-gpu-0:2",
    tmuxSelectedPaneTarget: "",
    tmuxListCache: null,
    tmuxLastCaptureTarget: "",
    tmuxClearTaskTabsBusy: false,
    pendingActionsById: {},
    pendingActionTimeouts: {},
    el: (id) => elements[id] || (elements[id] = { id, innerHTML: "", textContent: "", value: "", dataset: {}, selectedIndex: 0, options: [] }),
    persistWebviewState() {},
    vscode: { postMessage(payload) { posted.push(payload); } },
    showToast(text) { toasts.push(String(text)); },
    refreshTmuxCapture() {},
    refreshTmuxList() {},
  };
  context.tmuxListCache = context.tmuxListsByWorker.NWPU3;
  const capture = extractBetween(html, 'document.addEventListener("click", function(event) {\n        const button = event.target && event.target.closest && event.target.closest("button[data-tmux-worker]");', "if (btn) btn.addEventListener");
  const clearHandler = extractBetween(html, 'const tmuxClearTaskTabs = event.target.closest("[data-tmux-clear-task-tabs]");', 'const tmuxCloseTarget = event.target.closest("[data-tmux-close]");');
  const script = [
    extractBetween(html, "function esc(value)", "function cssEscape("),
    extractBetween(html, "function normalizeTmuxWindowFilter(", "function renderTmuxWorkersOverview("),
    extractBetween(html, "function createClientActionId(", "function pendingKeyForButton("),
    "function renderTmuxWorkersOverview(){}",
    "renderTmuxOverview(tmuxListCache.sessions);",
    "function bubbleClick(event){",
    clearHandler,
    "}",
  ].join("\n");
  vm.runInNewContext(script, context);
  const overview = elements.tmuxOverview.innerHTML;
  const allOverview = overview;
  assert.equal((overview.match(/data-tmux-clear-task-tabs=/g) || []).length, 1);
  const tag = overview.slice(overview.indexOf("tmuxClearTaskTabs") - 40, overview.indexOf("tmuxClearTaskTabs") + 520);
  assert.match(tag, /data-tmux-clear-worker="NWPU3"/);
  assert.match(tag, /data-tmux-clear-session="zlk-gpu-0"/);
  assert.match(tag, /data-tmux-clear-targets="zlk-gpu-0:2,zlk-gpu-0:3"/);
  assert.doesNotMatch(tag, /zlk-gpu-0-agent:9/);
  assert.doesNotMatch(tag, /zlk-gpu-0:0/);
  assert.doesNotMatch(tag, /zlk-gpu-1:1/);
  assert.doesNotMatch(tag, /data-tmux-worker=/);
  assert.match(overview, /data-tmux-close="zlk-gpu-0:2"/);

  context.tmuxWindowFilter = "all";
  vm.runInNewContext("renderTmuxOverview(tmuxListCache.sessions);", context);
  assert.equal((elements.tmuxOverview.innerHTML.match(/data-tmux-clear-task-tabs=/g) || []).length, 0);
  context.tmuxWindowFilter = "zlk-gpu-1";
  context.tmuxListCache = { workerId: "NWPU3", sessions: [{ name: "zlk-gpu-1", windows: [{ index: "0", target: "zlk-gpu-1:0", name: "bash" }] }] };
  vm.runInNewContext("renderTmuxOverview(tmuxListCache.sessions);", context);
  assert.equal((elements.tmuxOverview.innerHTML.match(/data-tmux-clear-task-tabs=/g) || []).length, 0);
  context.tmuxWindowFilter = "zlk-sch-main:0";
  context.tmuxListCache = { workerId: "NWPU3", sessions: [{ name: "zlk-sch-main", windows: [{ index: "0", name: "bash", task: { status: "running" } }] }] };
  vm.runInNewContext("renderTmuxOverview(tmuxListCache.sessions);", context);
  assert.equal((elements.tmuxOverview.innerHTML.match(/data-tmux-clear-task-tabs=/g) || []).length, 0);

  context.tmuxWindowFilter = "zlk-gpu-0";
  context.tmuxListCache = context.tmuxListsByWorker.NWPU3;
  elements.tmuxOverview.innerHTML = allOverview;
  vm.runInNewContext(`${capture}\ndocument.addEventListener("click", bubbleClick, false);`, context);
  const captureListener = listeners.find((item) => item.type === "click" && item.capture);
  const bubble = listeners.find((item) => item.type === "click" && !item.capture);
  const button = elementFromTag(tag);
  const first = clickEvent(button);
  captureListener.handler(first);
  assert.equal(first.stopped, false);
  assert.equal(context.tmuxSelectedWorkerId, "NWPU3");
  assert.equal(context.tmuxWindowFilter, "zlk-gpu-0");
  bubble.handler(first);
  assert.equal(first.stopped, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].command, "clearTmuxTaskTabs");
  assert.equal(posted[0].workerId, "NWPU3");
  assert.equal(posted[0].session, "zlk-gpu-0");
  assert.deepEqual([].concat(posted[0].targets), ["zlk-gpu-0:2", "zlk-gpu-0:3"]);
  assert.equal(context.tmuxWindowFilter, "zlk-gpu-0");
  assert.equal(context.tmuxSelectedWorkerId, "NWPU3");
  assert.match(elements.tmuxOverview.innerHTML, /disabled/);

  const repeat = clickEvent(elementFromTag(elements.tmuxOverview.innerHTML.slice(elements.tmuxOverview.innerHTML.indexOf("tmuxClearTaskTabs") - 40, elements.tmuxOverview.innerHTML.indexOf("tmuxClearTaskTabs") + 520)));
  bubble.handler(repeat);
  assert.equal(posted.length, 1);

  const stale = elementFromTag(tag);
  stale.attrs["data-tmux-clear-worker"] = "worker-b";
  stale.disabled = false;
  context.tmuxClearTaskTabsBusy = false;
  bubble.handler(clickEvent(stale));
  assert.equal(posted.length, 1);
  assert.match(toasts.at(-1), /已拒绝/);
  assert.equal(context.tmuxSelectedWorkerId, "NWPU3");
});

test("clear status refreshes without switching the GPU filter to all", () => {
  const html = renderPanelHtml();
  const posted = [];
  const toasts = [];
  const context = {
    pendingActionsById: {
      "clear-1": { command: "clearTmuxTaskTabs", pendingKey: "clearTmuxTaskTabs|session=zlk-gpu-0", status: "running" },
    },
    pendingActions: {},
    pendingButtonKeys: { delete() {} },
    tmuxWindowFilter: "zlk-gpu-0",
    tmuxSelectedWorkerId: "NWPU3",
    tmuxClearTaskTabsBusy: true,
    lastState: null,
    TERMINAL_UI_STATUSES: new Set(["completed", "submitted", "failed", "cancelled", "stalled"]),
    showToast(text) { toasts.push(String(text)); },
    refreshTmuxList() { posted.push("list"); },
    refreshTmuxCapture() { posted.push("capture"); },
    renderCommandPhaseLine() {},
    clearConfigDraftsForCommand() {},
    clearPendingActionTimeout() {},
    clearButtonsForPending() {},
    applyPendingButtonStates() {},
    refreshTerminalUi() { posted.push("terminal"); },
    setTaskPlanScope(value) { posted.push(["scope", value]); },
    setTracePlanScope() {},
    navigateToResourceTarget() { posted.push("navigate"); },
    maybeAutoAdvanceFromSync() {},
    isConfigSaveCommand() { return false; },
  };
  const script = [
    extractBetween(html, "function isTerminalUiStatus(", "function handleUiCommandStatus("),
    extractBetween(html, "function handleUiCommandStatus(", "function submittedCommandTarget("),
    extractBetween(html, "function submittedCommandTarget(", "function navigateToResourceTarget("),
    'handleUiCommandStatus({ type: "uiCommandStatus", clientActionId: "clear-1", command: "clearTmuxTaskTabs", status: "failed", message: "已关闭 1/2 个任务标签。失败 1 个：zlk-gpu-0:3（busy）" });',
  ].join("\n");
  vm.runInNewContext(script, context);
  assert.equal(context.tmuxWindowFilter, "zlk-gpu-0");
  assert.equal(context.tmuxSelectedWorkerId, "NWPU3");
  assert.equal(context.tmuxClearTaskTabsBusy, false);
  assert.deepEqual(posted, ["list", "capture"]);
  assert.match(toasts[0], /zlk-gpu-0:3/);
  assert.equal(Object.keys(context.pendingActionsById).length, 0);
});
