const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.legacy.js");

function planSection(html) {
  const start = html.indexOf('data-section="plans"');
  const end = html.indexOf('data-section="gpu"');
  assert.ok(start > 0 && end > start);
  return html.slice(start, end);
}

function elementDepth(html, id) {
  const token = 'id="' + id + '"';
  const at = html.indexOf(token);
  assert.ok(at > 0, id);
  const before = html.slice(0, at);
  const opens = (before.match(/<div\b/g) || []).length;
  const closes = (before.match(/<\/div>/g) || []).length;
  return opens - closes;
}

test("rendered plan section closes planQuickGrid before the phase line and cards", () => {
  const html = renderPanelHtml();
  const section = planSection(html);
  const gridStart = section.indexOf('id="planQuickGrid"');
  const actionsStart = section.indexOf('class="planQuickActions"');
  const actionsClose = section.indexOf("</div>", actionsStart);
  const gridClose = section.indexOf("</div>", actionsClose + 6);
  const phaseAt = section.indexOf('id="planCommandPhaseLine"');
  const cardsAt = section.indexOf('id="recentPlans"');
  assert.ok(gridStart > 0 && actionsStart > gridStart && actionsClose > actionsStart && gridClose > actionsClose && phaseAt > gridClose && cardsAt > phaseAt);
  assert.equal(elementDepth(section, "planCommandPhaseLine"), elementDepth(section, "planQuickGrid"));
  assert.equal(elementDepth(section, "recentPlans"), elementDepth(section, "planQuickGrid"));
  const actionsBefore = section.slice(0, actionsStart);
  const actionsDepth = (actionsBefore.match(/<div\b/g) || []).length - (actionsBefore.match(/<\/div>/g) || []).length;
  assert.ok(actionsDepth > elementDepth(section, "planQuickGrid"));
  assert.match(html, /\.planQuickGrid \{[^}]*grid-template-columns:[^}]*\}/);
  assert.match(html, /\.commandPhaseLine \{[^}]*white-space:\s*nowrap/);
  assert.match(html, /\.commandPhaseLine \{[^}]*text-overflow:\s*ellipsis/);
  assert.match(html, /\.commandPhaseLine:empty \{[^}]*display:\s*none/);
  assert.doesNotMatch(section.slice(section.indexOf('id="planCommandPhaseLine"'), section.indexOf('id="recentPlans"')), /grid-column:\s*1\s*\/\s*-1/);
});

