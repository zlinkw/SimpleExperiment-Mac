const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

function harness() {
  const html = renderPanelHtml();
  const between = (start, end) => {
    const from = html.indexOf(start), to = html.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, start);
    return html.slice(from, to);
  };
  const elements = {};
  const sessions = [0, 1].map(gpu => ({ name: "zlk-gpu-" + gpu, windows: [
    { index: "0", name: "bash", windowId: "@" + (gpu * 2), panes: [{ id: "%" + (gpu * 2), command: "bash" }] },
    { index: "1", name: "run-" + gpu, windowId: "@" + (gpu * 2 + 1), task: { commandId: "job-" + gpu, case: "case-" + gpu, seed: 42, status: gpu ? "running" : "failed" }, panes: [{ id: "%" + (gpu * 2 + 1), command: "python" }] },
  ] }));
  sessions.push({ name: "m1mechanism", windows: Array.from({ length: 17 }, (_, i) => ({ index: String(i), name: "mechanism-" + i, panes: [{ target: "m1mechanism:" + i + ".0", command: "bash" }] })) });
  sessions.push({ name: "zlk-worker-agent", windows: [{ index: "0", name: "agent", panes: [] }] });
  const requests = [];
  const context = vm.createContext({
    tmuxListCache: { workerId: "NWPU5", tmuxSessionPrefix: "zlk", sessions, gpuIds: ["0", "1"], fetchedAt: "t0" },
    tmuxWindowFilter: "all", tmuxSelectedTaskTarget: "", tmuxSelectedPaneTarget: "", tmuxSelectedWorkerId: "NWPU5", tmuxClearTaskTabsBusy: false,
    tmuxLastCaptureTarget: "old", tmuxCaptureBusy: new Set(), document: { hidden: false },
    vscode: { postMessage: message => requests.push(message) },
    el: id => elements[id] || (elements[id] = { innerHTML: "", textContent: "", value: "", options: [], open: false, dataset: {} }),
  });
  vm.runInContext(between("function esc(value)", "function cssEscape(") + between("function normalizeTmuxWindowFilter(", "function renderTmuxWorkersOverview("), context);
  vm.runInContext(between("function tmuxResolveCaptureTarget()", "function decodeCapturedText(")
    + between("async function refreshTmuxCapture()", "function scheduleTmuxPoll()"), context);
  const render = () => vm.runInContext("renderTmuxOverview(tmuxListCache.sessions)", context);
  return { context, elements, render, requests };
}

test("GPU overview never downloads pane history and releases previously selected output", async () => {
  const f = harness();
  f.render();
  f.elements.tmuxWindowSelect.value = "zlk-gpu-0:1";
  f.elements.tmuxCapturePre = { textContent: "previous log".repeat(1000), dataset: { captureTarget: "old", lastFetch: "old" } };
  for (let index = 0; index < 5; index++) await f.context.refreshTmuxCapture();
  assert.equal(f.requests.length, 0, "overview polling must fetch metadata only");
  assert.equal(f.elements.tmuxCapturePre.textContent, "");
  assert.equal(f.elements.tmuxCapturePre.dataset.captureTarget, "");
  assert.equal(f.context.tmuxLastCaptureTarget, "");
  if (process.env.TMUX_LIVE_INVENTORY) {
    const inventory = JSON.parse(process.env.TMUX_LIVE_INVENTORY);
    assert.equal(inventory.ok, true);
    f.context.tmuxListCache = inventory;
    f.context.tmuxSelectedWorkerId = inventory.workerId;
    f.render();
    const folded = f.elements.tmuxOverview.innerHTML.indexOf('<details id="tmuxOtherOverview"');
    assert.ok(folded >= 0);
    const primary = f.elements.tmuxOverview.innerHTML.slice(0, folded);
    for (const session of inventory.sessions.filter(row => row.name.startsWith(inventory.tmuxSessionPrefix + "-gpu-"))) {
      const header = f.elements.tmuxOverview.innerHTML.indexOf("<b>" + session.name + "</b>");
      assert.ok(header >= 0);
      for (const window of session.windows) {
        const target = session.name + ":" + window.index;
        const present = primary.includes('data-tmux-filter="' + target + '"');
        assert.equal(present, Boolean(window.task), target);
      }
    }
    await f.context.refreshTmuxCapture();
    assert.equal(f.requests.length, 0, "the real server inventory must not trigger historical captures either");
  }
});

