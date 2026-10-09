const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("Worker telemetry cards translate event stream values", () => {
  assert.match(panel, /const rawEventStream = worker\.eventStream \|\| "-"/);
  assert.match(panel, /endpointMini\("事件流", labelStatus\(rawEventStream\)/);
  assert.match(panel, /原始事件流：/);
});

test("Worker telemetry channel display keeps surrounding diagnostics", () => {
  assert.match(panel, /endpointMini\("GPU", worker\.gpuTelemetry \? "开启" : "关闭"/);
  assert.match(panel, /endpointMini\("任务观测", worker\.workerTaskTelemetry \? "开启" : "关闭"/);
  assert.match(panel, /endpointMini\("心跳", worker\.lastHeartbeat \|\| "-"/);
});
