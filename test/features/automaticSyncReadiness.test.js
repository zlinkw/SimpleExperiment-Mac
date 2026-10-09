const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const bodyStart = panel.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function readiness(state) {
  const sandbox = {
    SYNC_NOT_READY_STATUS_TOKENS: new Set(["-", "待同步", "pending", "running", "in_progress", "unknown", "同步中", "执行中", "已跳过", "未参与本次同步"]),
    EMPTY_WORKER_TUNNELS_FOR_ALIAS: [],
    enabledWorkerTunnelsCacheSource: null,
    enabledWorkerTunnelsCacheValue: [],
    hasText: (value) => Boolean(String(value || "").trim()),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("syncStatusOk"),
    extractFunction("syncStatusFailure"),
    extractFunction("enabledWorkerTunnelsForState"),
    extractFunction("overviewSyncReadiness"),
    "this.check = overviewSyncReadiness;",
  ].join("\n"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.check(state)));
}

test("pending code sync is informational because plan submission synchronizes automatically", () => {
  const setup = { workerTunnels: [{ id: "w1", enabled: true }] };
  assert.deepEqual(readiness({ setup, codeSync: { hub: "待同步", workers: "待同步" } }), {
    ready: false,
    failure: false,
    status: "运行时自动同步",
  });
  assert.deepEqual(readiness({ setup, codeSync: { hub: "running", workers: "同步中", fingerprint: "abc" } }), {
    ready: false,
    failure: false,
    status: "运行时自动同步",
  });
  assert.deepEqual(readiness({ setup, codeSync: { hub: "已同步", workers: "已同步 1 台", fingerprint: "abc" } }), {
    ready: true,
    failure: false,
    status: "已确认",
  });
  assert.deepEqual(readiness({ setup, codeSync: { hub: "failed: permission denied", workers: "待同步" } }), {
    ready: false,
    failure: true,
    status: "失败",
  });
  assert.deepEqual(readiness({ setup, codeSync: { hub: "同步失败：权限不足", workers: "待同步", fingerprint: "abc" } }), {
    ready: false,
    failure: true,
    status: "失败",
  });
});

test("overview only blocks explicit sync failures", () => {
  assert.match(panel, /function overviewSyncReadiness\(state\)/);
  assert.doesNotMatch(panel, /blockers\.push\(\["代码待同步"/);
});

test("some safe Workers uploaded does not imply every Worker has the new code", () => {
  const setup = { workerTunnels: [{ id: "worker-a", enabled: true }, { id: "worker-b", enabled: true }] };
  for (const workers of ["待同步 1 台；已同步 1 台（Worker B：仍有旧任务）", "待同步 2 台；已同步 0 台"]) {
    assert.deepEqual(readiness({ setup, codeSync: { hub: "已同步", workers, fingerprint: "current" } }), {
      ready: false, failure: false, status: "运行时自动同步",
    });
  }
  assert.deepEqual(readiness({ setup, codeSync: { hub: "已同步", workers: "待同步 1 台；failed", fingerprint: "current" } }), {
    ready: false, failure: true, status: "失败",
  });
});
