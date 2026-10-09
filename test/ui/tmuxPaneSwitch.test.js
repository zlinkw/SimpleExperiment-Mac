const assert = require("node:assert/strict");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

test("tmux detail exposes a button per pane and captures the selected pane", () => {
  const source = readSource("src/ui/PanelHtml.ts");
  assert.match(source, /data-tmux-pane=/);
  assert.match(source, /event\.target\.closest\("button\[data-tmux-pane\]"\)/);
  assert.match(source, /tmuxSelectedPaneTarget = String\(tmuxPaneButton\.getAttribute\("data-tmux-pane"\)/);
  assert.match(source, /return tmuxSelectedPaneTarget;/);
  assert.match(source, /panes\.some\(function\(p\)\{ return p\.target === tmuxSelectedPaneTarget; \}\)/);
});

test("tmux close has its own button and asks in the extension host", () => {
  const panel = readSource("src/ui/PanelHtml.legacy.ts");
  const extension = readSource("src/extension/legacy.ts");
  const render = panel.slice(panel.indexOf("function renderTmuxFilterBar("), panel.indexOf("function renderTmuxOverview("));
  const overview = panel.slice(panel.indexOf("function renderTmuxOverview("), panel.indexOf("function renderTmuxWorkersOverview("));
  const handler = panel.slice(panel.indexOf('const tmuxCloseTarget = event.target.closest("[data-tmux-close]")'), panel.indexOf('const tmuxPaneButton = event.target.closest("button[data-tmux-pane]")'));
  const host = extension.slice(extension.indexOf("async killTmuxWindowFromUi("), extension.indexOf("async openTensorBoardUrlFromUi("));
  const taskClose = panel.slice(panel.indexOf('function tmuxWindowCloseButton('), panel.indexOf('function getTmuxWindowCandidates('));
  assert.match(render, /tmuxWindowCloseButton\(c.window, c.sessName, "tmuxClose"\)/);
  assert.match(render, /c\.category === "gpu" \|\| c\.synthetic/);
  assert.match(render, /: closeHtml/);
  assert.match(taskClose, /data-tmux-close/);
  assert.match(taskClose, /data-tmux-close-worker/);
  assert.doesNotMatch(taskClose, /data-tmux-worker=/);
  assert.doesNotMatch(taskClose, /data-tmux-close="' \+ escAttr\(foundSess\.name/);
  assert.match(overview, /tmuxWindowCloseButton\(win, foundSess.name \|\| "", "tmuxTaskTabClose"\)/);
  assert.match(handler, /data-tmux-close-worker/);
  const capture = panel.slice(panel.indexOf('document.addEventListener("click", function(event)'), panel.indexOf('if (btn) btn.addEventListener("click", refreshTmuxCapture)'));
  assert.match(capture, /button\.hasAttribute\("data-tmux-close"\)/);
  assert.doesNotMatch(handler, /window\.confirm/);
  assert.match(handler, /workerId: closeWorkerId/);
  assert.match(handler, /vscode\.postMessage\(\{ command: "killTmuxWindow"/);
  assert.match(host, /showWarningMessage\([\s\S]*?\{ modal: true \}, "关闭窗口"/);
  assert.match(host, /const body = \{ \.\.\.identity, window: identity.target, session, confirm: true/);
  const performKill = host.slice(host.indexOf("async performKillTmuxWindow("));
  assert.doesNotMatch(performKill, /message\?\.session/);
  assert.match(performKill, /tmuxKillSessionFromTarget\(target\)/);
  assert.match(host, /progress\.report\(\{ message: `Agent 拒绝关闭：\$\{text\}`/);
  assert.match(host, /原窗口仍在 tmux 列表/);
  assert.match(host, /transportError/);
});
