const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");

test("manual ui snapshots call tunnel client APIs", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /case "manualGpuSnapshot":[\s\S]+manualGpuSnapshot/);
  assert.match(source, /case "manualSchedulerSnapshot":[\s\S]+manualSchedulerSnapshot/);
  assert.match(source, /case "manualTracesSnapshot":[\s\S]+manualTracesSnapshot/);
  assert.match(source, /await client\.getGpu\(\)/);
  assert.match(source, /await client\.getScheduler\(\)/);
  assert.match(source, /await client\.getTraces\(\)/);
});

test("manual ui snapshots bind completion to the initiating client", () => {
  const source = readSource("src/extension.ts");
  const methods = [
    ["manualGpuSnapshot", "loadGpuHistoryFromUi"],
    ["manualSchedulerSnapshot", "manualTracesSnapshot"],
    ["manualTracesSnapshot", "generateTunnelScript"],
  ];
  for (const [method, nextMethod] of methods) {
    const start = source.indexOf(`async ${method}()`);
    const body = source.slice(start, source.indexOf(`async ${nextMethod}(`, start));
    assert.match(body, /const client = this\.client/, method);
    assert.ok([...body.matchAll(/client !== this\.client/g)].length >= 2, method);
    assert.match(body, /client === this\.client/, method);
  }
});

test("select log run key updates selection and refreshes live output", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /case "selectLogRunKey":/);
  assert.match(source, /this\.selectedLogRunKey = stringField/);
  assert.match(source, /fetchSelectedLiveOutput\(this\.selectedLogRunKey/);
});
