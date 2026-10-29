const test = require("node:test");
const assert = require("node:assert/strict");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("panel html renders tunnel port assignment and conflict sections", () => {
  const html = renderPanelHtml();
  assert.match(html, /id="tunnelPortAssignments"/);
  assert.match(html, /id="tunnelPortConflicts"/);
  assert.match(html, /data-command="configurePorts"/);
  assert.match(html, /data-command="repairPorts"/);
  assert.match(html, /后台 SSH/);
  assert.match(html, /data-command="openXshell"[^>]*>打开终端指引/);
});
