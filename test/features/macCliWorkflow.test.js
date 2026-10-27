const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { requirePositional } = require("../../dist/cli/parse");
const { assertProjectPlan } = require("../../dist/cli/WorkflowRun");

async function fixture(t) {
  // 两端都能表示的 Plan 名：保留中文名，但去掉首尾空白。Windows 的位置参数分支会 trim
  // （src/cli/parse.ts:333-338），首尾空格在本机无法寻址，会让六项通用工作流行为整体停在
  // “找不到 Plan 文件”的前置错误上，测不到真实围栏。首尾空格拼写只在末条用例里按分支断言，
  // 并且仍留在发布延期清单里（非 win32 分支未在目标平台验证）。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Mac Plan 中文-"));
  const other = path.join(root, "另一个工作区"); fs.mkdirSync(other);
  const planFile = "experiments/plans/计划 A.yaml";
  fs.mkdirSync(path.dirname(path.join(root, planFile)), { recursive: true });
  fs.writeFileSync(path.join(root, planFile), "name: mock-only\nbase_config: configs/mock.yaml\n", "utf8");
  fs.writeFileSync(path.join(root, "KEEP.txt"), "CLI mock evidence; no actual experiment or cleanup.\n", "utf8");
  // 统一 CLI 入口契约（src/cli/LocalApiClient.ts:284-318）：发现文件必须带 pid/startedAt 实例身份，
  // /api/v1/capabilities 必须回报同名插件槽位、同版本与同一 instanceId（`pid:startedAt`）。缺任一项，
  // CLI 会在任何业务调用之前以 ENV 退出 2，六项工作流行为根本没跑到服务器。
  const apiName = "SimpleExperiment", apiVersion = require("../../package.json").version;
  const apiStartedAt = new Date(Date.UTC(2026, 9, 27, 0, 0, 0)).toISOString();
  const apiInstanceId = process.pid + ":" + apiStartedAt;
  const calls = []; const state = { workspace: root, route: "ready", run: "pending", topology: "single_worker", failure: "", changeWorkspace: false };
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer workflow-fixture");
    if (req.url === "/api/v1/capabilities") return res.end(JSON.stringify({ schemaVersion: 1, rpc: "json-rpc-2.0", methods: ["status", "workflow.plan", "workflow.run", "gpu.list"], name: apiName, version: apiVersion, instanceId: apiInstanceId }));
    const chunks = []; req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); calls.push(body);
      if (state.failure === body.method) { res.writeHead(503); res.end("unavailable"); return; }
      let result;
      if (body.method === "status") result = { workspace: state.workspace };
      else if (body.method === "workflow.plan") {
        result = { ok: state.route !== "blocked", ready: state.route !== "blocked", plan: { planFile: state.route === "wrong_plan" ? "experiments/plans/different.yaml" : body.params.planFile }, topology: { mode: state.topology }, blocker: { code: "INFRASTRUCTURE_NOT_READY" }, nextAction: "server.testAll" };
        if (state.changeWorkspace) state.workspace = other;
      } else if (body.method === "workflow.run") {
        // The current server owns preflight and workspace revalidation within workflow.run.
        if (state.changeWorkspace) state.workspace = other;
        const blocked = state.route === "blocked" || state.run === "blocked" || state.workspace !== body.params.workspace || state.route === "wrong_plan";
        result = blocked ? { ok: false, started: false, plan: { planFile: state.route === "wrong_plan" ? "experiments/plans/different.yaml" : body.params.planFile }, blocker: { code: state.workspace !== body.params.workspace ? "WORKSPACE_CHANGED" : state.run === "blocked" ? "ACTIVE_PLAN_RUN_EXISTS" : "INFRASTRUCTURE_NOT_READY" }, nextAction: "operations.list" } : { ok: true, started: true, operationId: "mock-op", status: "waiting_confirmation", confirmation: "vscode_modal", nextAction: "operations.list" };
      }
      else result = { gpus: [] };
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const discovery = path.join(root, "发现文件 中文.json");
  fs.writeFileSync(discovery, JSON.stringify({ schemaVersion: 1, name: apiName, version: apiVersion,
    baseUrl: `http://127.0.0.1:${server.address().port}`, token: "workflow-fixture", status: "running",
    pid: process.pid, startedAt: apiStartedAt, instanceId: apiInstanceId }), "utf8");
  const run = (args, offline = false) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, "../../dist/cli.js"), "experiment", "run", planFile, ...args, "--json"], { cwd: root, windowsHide: true, env: { ...process.env, SIMPLE_EXPERIMENT_PROJECT_ROOT: root, SIMPLE_EXPERIMENT_MAC_API_FILE: offline ? path.join(root, "missing.json") : discovery } });
    let stdout = "", stderr = ""; const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
    child.on("error", reject); child.on("close", code => { clearTimeout(timer); resolve({ code, payload: stdout ? JSON.parse(stdout) : null, stderr }); });
  });
  return { root, other, state, calls, planFile, run };
}

