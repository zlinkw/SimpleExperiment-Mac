const test = require("node:test");
const assert = require("node:assert/strict");

const { renderPanelHtml } = require("../../dist/ui/PanelHtml.js");

test("panel html renders hub control and worker telemetry sections", () => {
  const html = renderPanelHtml();
  assert.match(html, /id="hubControlStatus"/);
  assert.match(html, /id="workerTelemetryStatus"/);
  assert.match(html, /data-command="startHub"/);
  assert.match(html, /data-command="startWorker"/);
  assert.match(html, /renderHubWorkerAndPorts/);
});