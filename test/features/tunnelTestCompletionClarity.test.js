const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

function extractFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function completion(setup, hubProbe, health, workerProbes) {
  const sandbox = { HUB_READY_STATUSES: new Set(["ok", "file_api_unavailable", "agent_ok"]) };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction("tunnelTestCompletion") + "\nthis.check = tunnelTestCompletion;", sandbox);
  return JSON.parse(JSON.stringify(sandbox.check(setup, hubProbe, health, workerProbes)));
}

test("all enabled endpoints must pass before tunnel detection reports success", () => {
  const setup = {
    workerTunnels: [
      { id: "w1", displayName: "GPU A", enabled: true },
      { id: "w2", displayName: "GPU B", enabled: true },
      { id: "disabled", displayName: "停用节点", enabled: false },
    ],
  };
  const passed = completion(setup, { status: "file_api_unavailable" }, {}, {
    w1: { status: "ok" },
    w2: { status: "ok" },
    disabled: { status: "timeout" },
  });
  assert.equal(passed.ready, true);
  assert.equal(passed.hubReady, true);
  assert.equal(passed.workerReady, true);
  assert.match(passed.message, /GPU A:ok, GPU B:ok/);
  assert.doesNotMatch(passed.message, /停用节点/);
  assert.deepEqual(passed.issues, []);
});

test("a failed Worker turns a healthy Hub result into an actionable warning", () => {
  const result = completion({ workerTunnels: [{ id: "w1", displayName: "GPU A", enabled: true }] }, { status: "ok" }, {}, {
    w1: { status: "timeout", message: "连接超时", suggestion: "启动 GPU A 的 Xshell 会话" },
  });
  assert.equal(result.ready, false);
  assert.equal(result.hubReady, true);
  assert.equal(result.workerReady, false);
  assert.match(result.message, /Hub:ok; Worker:GPU A:timeout/);
  assert.deepEqual(result.issues, ["GPU A：启动 GPU A 的 Xshell 会话"]);
});

test("an enabled Worker without a probe is reported as not tested", () => {
  const result = completion({ workerTunnels: [{ id: "w1", displayName: "GPU A", enabled: true }] }, { status: "local_port_closed", suggestion: "启动 Hub 会话" }, {}, {});
  assert.equal(result.ready, false);
  assert.match(result.message, /GPU A:未检测/);
  assert.deepEqual(result.issues, ["Hub：启动 Hub 会话", "GPU A：未执行检测，请检查 Xshell 会话配置"]);
  const toastStart = extension.indexOf("    showTunnelTestToast() {");
  const toast = extension.slice(toastStart, extension.indexOf("    healthFromProbe", toastStart));
  assert.match(toast, /if \(completion\.ready\)[\s\S]*showInformationMessage/);
  assert.match(toast, /else[\s\S]*showWarningMessage/);
  assert.doesNotMatch(toast, /if \(hubStatus === "ok"/);
});

test("scheduler dependency failure keeps otherwise healthy endpoints incomplete", () => {
  const result = completion({ workerTunnels: [{ id: "w1", displayName: "GPU A", enabled: true }] }, {
    status: "ok",
    schedulerDependencies: { ok: false, message: "缺少 yaml", installCommand: "python -m pip install PyYAML" },
  }, {}, { w1: { status: "ok", schedulerDependencies: { ok: true } } });
  assert.equal(result.ready, false);
  assert.match(result.issues[0], /Hub Scheduler：缺少 yaml/);
  assert.match(result.issues[0], /python -m pip install PyYAML/);
});

test("tunnel completion reuses fixed Hub readiness statuses", () => {
  assert.match(extension, /const HUB_READY_STATUSES = new Set\(\[\.\.\.ENDPOINT_READY_PROBE_STATUSES, "agent_ok"\]\)/);
  assert.match(extractFunction("tunnelTestCompletion"), /HUB_READY_STATUSES\??\.has\(hubStatus\)/);
});

test("pending scheduler dependency checks never report complete readiness or missing packages", () => {
  const result = completion({ workerTunnels: [{ id: "w1", displayName: "GPU A", enabled: true }] }, { status: "ok" }, {}, {
    w1: { status: "ok", schedulerDependencies: { ok: null, pending: true, message: "依赖正在后台检查" } },
  });
  assert.equal(result.ready, false);
  assert.match(result.issues[0], /正在后台检查/);
  assert.doesNotMatch(result.issues[0], /依赖缺失|pip install/);
});