test("CLI binds Plan and workspace and reports VS Code confirmation as a pending local operation", async t => {
  const f = await fixture(t);
  for (const mode of ["single_worker", "multi_worker", "hub_worker"]) {
    f.state.topology = mode; f.calls.length = 0;
    const result = await f.run([]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.payload.requested, true); assert.equal(result.payload.submitted, false);
    assert.equal(result.payload.status, "waiting_confirmation"); assert.equal(result.payload.confirmation, "vscode_modal");
    assert.equal(result.payload.operationId, "mock-op"); assert.equal(result.payload.nextAction, "operations.list");
    assert.deepEqual(f.calls.map(c => c.method), ["status", "workflow.run"]);
    const params = f.calls.at(-1).params;
    assert.equal(params.planFile, f.planFile); assert.equal(params.workspace, fs.realpathSync(f.root));
    assert.equal(Object.hasOwn(params, "confirm"), false); assert.equal(Object.hasOwn(params, "autoPrepare"), false);
  }
});

test("failed readiness, mismatched workspaces, changed workspace or Plan never become accepted operations", async t => {
  const f = await fixture(t);
  f.state.route = "blocked";
  let result = await f.run([]); assert.equal(result.code, 3); assert.equal(result.payload.requested, false); assert.equal(result.payload.status, "blocked");
  f.state.route = "ready"; f.state.workspace = f.other;
  result = await f.run([]); assert.equal(result.code, 2); assert.match(result.payload.error.message, /workspace/);
  f.state.workspace = f.root; f.state.changeWorkspace = true;
  result = await f.run([]); assert.equal(result.code, 3); assert.equal(result.payload.requested, false); assert.equal(result.payload.blocker.code, "WORKSPACE_CHANGED");
  f.state.workspace = f.root; f.state.changeWorkspace = false; f.state.route = "wrong_plan";
  result = await f.run([]); assert.equal(result.code, 3); assert.match(result.payload.error.message, /different Plan/);
  assert.equal(f.calls.filter(c => c.method === "workflow.run").length, 3);
  assert.ok(f.calls.filter(c => c.method === "workflow.run").every(c => c.params.workspace === fs.realpathSync(f.root)));
});

test("online preview and check use live preflight; offline preview cannot claim live readiness", async t => {
  const f = await fixture(t);
  for (const args of [["--dry-run"], ["--check"], ["--dry-run", "--check"]]) {
    const result = await f.run(args);
    assert.equal(result.code, 0); assert.equal(result.payload.validation, "live_api"); assert.equal(result.payload.ready, true);
    assert.equal(result.payload.requested, false); assert.equal(result.payload.submitted, false);
  }
  assert.ok(f.calls.every(c => c.method !== "workflow.run"));
  f.state.route = "blocked";
  const blocked = await f.run(["--dry-run"]); assert.equal(blocked.code, 3); assert.equal(blocked.payload.ready, false);
  const offline = await f.run(["--dry-run"], true); assert.equal(offline.code, 0); assert.equal(offline.payload.validation, "local_only"); assert.equal(offline.payload.ready, false);
});

test("HTTP or business rejection never becomes submitted success and does not retry workflow.run", async t => {
  const f = await fixture(t);
  f.state.failure = "workflow.plan";
  const preflight = await f.run(["--check"]); assert.notEqual(preflight.code, 0); assert.ok(f.calls.every(c => c.method !== "workflow.run"));
  f.state.failure = "workflow.run"; f.calls.length = 0;
  const failed = await f.run([]); assert.notEqual(failed.code, 0); assert.equal(f.calls.filter(c => c.method === "workflow.run").length, 1);
  f.state.failure = ""; f.state.run = "blocked"; f.calls.length = 0;
  const rejected = await f.run([]); assert.equal(rejected.code, 3); assert.equal(rejected.payload.requested, false); assert.equal(rejected.payload.submitted, false);
  assert.equal(f.calls.filter(c => c.method === "workflow.run").length, 1);
});

test("Plan path spelling is retained and outside files or linked escapes are rejected", async t => {
  const f = await fixture(t);
  // 位置参数拼写保留本身是平台分支：win32 去首尾空白，非 win32 原样保留。本机只能观察到 win32 一侧，
  // 非 win32 一侧继续留在延期清单（该分支未在目标平台验证），这里不新增平台跳过，只固定“每台主机都必须
  // 说出自己的真实行为”这一条：结果必须精确等于该主机分支的既定处理，不能是第三种结果。
  assert.equal(requirePositional([" 计划 A.yaml "], 0, "plan"),
    process.platform === "win32" ? "计划 A.yaml" : " 计划 A.yaml ");
  assert.equal(assertProjectPlan(f.root, f.planFile), fs.realpathSync(f.root));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "other-Plan-"));
  fs.writeFileSync(path.join(outside, "outside.yaml"), "name: outside\n", "utf8");
  assert.throws(() => assertProjectPlan(f.root, path.join(outside, "outside.yaml")), /inside/);
  fs.symlinkSync(outside, path.join(f.root, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => assertProjectPlan(f.root, "linked/outside.yaml"), /inside/);
});

test("online and offline CLI seed overrides are rejected before any API call", async t => {
  const f = await fixture(t);
  const online = await f.run(["--seed", "42"]);
  assert.equal(online.code, 3); assert.match(online.payload.error.message, /seed/);
  assert.equal(f.calls.length, 0);
  const offline = await f.run(["--seed", "42", "--dry-run"], true);
  assert.equal(offline.code, 3); assert.match(offline.payload.error.message, /seed/); assert.equal(f.calls.length, 0);
});