test("a late capture cannot restore cleared output after returning to overview", async () => {
  const f = harness();
  f.render();
  f.elements.tmuxCapturePre = { textContent: "selected output", dataset: { captureTarget: "zlk-gpu-0:1" } };
  f.elements.tmuxCaptureMeta = { textContent: "old" };
  f.context.tmuxWindowFilter = "zlk-gpu-0";
  await f.context.refreshTmuxCapture();
  assert.equal(f.requests[0].window, "zlk-gpu-0:1");
  f.context.tmuxWindowFilter = "all";
  await f.context.refreshTmuxCapture();
  const html = renderPanelHtml();
  const start = html.indexOf('if (item.type === "tmuxCapture")');
  const end = html.indexOf('if (item.type === "tensorboardSwitchStatus")', start);
  assert.ok(start >= 0 && end > start);
  f.context.decodeCapturedText = String;
  vm.runInContext('for (const item of [{type:"tmuxCapture",workerId:"NWPU5",window:"zlk-gpu-0:1",text:"late old output"}]) { '
    + html.slice(start, end) + ' }', f.context);
  assert.equal(f.elements.tmuxCapturePre.textContent, "");
  assert.equal(f.requests.length, 1);
});

test("empty GPU and removed explicit window never fall back to historical consoles", async () => {
  const f = harness();
  f.render();
  f.context.tmuxListCache.sessions[0].windows = [{ index: "0", name: "bash" }, { index: "7", name: "run-old" }];
  for (const filter of ["zlk-gpu-0", "gpu-slot:2", "zlk-gpu-0:9", "missing:0"]) {
    f.context.tmuxWindowFilter = filter;
    assert.equal(f.context.tmuxResolveCaptureTarget(), "", filter);
    await f.context.refreshTmuxCapture();
  }
  assert.equal(f.requests.length, 0);
  f.context.tmuxWindowFilter = "zlk-gpu-0:7";
  await f.context.refreshTmuxCapture();
  assert.equal(f.requests.length, 1, "explicit selection of an existing old server window remains available");
  assert.equal(f.requests[0].window, "zlk-gpu-0:7");
});

test("GPU windows stay out of the ordinary overview and appear only after explicit GPU selection", () => {
  const f=harness();
  f.context.tmuxListCache.sessions[0].windows.push({index:'7',name:'run-old',panes:[{target:'zlk-gpu-0:7.0',command:'bash'}]});
  f.render(); const html=f.elements.tmuxOverview.innerHTML;
  const folded=html.indexOf('<details id="tmuxOtherOverview"');assert.ok(folded>=0);
  assert.doesNotMatch(html,/run-old|run-0|data-tmux-filter="zlk-gpu-0:7"/);
  assert.doesNotMatch(html.slice(folded,html.indexOf('>',folded)+1),/\bopen\b/);
  f.context.tmuxWindowFilter='zlk-gpu-0';f.render();
  assert.match(f.elements.tmuxOverview.innerHTML,/data-tmux-task-target="zlk-gpu-0:1"/);
  assert.match(f.elements.tmuxOverview.innerHTML,/data-tmux-task-target="zlk-gpu-0:7"/);
  assert.match(f.elements.tmuxOverview.innerHTML,/case-0 · seed 42 · 失败/);
  assert.doesNotMatch(f.elements.tmuxOverview.innerHTML,/m1mechanism/);

});

test("unrelated tmux windows are folded outside the GPU cards and overview", () => {
  const { elements, render } = harness();
  render();
  const bar = elements.tmuxFilterBar.innerHTML;
  assert.doesNotMatch(bar, /<details|m1mechanism|zlk-worker-agent/);
  assert.equal((bar.match(/data-tmux-filter=/g) || []).length, 3);
  const overview = elements.tmuxOverview.innerHTML;
  const overviewFolded = overview.indexOf('<details id="tmuxOtherOverview"');
  assert.ok(overviewFolded > 0);
  const service=overview.indexOf('<details id="tmuxServicesOverview"');
  assert.ok(service>=0 && service<overviewFolded);
  assert.doesNotMatch(overview.slice(0,service),/m1mechanism|zlk-worker-agent/);
  assert.match(overview.slice(service,overviewFolded),/zlk-worker-agent/);
  assert.doesNotMatch(overview.slice(service,overviewFolded),/m1mechanism/);
  assert.equal((overview.match(/<details/g) || []).length, 2);
  assert.doesNotMatch(overview.slice(overviewFolded, overview.indexOf(">", overviewFolded) + 1), /\bopen\b/);
  assert.match(overview.slice(overviewFolded), /data-tmux-filter="m1mechanism:16"/);
  assert.match(overview.slice(overviewFolded), /data-tmux-close="m1mechanism:16"/);
  assert.match(elements.tmuxListMeta.textContent, /GPU 2.*任务标签 2.*我的其他会话 0.*其他前缀 1/);
});

