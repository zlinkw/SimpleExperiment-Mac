const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

test("connection setting changes refresh the live client without reloading VS Code", () => {
  assert.match(source, /onDidChangeConfiguration\(\(event\) => void provider\?\.handleConfigurationChanged\(event\)\)/);
  const start = source.indexOf("async handleConfigurationChanged(event)");
  const end = source.indexOf("async clearOfflineImport()", start);
  assert.ok(start > 0 && end > start, "configuration change handler missing");
  const flow = source.slice(start, end);
  assert.match(flow, /affectsConfiguration\?\.\("simpleExperiment"\)/);
  assert.match(flow, /affectsConfiguration\("simpleExperiment\.connectionMode"\)/);
  assert.match(flow, /affectsConfiguration\("simpleExperiment\.tunnel"\)/);
  assert.match(flow, /this\.tunnelConfig = this\.loadTunnelConfig\(\)/);
  assert.match(flow, /this\.setupConfig = this\.loadSetupConfig\(\)/);
  assert.match(flow, /this\.resetClient\(\)/);
  assert.match(flow, /await this\.ensureRealtimeConnected\("configuration changed"\)/);
  assert.match(flow, /this\.postState\(true\)/);
  assert.match(flow, /SimpleExperiment 已切换为 Xshell 实时隧道模式/);
  assert.match(flow, /next === "继续识别工作区"[\s\S]{0,100}this\.bootstrapProjectFromUi\(\)/);
});