test("renderCommandPhaseLine writes plan commands only into the plan status", () => {
  const html = renderPanelHtml();
  const scriptStart = html.indexOf("<script nonce=");
  const script = html.slice(scriptStart);
  const phaseStart = script.indexOf("function planPhaseCommand");
  const renderEnd = script.indexOf("function commandNeedsLoading");
  assert.ok(phaseStart > 0 && renderEnd > phaseStart);
  const hosts = {
    commandPhaseLine: { textContent: "stale", title: "", classList: { toggle() {} } },
    planCommandPhaseLine: { textContent: "stale", title: "", classList: { toggle() {} } }
  };
  const sandbox = {
    pendingActionsById: {
      tmux: { command: "fetchTmuxList", label: "列出 sessions", message: "fetchTmuxList：正在执行." },
      plan: { command: "validatePlan", label: "校验", message: "正在校验计划" }
    },
    el(id) { return hosts[id]; }
  };
  vm.runInNewContext(script.slice(phaseStart, renderEnd) + "\nrenderCommandPhaseLine();", sandbox);
  assert.match(hosts.commandPhaseLine.textContent, /fetchTmuxList|列出 sessions|校验/);
  assert.match(hosts.planCommandPhaseLine.textContent, /校验：正在校验计划/);
  assert.doesNotMatch(hosts.planCommandPhaseLine.textContent, /fetchTmuxList/);
  assert.equal(hosts.planCommandPhaseLine.title, hosts.planCommandPhaseLine.textContent);

  sandbox.pendingActionsById = {
    tmux: { command: "fetchTmuxList", label: "列出 sessions", message: "fetchTmuxList：正在执行." }
  };
  hosts.planCommandPhaseLine.textContent = "leftover";
  hosts.commandPhaseLine.textContent = "";
  vm.runInNewContext(script.slice(phaseStart, renderEnd) + "\nrenderCommandPhaseLine();", sandbox);
  assert.equal(hosts.planCommandPhaseLine.textContent, "");
  assert.match(hosts.commandPhaseLine.textContent, /fetchTmuxList|列出 sessions/);

  const longMessage = "正在校验计划 " + "路径".repeat(120);
  const fullPlanText = "校验并提交运行：" + longMessage;
  sandbox.pendingActionsById = {
    plan: { command: "runPlan", label: "校验并提交运行", message: longMessage }
  };
  vm.runInNewContext(script.slice(phaseStart, renderEnd) + "\nrenderCommandPhaseLine();", sandbox);
  assert.ok(hosts.planCommandPhaseLine.textContent.length <= 160);
  assert.ok(fullPlanText.length > 160);
  assert.match(hosts.planCommandPhaseLine.textContent, /校验并提交运行/);
  assert.match(hosts.commandPhaseLine.textContent, /校验并提交运行/);
  assert.equal(hosts.planCommandPhaseLine.title, fullPlanText);
  assert.equal(hosts.commandPhaseLine.title, fullPlanText);
  assert.notEqual(hosts.planCommandPhaseLine.title, hosts.planCommandPhaseLine.textContent);

  sandbox.pendingActionsById = {};
  vm.runInNewContext(script.slice(phaseStart, renderEnd) + "\nrenderCommandPhaseLine();", sandbox);
  assert.equal(hosts.planCommandPhaseLine.textContent, "");
  assert.equal(hosts.commandPhaseLine.textContent, "");
  assert.equal(hosts.planCommandPhaseLine.classList.busy, undefined);
});

test("automatic tmux refresh stays out of command progress and releases a lost reply", async () => {
  const html = renderPanelHtml();
  const from = html.indexOf("async function refreshTmuxList()");
  const to = html.indexOf("function tmuxResolveCaptureTarget", from);
  const sent = [];
  const timers = new Map();
  let timerId = 0;
  const sandbox = {
    document: { hidden: false }, tmuxListBusy: false, tmuxListTimeout: 0,
    tmuxListRequestId: 0, tmuxListPendingWorkers: new Set(),
    tmuxInitialRetryTimer: 0,
    tmuxInitialRetryCount: 0,
    tmuxSelectedWorkerId: "configured-worker", pendingActionsById: {}, pendingActionTimeouts: {},
    el: () => ({ textContent: "" }), createClientActionId: () => "poll-action",
    vscode: { postMessage: (payload) => sent.push(payload) },
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(html.slice(from, to), sandbox);
  await sandbox.refreshTmuxList();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].background, true);
  assert.equal(sent[0].clientActionId, undefined);
  assert.equal(Object.keys(sandbox.pendingActionsById).length, 0);
  assert.equal(timers.size, 1);
  await sandbox.refreshTmuxList();
  assert.equal(sent.length, 1, "overlapping polls must coalesce");
  [...timers.values()][0]();
  assert.equal(sandbox.tmuxListBusy, false, "a lost reply must not freeze subsequent polls");
});

test("a persisted local wait is labelled as waiting rather than submitting", () => {
  const html = renderPanelHtml();
  const from = html.indexOf("function executionSubmissionLabel");
  const to = html.indexOf("function executionNewerSubmission", from);
  const sandbox = {};
  vm.runInNewContext(html.slice(from, to), sandbox);
  assert.equal(sandbox.executionSubmissionLabel({ type: "run-plan", status: "queued", localSubmissionProgress: true }), "等待继续提交");
  assert.equal(sandbox.executionSubmissionLabel({ type: "run-plan", status: "running", localSubmissionProgress: true }), "提交中");
});
