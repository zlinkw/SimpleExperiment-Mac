const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
require('../_helpers/registerTsRequire');
const { currentWindowSftpDiscovery, sameProjectRoot } = require('../../src/core/SimpleSftpWindow.ts');

// 31：同一次启动上下文内所有 SimpleSFTP helper 共享一次实际能力读取；
// 新启动、失败与显式失效都必须重新取得，不建跨启动/跨运行代际的无限缓存。
const source = fs.readFileSync(require.resolve("../../src/extension/legacy.ts"), "utf8");
const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
function decl(name) {
  let found;
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(ast) === name) found = node.getText(ast);
    else ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, name);
  return found;
}
const methodsSource = ts.transpileModule(
  `this.methods = { ${["beginSimpleSftpCapabilityLaunch", "invalidateSimpleSftpCapability",
    "invalidateSimpleSftpCapabilityAfterFailure", "readSimpleSftpCapabilities", "simpleSftpCapability",
    "simpleSftpApiCall"].map(decl)
    .concat(decl("withUiCommandStatus").replace("private ", "")).join(",")} };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
  const api = { baseUrl: "http://127.0.0.1:18765", token: "token-1", pid: process.pid, startedAt: '2026-10-29T00:00:00.000Z', version: '0.2.fixture' };
  const reads = { discovery: 0 };
  const fetches = [];
  const rpc = [];
  const state = {
    failNext: false, failStatus: 0,
    transportFail: null, // { match, message }：按端点匹配抛传输层错误，模拟监听器重启后旧端不可达
    failOnce: null, // { message }：下一次 RPC 抛一次（401 等），验证绝不自动重放
    gate: null, // 挂起中的 RPC，用于并发换启动场景
  };
  const sandbox = {
    console,
    currentWindowSftpDiscovery, sameProjectRoot,
    URL,
    // Mac 适配：readSimpleSftpCapabilities 的发现文件经 ../platform/HostPaths.componentDirectory("sftp")（Mac 支持目录），
    // 沙箱注入生产实现；fs.readFile 已按路径无关 mock，发现计数断言强度不变。
    require: (id) => id === "../platform/HostPaths" ? require("../../dist/platform/HostPaths.js") : require(id),
    path: require("node:path"),
    os: { homedir: () => "C:/home" },
    fs: { readFile: async () => { reads.discovery++; return JSON.stringify(api); } },
    process: { env: { APPDATA: "C:/AppData" } },
    AbortSignal,
    assertRetryRequestCurrent: () => undefined,
    vscode: { workspace: { getConfiguration: () => ({ get: () => undefined }) }, window: { showErrorMessage: async () => undefined, showWarningMessage: async () => undefined, showInformationMessage: async () => undefined } },
    AgentTmuxPolicy_1: { normalizeRemoteTmuxSessionPrefix: (prefix) => prefix },
    sftpFileIndexQuery: (method) => (method === "sync.projectInventory" ? { kind: "inventory" } : undefined),
    workspaceRoot: () => "C:/workspace",
    errorMessage: (error) => String((error && error.message) || error),
    safeSyncPath: (value) => value,
    fileOperationIndexPaths: () => [],
    PLAN_SUBMISSION_COMMANDS: new Set(["runPlan", "reproducePlan"]),
    localCommandReleasesAfterTrigger: () => false,
    isUiCommandRemotePending: () => false,
    isUiCommandCancelled: () => false,
    resultSyncCommandOutcome: () => undefined,
    actionErrorSuggestion: () => undefined,
    hostOperationLeaseActionLabel: (command) => command,
    compactSensitiveText: (text) => text,
    OperationOutcome_1: { operationOutcomeFor: () => ({}) },
    callSftpWithProgress: async (method, request, capabilityFor) => {
      const cap = await capabilityFor(method);
      const endpoint = String(cap.endpoint);
      rpc.push({ method, endpoint });
      if (state.gate) await state.gate;
      if (state.failOnce) { const message = state.failOnce.message; state.failOnce = null; throw new Error(message); }
      if (state.transportFail && endpoint.includes(state.transportFail.match)) throw new Error(state.transportFail.message);
      return { ok: true, method };
    },
    fetch: async (url, init) => {
      fetches.push({ url: String(url), headers: init && init.headers });
      if (state.failNext) { state.failNext = false; throw new TypeError("ECONNREFUSED 127.0.0.1:18765"); }
      if (state.failStatus) {
        const status = state.failStatus; state.failStatus = 0;
        return { ok: false, status, json: async () => ({}) };
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          methods: ["sync.projectInventory", "sync.downloadPaths", "sync.download", "files.cleanup.preview"],
          name: 'SimpleSFTP', version: api.version, instanceId: `${api.pid}:${api.startedAt}`,
          features: { fastDelete: 1 },
          methodOptions: { "sync.projectInventory": { metadataOnly: 1 } },
        }),
      };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(methodsSource, sandbox);
  const posts = [];
  const host = Object.assign({
    assertTransferRootSafety: () => {}, // transfer boundary is exercised by projectRootMap tests
    simpleSftpCapLaunch: 0, simpleSftpCapShared: undefined,
    projectFileObservationIndex: undefined,
    postUiCommandStatus: (...args) => posts.push(args), localOperations: {}, planSubmissionOperationId: () => "op-current",
  }, sandbox.methods);
  return { api, reads, fetches, rpc, posts, state, host, sandbox };
}
function useFakeIndex(f) {
  f.host.projectFileObservationIndex = () => ({ read: async (query, load) => load(), invalidate: async () => undefined });
}

test("31 same launch shares one discovery read and one capabilities request across helpers", async () => {
  const f = fixture();
  const first = await f.host.simpleSftpCapability("sync.projectInventory");
  const second = await f.host.simpleSftpCapability("sync.downloadPaths");
  const third = await f.host.simpleSftpCapability("files.cleanup.preview");
  assert.equal(f.fetches.length, 1, "同一次启动的能力 GET 必须恰好一次");
  assert.equal(f.reads.discovery, 1, "同一次启动不得重复打开 api.json 头部文件");
  assert.equal(first.instanceId, `${f.api.pid}:${f.api.startedAt}`);
  assert.equal(second.instanceId, `${f.api.pid}:${f.api.startedAt}`);
  assert.equal(third.instanceId, `${f.api.pid}:${f.api.startedAt}`);
  assert.deepEqual(JSON.parse(JSON.stringify(first.headers)), { Authorization: "Bearer token-1",
    "X-Simple-Api-Instance": `${f.api.pid}:${f.api.startedAt}`, "X-Simple-Api-Workspace": encodeURIComponent("C:/workspace") });
  assert.deepEqual(JSON.parse(JSON.stringify(third.methodOptions)), { "sync.projectInventory": { metadataOnly: 1 } });
});

test("31 concurrent helpers in one launch still share a single read", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.host.simpleSftpCapability("sync.projectInventory"),
    f.host.simpleSftpCapability("sync.downloadPaths"),
    f.host.simpleSftpCapability("files.cleanup.preview"),
  ]);
  assert.equal(f.fetches.length, 1);
  assert.equal(new Set(results.map((row) => row.instanceId)).size, 1);
});

test("31 unsupported method still rejects from the shared read without refetching", async () => {
  const f = fixture();
  await f.host.simpleSftpCapability("sync.projectInventory");
  await assert.rejects(() => f.host.simpleSftpCapability("files.syncTree"), /SimpleSFTP 不支持 files\.syncTree/);
  assert.equal(f.fetches.length, 1);
});

test("31 new launch refetches and picks up a replaced Scheduler endpoint and token", async () => {
  const f = fixture();
  await f.host.simpleSftpCapability("sync.projectInventory");
  assert.equal(f.fetches.length, 1);
  f.host.beginSimpleSftpCapabilityLaunch();
  f.api.baseUrl = "http://127.0.0.1:19000";
  f.api.token = "token-2";
  const second = await f.host.simpleSftpCapability("sync.projectInventory");
  assert.equal(f.fetches.length, 2, "新启动必须重新取得一次能力");
  assert.equal(second.instanceId, `${f.api.pid}:${f.api.startedAt}`);
  assert.equal(second.headers.Authorization, "Bearer token-2");
  assert.match(String(second.endpoint), /19000/);
  await f.host.simpleSftpCapability("sync.downloadPaths");
  assert.equal(f.fetches.length, 2, "同一新启动内后续 helper 不再重复读取");
});

test("31 failed read clears the single slot so the next call rediscovers", async () => {
  const f = fixture();
  f.state.failNext = true;
  await assert.rejects(() => f.host.simpleSftpCapability("sync.projectInventory"), /ECONNREFUSED/);
  assert.equal(f.host.simpleSftpCapShared, undefined, "失败后单槽必须清空，不把失败结果留给同启动后续调用");
  const ok = await f.host.simpleSftpCapability("sync.projectInventory");
  assert.equal(ok.instanceId, `${f.api.pid}:${f.api.startedAt}`);
  assert.equal(f.fetches.length, 2);
  await f.host.simpleSftpCapability("sync.downloadPaths");
  assert.equal(f.fetches.length, 2, "恢复成功后的同启动读取仍然共享");
});

test("31 auth-expired capability read retries discovery once like before", async () => {
  const f = fixture();
  f.state.failStatus = 401;
  const ok = await f.host.simpleSftpCapability("sync.projectInventory");
  assert.equal(ok.instanceId, `${f.api.pid}:${f.api.startedAt}`);
  assert.equal(f.fetches.length, 2, "仅能力 GET 重试一次，不重放任何变更请求");
  assert.equal(f.reads.discovery, 2, "重试前重新读取一次发现头部文件");
});

test("31 explicit invalidation forces the next call to rediscover", async () => {
  const f = fixture();
  await f.host.simpleSftpCapability("sync.projectInventory");
  f.host.invalidateSimpleSftpCapability();
  f.api.token = "token-rotated";
  const next = await f.host.simpleSftpCapability("sync.projectInventory");
  assert.equal(f.fetches.length, 2);
  assert.equal(next.headers.Authorization, "Bearer token-rotated");
});

// 以下用实际提取的 simpleSftpApiCall（含真实索引读分支的早退路径）与真实 simpleSftpApiCall
// 外层 catch 验证失效闭包：SimpleSFTP 监听器重启换端口后，旧能力槽不得被任何 RPC 路径无限复用。

test("31 indexed inventory read failure invalidates; next independent call rediscovers restarted endpoint", async () => {
  const f = fixture();
  useFakeIndex(f);
  const first = await f.host.simpleSftpApiCall("sync.projectInventory", {});
  assert.equal(first.ok, true);
  assert.equal(f.fetches.length, 1);
  // SimpleSFTP 监听器重启到新端口；缓存能力仍指向旧端口
  f.api.baseUrl = "http://127.0.0.1:19000";
  f.state.transportFail = { match: "18765", message: "connect ECONNREFUSED 127.0.0.1:18765" };
  await assert.rejects(() => f.host.simpleSftpApiCall("sync.projectInventory", {}), /ECONNREFUSED/);
  assert.equal(f.host.simpleSftpCapShared, undefined, "索引读连接失败必须清掉旧能力槽，不能留到下次");
  assert.equal(f.rpc.filter((row) => row.endpoint.includes("18765")).length, 2, "失败调用内不得自动重放，仅首次+本次各一次");
  const ok = await f.host.simpleSftpApiCall("sync.projectInventory", {});
  assert.equal(ok.ok, true);
  assert.match(f.rpc[f.rpc.length - 1].endpoint, /19000/, "下一次独立调用必须按 api.json 新端点成功");
  assert.equal(f.fetches.length, 2, "重发现恰好一次能力 GET");
});

test("31 non-indexed read failure invalidates; next independent call rediscovers", async () => {
  const f = fixture();
  const first = await f.host.simpleSftpApiCall("sync.downloadPaths", {});
  assert.equal(first.ok, true);
  f.api.baseUrl = "http://127.0.0.1:19000";
  f.state.transportFail = { match: "18765", message: "fetch failed: connect ECONNREFUSED 127.0.0.1:18765" };
  await assert.rejects(() => f.host.simpleSftpApiCall("sync.downloadPaths", {}), /ECONNREFUSED/);
  assert.equal(f.host.simpleSftpCapShared, undefined);
  const ok = await f.host.simpleSftpApiCall("sync.downloadPaths", {});
  assert.equal(ok.ok, true);
  assert.match(f.rpc[f.rpc.length - 1].endpoint, /19000/);
  assert.equal(f.fetches.length, 2);
});

test("31 indexed read HTTP 401 also invalidates without leaking past the early return", async () => {
  const f = fixture();
  useFakeIndex(f);
  await f.host.simpleSftpApiCall("sync.projectInventory", {});
  f.state.failOnce = { message: "HTTP 401 UNAUTHORIZED" };
  await assert.rejects(() => f.host.simpleSftpApiCall("sync.projectInventory", {}), /HTTP 401/);
  assert.equal(f.host.simpleSftpCapShared, undefined, "索引读 401 同样必须清槽；按既有规则只在下次调用重发现");
  const ok = await f.host.simpleSftpApiCall("sync.projectInventory", {});
  assert.equal(ok.ok, true);
  assert.equal(f.fetches.length, 2);
});

test("31 mutation RPC failing (network or 401) executes exactly once and never replays", async () => {
  for (const message of ["connect ECONNREFUSED 127.0.0.1:18765", "HTTP 401 UNAUTHORIZED"]) {
    const f = fixture();
    f.state.failOnce = { message };
    await assert.rejects(() => f.host.simpleSftpApiCall("sync.download", {}), message.includes("401") ? /HTTP 401/ : /ECONNREFUSED/);
    assert.equal(f.rpc.filter((row) => row.method === "sync.download").length, 1, "变更 RPC 失败后实际执行次数必须恰为一，禁止自动重放：" + message);
    assert.equal(f.host.simpleSftpCapShared, undefined, "变更失败同样清槽，下一次独立调用重新发现：" + message);
  }
});

test("31 late failure from old launch cannot clear the concurrent new-launch slot", async () => {
  const f = fixture();
  await f.host.simpleSftpApiCall("sync.downloadPaths", {}); // launch0 缓存旧端能力
  let release;
  f.state.gate = new Promise((resolve) => { release = resolve; });
  const slow = f.host.simpleSftpApiCall("sync.downloadPaths", {}); // 挂起在旧端 RPC
  for (let i = 0; i < 50 && f.rpc.length < 2; i++) await Promise.resolve();
  assert.equal(f.rpc.length, 2);
  f.state.gate = null;
  f.host.beginSimpleSftpCapabilityLaunch(); // 新启动换源
  f.api.baseUrl = "http://127.0.0.1:19000";
  f.state.transportFail = { match: "18765", message: "connect ECONNREFUSED 127.0.0.1:18765" };
  const second = await f.host.simpleSftpApiCall("sync.downloadPaths", {}); // 新槽到新端成功
  assert.equal(second.ok, true);
  assert.equal(f.fetches.length, 2);
  release();
  await assert.rejects(() => slow, /ECONNREFUSED/);
  assert.ok(f.host.simpleSftpCapShared, "旧启动迟到失败不得清掉新启动槽");
  assert.equal(f.host.simpleSftpCapShared.launch, 1);
  await f.host.simpleSftpApiCall("sync.downloadPaths", {});
  assert.equal(f.fetches.length, 2, "新槽完好，后续调用不重复读取");
});

test("31 real UI command entry establishes a fresh capability context; submit entry keeps its own", async () => {
  const f = fixture();
  await f.host.simpleSftpApiCall("sync.downloadPaths", {}); // launch0 缓存端点 A
  f.api.baseUrl = "http://127.0.0.1:19000"; // 监听器重启换端口，尚无网络失败
  await f.host.withUiCommandStatus("op1", "refreshFileTree", {},
    () => f.host.simpleSftpApiCall("sync.downloadPaths", {}));
  assert.ok(f.posts.some((row) => row[1] === "completed"), "真实入口应完成命令状态投递");
  assert.equal(f.host.simpleSftpCapLaunch, 1, "独立 UI 操作入口必须推进能力上下文");
  assert.equal(f.fetches.length, 2, "源更换后的下一个独立操作必须重新读取一次");
  assert.match(f.rpc[f.rpc.length - 1].endpoint, /19000/);
  // 同一操作内的多个 helper 仍共享一次读取；不同操作各自一个上下文，不复用 launch0
  await f.host.withUiCommandStatus("op2", "refreshFileTree", {}, async () => {
    await f.host.simpleSftpApiCall("sync.downloadPaths", {});
    await f.host.simpleSftpApiCall("sync.projectInventory", {});
  });
  assert.equal(f.fetches.length, 3, "单次操作内两个 helper 共享一次读取，操作总数即上下文数");
  // 提交/恢复入口自带上下文，wrapper 不重复推进；真实入口由下方源码接线断言佐证
  const launchBefore = f.host.simpleSftpCapLaunch;
  await f.host.withUiCommandStatus("op3", "runPlan", {}, async () => ({ status: "submitted", message: "已排队" }));
  assert.equal(f.host.simpleSftpCapLaunch, launchBefore, "runPlan 上下文由提交入口推进，wrapper 不得重复");
  const wrapperSource = decl("withUiCommandStatus");
  assert.match(wrapperSource, /!PLAN_SUBMISSION_COMMANDS\.has\(command\)[^\n]*retryPlanSubmission[^\n]*beginSimpleSftpCapabilityLaunch\(\)/);
  assert.match(decl("beginPlanSubmissionProgress"), /beginSimpleSftpCapabilityLaunch\(\)/, "提交入口真实接线");
  assert.match(decl("resumePlanSubmission"), /beginSimpleSftpCapabilityLaunch\(\)/, "恢复入口真实接线");
});
