const test = require("node:test");
const assert = require("node:assert/strict");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("panel renders editable server management cards before endpoint details", () => {
  const html = renderPanelHtml();
  assert.match(html, /id="serverCards"/);
  assert.match(html, /服务器管理/);
  assert.match(html, /renderServerCards/);
  assert.match(html, /data-command="saveHubConfig"/);
  assert.match(html, /data-command="saveWorkerConfig"/);
  assert.match(html, /data-command="addWorkerConfig"/);
  assert.match(html, /data-config-input/);
  assert.match(html, /Hub Agent/);
  assert.match(html, /高级诊断/);
  assert.match(html, /id="hubControlStatus"/);
  assert.match(html, /id="tunnelPortAssignments"/);
});