test("selecting an ordinary window reveals its exact target and pane", () => {
  const { context, elements, render } = harness();
  context.tmuxWindowFilter = "m1mechanism:12";
  const win=context.tmuxListCache.sessions.find(row=>row.name==="m1mechanism").windows[12];
  win.panes.push({target:"m1mechanism:12.1",command:"bash"});
  render();
  assert.doesNotMatch(elements.tmuxFilterBar.innerHTML, /<details/);
  assert.equal(elements.tmuxWindowSelect.value, "m1mechanism:12");
  assert.match(elements.tmuxOverview.innerHTML, /data-tmux-pane="m1mechanism:12\.0"/);
});

test("expanded disclosures survive polling and GPU order stays physical", () => {
  const { context, elements, render } = harness();
  render();
  elements.tmuxOtherOverview.open = true;
  context.tmuxListCache.sessions[1].windows[1].active = true;
  render();
  assert.doesNotMatch(elements.tmuxFilterBar.innerHTML, /<details/);
  assert.match(elements.tmuxOverview.innerHTML, /<details id="tmuxOtherOverview"[^>]*\bopen\b/);
  assert.ok(elements.tmuxFilterBar.innerHTML.indexOf('data-tmux-filter="zlk-gpu-0"') < elements.tmuxFilterBar.innerHTML.indexOf('data-tmux-filter="zlk-gpu-1"'));
});

test("GPU selection retains job labels and a synthetic idle GPU stays visible", () => {
  const { context, elements, render } = harness();
  context.tmuxWindowFilter = "zlk-gpu-1";
  context.tmuxListCache.gpuIds.push("2");
  render();
  assert.match(elements.tmuxFilterBar.innerHTML, /data-tmux-filter="gpu-slot:2"/);
  assert.match(elements.tmuxOverview.innerHTML, /case-1 · seed 42 · 运行中/);
  assert.match(elements.tmuxOverview.innerHTML, /data-tmux-task-target="zlk-gpu-1:1"/);
  assert.doesNotMatch(elements.tmuxOverview.innerHTML, /m1mechanism/);
});

test("a Worker with only ordinary sessions still offers their windows without inventing GPU tasks", () => {
  const { context, elements, render } = harness();
  context.tmuxListCache.sessions = context.tmuxListCache.sessions.filter(session => !session.name.startsWith("zlk-gpu-"));
  context.tmuxListCache.gpuIds = [];
  render();
  assert.match(elements.tmuxFilterBar.innerHTML, /GPU 总览<\/span><b>0/);
  assert.doesNotMatch(elements.tmuxFilterBar.innerHTML, /data-tmux-filter="m1mechanism:0"/);
  assert.match(elements.tmuxOverview.innerHTML, /data-tmux-filter="m1mechanism:0"/);
  assert.match(elements.tmuxOverview.innerHTML, /<details id="tmuxOtherOverview"[^>]*><summary>/);
  assert.match(elements.tmuxListMeta.textContent, /GPU 0.*任务标签 0.*我的其他会话 0.*其他前缀 1/);
});

test("empty inventory keeps idle GPU slots and does not leave an empty ordinary-session disclosure", () => {
  const { context, elements, render } = harness();
  context.tmuxListCache.sessions = [];
  render();
  assert.match(elements.tmuxFilterBar.innerHTML, /data-tmux-filter="gpu-slot:0"/);
  assert.match(elements.tmuxFilterBar.innerHTML, /data-tmux-filter="gpu-slot:1"/);
  assert.doesNotMatch(elements.tmuxFilterBar.innerHTML, /<details/);
});

