const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");
const { renderPanelRecoveryHtml } = require("../../dist/ui/PanelRecoveryHtml.js");

test("panel inline script is valid JavaScript", () => {
  const html = renderPanelHtml();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((candidate) => candidate.includes("function renderGpuTensorboardControls(state)"));
  assert.ok(script, "main panel script missing");
  assert.doesNotThrow(() => new vm.Script(script, { filename: "panel-inline.js" }));
  assert.match(html, /id="gpuTensorboardControls"/);
  assert.match(script, /function renderGpuTensorboardControls\(state\)/);
  assert.match(script, /data-command="openScalarViewer" data-endpoint-id=/);
  assert.match(script, /标量按所有可用 Worker 汇总/);
});

test("panel recovery page exposes a reload action and valid inline JavaScript", () => {
  const html = renderPanelRecoveryHtml("启动错误");
  assert.match(html, /重新加载面板/);
  assert.match(html, /command:\"reloadPanel\"/);
  const start = html.indexOf("<script");
  const bodyStart = html.indexOf(">", start) + 1;
  const end = html.indexOf("</script>", bodyStart);
  assert.doesNotThrow(() => new vm.Script(html.slice(bodyStart, end), { filename: "panel-recovery-inline.js" }));
});
