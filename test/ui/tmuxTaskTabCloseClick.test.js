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
    classList: { contains: (name) => classes.has(name) },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    closest(selector) {
      if (selector === "[data-tmux-close]" && this.hasAttribute("data-tmux-close")) return this;
      if (selector === "button[data-tmux-worker]" && this.hasAttribute("data-tmux-worker")) return this;
      if (selector === "button[data-tmux-pane]" && this.hasAttribute("data-tmux-pane")) return this;
      if (selector === "button[data-tmux-task-target]" && this.hasAttribute("data-tmux-task-target")) return this;
      if (selector === "[data-tmux-filter]" && this.hasAttribute("data-tmux-filter")) return this;
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

test("GPU task close survives capture and still selects a Worker button", () => {
  const html = renderPanelHtml();
  const posted = [];
  const toasts = [];
  const elements = {};
  const listeners = [];
  const document = {
    addEventListener(type, handler, capture) {
      listeners.push({ type, handler, capture: capture === true });
    },
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
    tmuxConfiguredWorkers: [{ id: "worker-a" }, { id: "worker-b" }],
    tmuxListsByWorker: {
      "worker-a": {
        workerId: "worker-a",
        fetchedAt: "t0",
        sessions: [{
          name: "zlk-gpu-0",
          windows: [
            { index: "2", target: "zlk-gpu-0:2", windowId: '@2', name: 'run-active', panes: [{ id: '%2' }], task: { status: "running", case: "case-a", seed: 1 }, active: true },
            { index: "3", target: "zlk-gpu-0:3", task: { status: "failed", case: "case-b", seed: 2 } },
            { index: '4', target: 'zlk-gpu-0:4', windowId: '@4', name: 'run-old-completed', panes: [{ id: '%4' }], task: null },
          ],
        }],
      },
      "worker-b": { workerId: "worker-b", fetchedAt: "t0", sessions: [] },
    },
    tmuxSelectedWorkerId: "worker-a",
    tmuxWindowFilter: "zlk-gpu-0",
    tmuxSelectedTaskTarget: "zlk-gpu-0:2",
    tmuxSelectedPaneTarget: "",
    tmuxListCache: null,
    tmuxLastCaptureTarget: "",
    tmuxJobLogSelection: null,
    tmuxJobLogJumpTimeout: 0,
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
  context.tmuxListCache = context.tmuxListsByWorker["worker-a"];
  const captureStart = html.indexOf('document.addEventListener("click", function(event) {\n        const button = event.target && event.target.closest && event.target.closest("button[data-tmux-worker]");');
  const captureEnd = html.indexOf("}, true);", captureStart);
  assert.ok(captureStart >= 0 && captureEnd > captureStart);
  const currentCapture = html.slice(captureStart, captureEnd + "}, true);".length);
  const guard = 'if (!button || button.hasAttribute("data-tmux-close") || button.classList.contains("tmuxTaskTabClose") || button.hasAttribute("data-tmux-clear-task-tabs") || button.classList.contains("tmuxClearTaskTabs")) return;';
  assert.match(currentCapture, /button\[data-tmux-worker\]/);
  assert.ok(currentCapture.includes(guard));
  const oldCapture = currentCapture.replace(guard, "if (!button) return;");
  assert.equal(oldCapture.includes("data-tmux-close"), false);
  const closeHandler = extractBetween(html, 'const tmuxCloseTarget = event.target.closest("[data-tmux-close]");', 'const tmuxPaneButton = event.target.closest("button[data-tmux-pane]")');
  const script = [
    extractBetween(html, "function esc(value)", "function cssEscape("),
    extractBetween(html, "function normalizeTmuxWindowFilter(", "function renderTmuxWorkersOverview("),
    extractBetween(html, "function selectTmuxWorker(", "async function refreshTmuxList("),
    extractBetween(html, "function cancelJobTmuxLogJump(", "function failJobTmuxLogJump("),
    extractBetween(html, "function createClientActionId(", "function pendingKeyForButton("),
    "function renderTmuxWorkersOverview(){}",
    "function bubbleClick(event){",
    closeHandler,
    "}",
    'document.addEventListener("click", bubbleClick, false);',
    "renderTmuxOverview(tmuxListCache.sessions);",
  ].join("\n");
  vm.runInNewContext(script, context);
  const overview = elements.tmuxOverview.innerHTML;
  const closeTag = overview.slice(overview.indexOf('class="tmuxTaskTabClose"') - 28, overview.indexOf('class="tmuxTaskTabClose"') + 280);
  assert.match(closeTag, /data-tmux-close="zlk-gpu-0:2"/);
  assert.match(closeTag, /data-tmux-close-worker="worker-a"/);
  assert.doesNotMatch(closeTag, /data-tmux-worker=/);
  const renderedClose = elementFromTag(closeTag);
  const oldClose = elementFromTag(closeTag);
  oldClose.attrs["data-tmux-worker"] = "worker-b";

  vm.runInNewContext(oldCapture, context);
  const oldListeners = listeners.filter((item) => item.type === "click" && item.capture);
  assert.equal(oldListeners.length, 1);
  const collided = clickEvent(oldClose);
  oldListeners[0].handler(collided);
  assert.equal(collided.stopped, true);
  assert.equal(context.tmuxSelectedWorkerId, "worker-b");
  assert.equal(context.tmuxWindowFilter, "all");
  assert.equal(posted.filter((item) => item.command === "killTmuxWindow").length, 0);

  context.tmuxSelectedWorkerId = "worker-a";
  context.tmuxWindowFilter = "zlk-gpu-0";
  context.tmuxListCache = context.tmuxListsByWorker["worker-a"];
  posted.length = 0;
  listeners.length = 0;
  vm.runInNewContext(`${currentCapture}\ndocument.addEventListener("click", bubbleClick, false);`, context);
  const capture = listeners.filter((item) => item.type === "click" && item.capture);
  const bubble = listeners.filter((item) => item.type === "click" && !item.capture);
  assert.equal(capture.length, 1);
  assert.equal(bubble.length, 1);
  const closeClick = clickEvent(renderedClose);
  capture[0].handler(closeClick);
  assert.equal(closeClick.stopped, false);
  bubble[0].handler(closeClick);
  const kills = posted.filter((item) => item.command === "killTmuxWindow");
  assert.equal(kills.length, 1);
  assert.equal(kills[0].workerId, "worker-a");
  assert.equal(kills[0].target, "zlk-gpu-0:2");
  assert.equal(kills[0].window, "zlk-gpu-0:2");
  assert.equal(kills[0].session, "zlk-gpu-0");
  assert.equal(kills[0].identity.windowId, '@2');
  assert.equal(context.tmuxWindowFilter, "zlk-gpu-0");
  assert.equal(context.tmuxSelectedWorkerId, "worker-a");
  assert.equal(toasts.length, 0);

  const guarded = elementFromTag(closeTag);
  guarded.attrs["data-tmux-worker"] = "worker-b";
  posted.length = 0;
  const guardedClick = clickEvent(guarded);
  capture[0].handler(guardedClick);
  assert.equal(guardedClick.stopped, false);
  bubble[0].handler(guardedClick);
  assert.equal(posted.filter((item) => item.command === "killTmuxWindow").length, 1);
  assert.equal(context.tmuxWindowFilter, "zlk-gpu-0");
  assert.equal(context.tmuxSelectedWorkerId, "worker-a");

  const workerTag = '<button type="button" class="secondary" data-tmux-worker="worker-b"></button>';
  const workerClick = clickEvent(elementFromTag(workerTag));
  context.tmuxJobLogSelection = { status: "waiting", workerId: "worker-a" };
  capture[0].handler(workerClick);
  assert.equal(workerClick.stopped, true);
  assert.equal(context.tmuxSelectedWorkerId, "worker-b");
  assert.equal(context.tmuxWindowFilter, "all");
  assert.equal(context.tmuxJobLogSelection, null, "explicit Worker navigation cancels a pending job jump");

  // Pruning the task snapshot must not remove the ability to close its real server window.
  context.tmuxSelectedWorkerId = 'worker-a';
  context.tmuxListCache = context.tmuxListsByWorker['worker-a'];
  context.tmuxWindowFilter = 'all';
  vm.runInNewContext('renderTmuxOverview(tmuxListCache.sessions);', context);
  const oldTag = elements.tmuxOverview.innerHTML.match(/<button[^>]+data-tmux-close="zlk-gpu-0:4"[^>]*>/)?.[0];
  assert.ok(oldTag, 'overview offers an explicit server close for an unbound historical window');
  posted.length = 0;
  const oldClick = clickEvent(elementFromTag(oldTag));
  capture[0].handler(oldClick);
  bubble[0].handler(oldClick);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].command, 'killTmuxWindow');
  assert.equal(posted[0].identity.windowId, '@4');
  assert.equal(posted[0].identity.windowName, 'run-old-completed');
  assert.deepEqual(Array.from(posted[0].identity.paneIds), ['%4']);
});