test("configured namespace counts physical GPUs once and each raw window appears in exactly one section", () => {
  const { context, elements, render } = harness();
  context.tmuxListCache.gpuIds = ["0", "1", "2", "3"];
  for (let gpu = 0; gpu < 4; gpu++) context.tmuxListCache.sessions.push({ name: "lwb-gpu-" + gpu,
    windows: [{ index: "1", name: "foreign-job-" + gpu, panes: [] }] });
  context.tmuxListCache.sessions.at(-1).windows.push({ index: "2", name: "zlk-gpu-2", panes: [] });
  context.tmuxListCache.sessions.push({ name: "zlk-gpu-3", windows: [{ index: "0", name: "bash", windowId: "@8", panes: [] }] });
  render();
  const bar = elements.tmuxFilterBar.innerHTML, overview = elements.tmuxOverview.innerHTML;
  assert.match(bar, /GPU 总览<\/span><b>4/);
  assert.doesNotMatch(bar, /lwb-gpu-|<details/);
  assert.match(bar, /data-tmux-filter="gpu-slot:2"/);
  assert.equal((bar.match(/data-tmux-close-gpu-session=/g) || []).length, 3);
  const fold = overview.indexOf('<details id="tmuxOtherOverview"');
  assert.equal((overview.match(/<details/g) || []).length, 2);
  assert.doesNotMatch(overview.slice(0, fold), /lwb-gpu-|zlk-gpu-3|0:bash/);
  for (const session of context.tmuxListCache.sessions) for (const win of session.windows) {
    const marker = 'data-tmux-filter="' + session.name + ':' + win.index + '"';
    const ownGpu=session.name.startsWith("zlk-gpu-");
    assert.equal(overview.split(marker).length - 1, ownGpu?0:1, marker);
    if(ownGpu) {context.tmuxWindowFilter=session.name;render();
      assert.equal(elements.tmuxOverview.innerHTML.split('data-tmux-task-target="'+session.name+':'+win.index+'"').length-1,1,marker);}
  }
  context.tmuxListCache.tmuxSessionPrefix = "lwb";
  render();
  assert.match(elements.tmuxFilterBar.innerHTML, /GPU 总览<\/span><b>4/);
  assert.doesNotMatch(elements.tmuxFilterBar.innerHTML, /data-tmux-filter="zlk-gpu-/);
  assert.match(elements.tmuxFilterBar.innerHTML, /data-tmux-filter="lwb-gpu-3"/);
});

test("GPU card close submits a frozen stable batch without changing filters or bypassing host confirmation", () => {
  const f = harness(); f.render();
  const html = renderPanelHtml();
  const start = html.indexOf('const gpuSessionClose = event.target.closest("[data-tmux-close-gpu-session]");');
  const end = html.indexOf('const tmuxClearTaskTabs =', start);
  assert.ok(start >= 0 && end > start);
  f.context.pendingActionsById = {};
  f.context.createClientActionId = () => "batch-action";
  f.context.showToast = () => {};
  vm.runInContext('function closeCard(event) { ' + html.slice(start, end) + ' }', f.context);
  const tag = f.elements.tmuxFilterBar.innerHTML.match(/<button[^>]+data-tmux-close-gpu-session="zlk-gpu-0"[^>]*>/)?.[0];
  assert.ok(tag);
  const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')]));
  const button = { disabled: false, getAttribute: key => attrs[key] };
  const event = { prevented: false, stopped: false, target: { closest: () => button },
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  f.context.closeCard(event);
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.command, "killTmuxWindow"); assert.equal(request.gpuSession, "zlk-gpu-0");
  assert.equal(request.workerId, "NWPU5"); assert.equal(request.confirm, undefined);
  assert.deepEqual(Array.from(request.identities, row => row.windowId), ["@0", "@1"]);
  assert.deepEqual(Array.from(request.identities[1].paneIds), ["%1"]);
  assert.equal(request.identities[1].taskCommandId, "job-0");
  assert.equal(f.context.tmuxWindowFilter, "all");
  f.context.closeCard(event);
  assert.equal(f.requests.length, 1, "double click must not duplicate the pending batch");
  for (const change of [() => { button.disabled = true; }, () => { button.disabled = false; attrs['data-tmux-close-worker'] = 'another-worker'; },
    () => { attrs['data-tmux-close-worker'] = 'NWPU5'; f.context.tmuxListCache.tmuxSessionPrefix = 'other-user'; }]) {
    f.context.pendingActionsById = {}; change(); f.context.closeCard(event);
    assert.equal(f.requests.length, 1);
  }
});

test("missing configured namespace offers no GPU session close authority", () => {
  const f=harness();f.context.tmuxListCache.tmuxSessionPrefix='';f.render();
  assert.doesNotMatch(f.elements.tmuxFilterBar.innerHTML,/data-tmux-close-gpu-session=/);
  assert.match(f.elements.tmuxFilterBar.innerHTML,/data-tmux-filter="zlk-gpu-0"/);
  assert.match(f.elements.tmuxFilterBar.innerHTML,/data-tmux-filter="zlk-gpu-1"/);
  assert.equal(f.requests.length,0);
});
