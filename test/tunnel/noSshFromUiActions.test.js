const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("new realtime UI snapshots use the localhost client", () => {
  const source = readSource("src/extension.ts");
  const methods = [
    ["manualGpuSnapshot", "manualSchedulerSnapshot", /client\.getGpu\(\)/],
    ["manualSchedulerSnapshot", "manualTracesSnapshot", /client\.getScheduler\(\)/],
    ["manualTracesSnapshot", "generateTunnelScript", /client\.getTraces\(\)/],
  ];
  for (const [method, nextMethod, clientCall] of methods) {
    const start = source.indexOf(`async ${method}()`);
    const end = source.indexOf(`async ${nextMethod}(`, start);
    assert.ok(start >= 0 && end > start, method);
    const body = source.slice(start, end);
    assert.match(body, clientCall, method);
    assert.doesNotMatch(body, /\b(?:runSsh|execFile|spawn)\s*\(/i, method);
  }
  const panel = readSource("src/ui/PanelHtml.ts");
  assert.doesNotMatch(panel, /\b(?:direct_ssh|runSsh|execFile|spawn)\s*\(/i);
});
