const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

function renderPanelHtmlFromSource(source) {
  return require("../../dist/ui/PanelHtml.js").renderPanelHtml();
}

function assertScriptParses(html) {
  const start = html.indexOf("<script");
  const gt = html.indexOf(">", start);
  const end = html.indexOf("</script>", gt);
  const script = html.slice(gt + 1, end);
  assert.doesNotThrow(() => new vm.Script(script, { filename: "panel-webview.js" }));
}

test("drawer UI baseline keeps hover side rails and full tree hierarchy", () => {
  const source = readSource("src/ui/PanelHtml.ts");
  const html = renderPanelHtmlFromSource(source);
  assert.match(html, /var\(--tree-col\)/);
  assert.match(html, /var\(--inspector-col\)/);
  assert.match(html, /resourceTree:hover/);
  assert.match(html, /workbenchInspector:hover/);
  assert.match(html, /tree-child-list|resourceTreeChildren/);
  assert.match(source, /\.tree-item \{/);
  assert.match(source, /\.tree-label/);
  assert.match(html, /id="resourceTree"/);
  assert.match(html, /id="workbenchInspector"/);
  assert.match(html, /id="layoutEditToggle"/);
  assert.match(html, /data-command="startAllConnections"/);
  assert.match(html, /statusLegend/);
  assert.match(html, /legendDot good/);
  assertScriptParses(html);
});
