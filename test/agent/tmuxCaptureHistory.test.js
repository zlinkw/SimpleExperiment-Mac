const assert = require("node:assert/strict");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

test("tmux capture returns unmodified scrollback instead of only the visible viewport", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  const route = source.slice(source.indexOf('if route == "/api/tmux/capture"'), source.indexOf('if route == "/api/tmux/list"'));
  assert.match(route, /requested_lines == "all"/);
  assert.match(route, /start_line = "-"/);
  assert.match(route, /"capture-pane", "-p", "-S", start_line/);
  assert.doesNotMatch(route, /"-J"/);
  assert.match(route, /"text": text/);
  assert.doesNotMatch(route, /_tmux_focus_diagnostic_text/);
});

test("extension forwards the Agent capture without filtering or truncating it", () => {
  const source = readSource("src/extension.ts");
  const block = source.slice(source.indexOf("async fetchTmuxCaptureFromUi("), source.indexOf("async fetchTmuxListFromUi("));
  assert.match(block, /const text = String\(result\?\.text \|\| result\?\.output \|\| ""\);/);
  assert.match(block, /lines=all/g);
  assert.doesNotMatch(block, /rawText\.slice|focus:/);
});

test("tmux refresh keeps manual scroll position and follows output only at the bottom", () => {
  const source = readSource("src/ui/PanelHtml.ts");
  const block = source.slice(source.indexOf('if (item.type === "tmuxCapture")'), source.indexOf('if (item.type === "tensorboardSwitchStatus")'));
  assert.match(block, /const wasNearBottom =/);
  assert.match(block, /const previousTop = pre\.scrollTop;/);
  assert.match(block, /if \(wasNearBottom\) pre\.scrollTop = pre\.scrollHeight - pre\.clientHeight;/);
  assert.match(block, /else pre\.scrollTop = previousTop;/);
  assert.match(block, /if \(pre\.textContent !== decoded\)/);
});
