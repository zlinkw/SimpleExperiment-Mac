const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");
const extension = readSource("src/extension.ts");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test("experiment submission requires an enabled Worker before confirmation or sync", () => {
  const sandbox = {
    EMPTY_WORKER_TUNNELS_FOR_ALIAS: [],
    enabledWorkerTunnelsCacheSource: null,
    enabledWorkerTunnelsCacheValue: [],
    executionWorkerReadinessCacheWorkers: null,
    executionWorkerReadinessCacheValue: null,
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(panel, "enabledWorkerTunnelsForState"),
    extractFunction(panel, "executionWorkerReadiness"),
    "this.check = executionWorkerReadiness;",
  ].join("\n"), sandbox);
  assert.equal(sandbox.check({ setup: { workerTunnels: [] } }).ready, false);
  assert.equal(sandbox.check({ setup: { workerTunnels: [{ id: "w1", enabled: false }] } }).ready, false);
  assert.equal(sandbox.check({ setup: { workerTunnels: [{ id: "w1", enabled: true }] } }).ready, true);
  assert.match(panel, /workerReadiness\.summary \|\| "正式运行至少需要一个启用的执行 Worker。"/);
  assert.match(panel, /至少配置并启用一个执行 Worker/);
  assert.match(extractFunction(panel, "disableReason"), /SUBMITTED_RUN_COMMANDS\??\.has\(command\).*executionWorkerReadiness/s);
  assert.match(extension, /assertExecutionWorkersReady\(workers = this\.workerActionTargets\(\)\)/);
  assert.match(extension, /至少需要配置并启用一个 Worker 才能运行实验/);
});
