const { assert, fs, http, os, path, test, runCli } = require("./simpleCli.support.cjs");

// Batch 2a: sftp sync/remote/transfers domains on the unified transport, plus the explicit
// instance pin. Every fake mirrors the real SimpleSFTP extension.js contract for that method
// (parameter validation, CONFIRM_REQUIRED previews, result shapes); no invented fields.
// FIXTURE POLICY: zero cleanup. Every fixture lives under a unique retained run directory.
const TOKEN = "sync-batch-token";
const PID = 4321;
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `sftp-sync-fixtures-${Date.now()}-${process.pid}-`));
console.log(`[fixtures retained, no cleanup] ${FIXTURE_ROOT}`);

function fixtureDir(name) {
  const dir = path.join(FIXTURE_ROOT, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sftpEnv(file, extra = {}) {
  return { SIMPLE_SFTP_MAC_API_FILE: file, ...extra };
}

const SOURCE = { host: "gpu-node-1", user: "researcher", remotePath: "/data/projects/exp", port: 2222 };

function validSource(value) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return /^[A-Za-z0-9._-]+$/.test(String(item.host || ""))
    && /^[A-Za-z0-9._-]+$/.test(String(item.user || item.username || ""))
    && String(item.remotePath || "").startsWith("/") && String(item.remotePath || "") !== "/";
}

// Mirrors the backend RPC surface for the batch 2a methods only.
function startBackend(options = {}) {
  const state = { capabilitiesCalls: 0, rpcCalls: 0, lastMethod: "", lastParams: null, deleteExecuted: 0 };
  const methods = ["status", "sync.projectInventory", "sync.projectFileStats", "sync.projectTree", "sync.projectTreeState", "sync.planLogPaths", "sync.deletePath", "remote.listDirs", "transfers.list", "transfers.reconcile", "transfers.cancel"];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.end("{}"); return; }
    if (req.method === "GET" && req.url === "/api/v1/capabilities") {
      state.capabilitiesCalls += 1;
      res.end(JSON.stringify({ schemaVersion: 1, name: "SimpleSFTP", version: "0.2.107", instanceId: `${PID}:${STARTED_AT}`, rpc: "json-rpc-2.0", methods }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/rpc") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        state.rpcCalls += 1;
        const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        state.lastMethod = rpc.method;
        state.lastParams = rpc.params;
        const reply = handle(rpc.method, rpc.params);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...reply }));
      });
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  function confirmationRequired(preview) {
    return { error: { code: 2001, message: "CONFIRM_REQUIRED", data: preview } };
  }
  function handle(method, params) {
    if (options.rpc) return options.rpc(method, params, state);
    if (method === "sync.projectInventory") {
      if (!validSource(params.source)) return { error: { code: -32000, message: "来源 SSH 主机或用户名无效。" } };
      if (params.scopePaths !== undefined && !Array.isArray(params.scopePaths)) return { error: { code: -32000, message: "清单范围必须是路径数组。" } };
      return { result: { ok: true, files: { "work_dirs/a.csv": { size: 10 } }, unverifiedFiles: {}, hashedFiles: 1, reusedFiles: 0, cacheRows: 2, cacheStatus: "ok", ...(params.metadataOnly === true ? { comparisonBasis: "metadata" } : {}) } };
    }
    if (method === "sync.projectFileStats") {
      if (!Array.isArray(params.paths) || !params.paths.length) return { error: { code: -32000, message: "文件属性查询必须提供 paths，且不能扫描整个项目。" } };
      if (params.paths.length > 128) return { error: { code: -32000, message: "一次最多查询 128 个项目内文件属性。" } };
      return { result: { ok: true, files: { [String(params.paths[0])]: { size: 3, modifiedAtMs: 1 } }, missing: [] } };
    }
    if (method === "sync.projectTree") {
      if (!validSource(params.source)) return { error: { code: -32000, message: "来源 SSH 主机或用户名无效。" } };
      return { result: { ok: true, relativePath: params.relativePath || ".", exists: true, entries: [{ name: "work_dirs", path: "work_dirs", directory: true, size: null, modifiedAtMs: 1 }] } };
    }
    if (method === "sync.projectTreeState") return { result: { ok: true, relativePath: params.relativePath || ".", exists: true, empty: false } };
    if (method === "sync.planLogPaths") {
      if (!String(params.statePath || "").startsWith("simple_cluster/tmp/cluster_scheduler/") || !String(params.statePath || "").endsWith("_state.json"))
        return { error: { code: -32000, message: "Plan 状态文件路径不受支持。" } };
      if (!params.planFile) return { error: { code: -32000, message: "Plan 状态文件与目标 Plan 不匹配。" } };
      return { result: { ok: true, paths: ["simple_cluster/tmp/cluster_scheduler/logs/a.log"] } };
    }
    if (method === "sync.deletePath") {
      // Mirrors extension.js:862 exactly: any of the four factors failing (including an
      // absolutePath that does not echo the derived one) returns CONFIRM_REQUIRED with the
      // fixed four-item requires list; the delete only runs when all four match.
      const absolutePath = `${String((params.target || {}).remotePath || "").replace(/\/+$/, "")}/${String(params.relativePath || "")}`;
      const ok4 = params.confirm === true && params.pathConfirmed === true && params.secondConfirmation === true && params.confirmedAbsolutePath === absolutePath;
      if (!ok4) return confirmationRequired({ method: "sync.deletePath", operation: "永久删除单台 Worker 的项目路径", target: params.target, relativePath: params.relativePath, absolutePath, requires: ["confirm", "pathConfirmed", "secondConfirmation", "confirmedAbsolutePath"] });
      state.deleteExecuted += 1;
      return { result: { ok: true, target: String((params.target || {}).host || ""), relativePath: params.relativePath, absolutePath } };
    }
    if (method === "remote.listDirs") {
      if (!String(params.remotePath || "").trim()) return { error: { code: -32000, message: "缺少远端目录 remotePath。" } };
      // Real backend: requireApiConfirmation with pathRequired:true (no remembered path in the fake).
      const requires = [];
      if (params.confirm !== true) requires.push("confirm");
      if (params.pathConfirmed !== true) requires.push("pathConfirmed");
      if (requires.length) return confirmationRequired({ method: "remote.listDirs", operation: "列出远端目录", requires, target: { localPath: String(params.localPath || ""), remotePath: params.remotePath } });
      return { result: { ok: true, remotePath: params.remotePath, dirs: [{ name: "exp1", path: `${params.remotePath}/exp1` }] } };
    }
    if (method === "transfers.list") return { result: { ok: true, instanceId: "inst-1", transfers: [], operations: [], settledOperations: [], busy: false } };
    if (method === "transfers.reconcile") {
      if (!String(params.operationId || "")) return { error: { code: -32000, message: "缺少 operationId。" } };
      if (options.reconcileStatus === "settled") return { result: { ok: true, operationId: params.operationId, operationInstanceId: "oi-1", instanceId: "inst-1", status: "settled", settled: true, reason: "" } };
      return { result: { ok: true, operationId: params.operationId, operationInstanceId: "", instanceId: "inst-1", status: "notFound", settled: false, reason: "缺少原始传输身份" } };
    }
    if (method === "transfers.cancel") {
      const id = String(params.transferId || params.id || "").trim();
      const operationId = String(params.operationId || "").trim();
      if (!id && !operationId) return { error: { code: -32000, message: "缺少 transferId 或 operationId。" } };
      return { result: { ok: true, transferId: id, operationId, cancelled: true, status: "cancelling", settled: false, operationInstanceId: "oi-1", instanceId: "inst-1" } };
    }
    return { error: { code: -32601, message: `Method unavailable: ${method}` } };
  }
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const file = path.join(fixtureDir("discovery"), "sftp-api.json");
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "SimpleSFTP", version: "0.2.107", baseUrl: `http://127.0.0.1:${server.address().port}`, host: "127.0.0.1", port: server.address().port, token: TOKEN, pid: PID, startedAt: STARTED_AT }), "utf8");
      resolve({ state, file, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) });
    });
  });
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

test("sync inventory/tree/tree-state/plan-logs forward the real backend parameter shapes", async () => {
  const backend = await startBackend();
  const dir = fixtureDir("sync-params");
  const sourceFile = writeJson(dir, "source.json", SOURCE);
  const scopeFile = writeJson(dir, "scope.json", ["work_dirs", "experiments/results"]);
  try {
    const inventory = await runCli(["sftp", "sync", "inventory", "--file", sourceFile, "--path", "work_dirs", "--no-recursive", "--metadata-only", "--paths", scopeFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(inventory.code, 0, inventory.stdout + inventory.stderr);
    assert.equal(JSON.parse(inventory.stdout).comparisonBasis, "metadata");
    assert.deepEqual(backend.state.lastParams, { source: SOURCE, relativePath: "work_dirs", recursive: false, metadataOnly: true, scopePaths: ["work_dirs", "experiments/results"] });

    const tree = await runCli(["sftp", "sync", "tree", "--file", sourceFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(tree.code, 0, tree.stderr);
    assert.equal(JSON.parse(tree.stdout).exists, true);

    const treeState = await runCli(["sftp", "sync", "tree-state", "--file", sourceFile, "--path", "work_dirs", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(treeState.code, 0, treeState.stderr);
    assert.equal(JSON.parse(treeState.stdout).empty, false);

    const logs = await runCli(["sftp", "sync", "plan-logs", "--file", sourceFile, "--state-path", "simple_cluster/tmp/cluster_scheduler/baseline_state.json", "--plan-file", "experiments/plans/baseline.yaml", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(logs.code, 0, logs.stdout + logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout).paths, ["simple_cluster/tmp/cluster_scheduler/logs/a.log"]);
  } finally { await backend.close(); }
});

test("parameter mistakes refuse with usage exit and zero API calls", async () => {
  const backend = await startBackend();
  const dir = fixtureDir("sync-usage");
  const sourceFile = writeJson(dir, "source.json", SOURCE);
  try {
    const cases = [
      { args: ["sftp", "sync", "inventory", "--json"], match: /needs --file/ },
      { args: ["sftp", "sync", "stats", "--file", sourceFile, "--json"], match: /needs --paths/ },
      { args: ["sftp", "sync", "plan-logs", "--file", sourceFile, "--json"], match: /--state-path/ },
      { args: ["sftp", "sync", "delete", "--file", sourceFile, "--json"], match: /--path/ },
      { args: ["doctor", "--instance", "1:2", "--json"], match: /--plugin/ },
      { args: ["doctor", "--plugin", "nope", "--json"], match: /invalid --plugin/ },
      { args: ["sftp", "remote", "list-dirs", "--json"], match: /--remote-path/ },
      { args: ["sftp", "transfers", "cancel", "--json"], match: /--transfer-id <id> or --operation-id/ },
      { args: ["sftp", "transfers", "reconcile", "--json"], match: /--operation-id/ },
    ];
    for (const item of cases) {
      const result = await runCli([...item.args, "--json"], { env: sftpEnv(backend.file) });
      assert.equal(result.code, 1, `${item.args.join(" ")}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, item.match);
    }
    const badPaths = writeJson(dir, "bad.json", { not: "an array" });
    const malformed = await runCli(["sftp", "sync", "stats", "--file", sourceFile, "--paths", badPaths, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(malformed.code, 1);
    assert.match(malformed.stdout + malformed.stderr, /JSON array/);
    const tooMany = writeJson(dir, "many.json", Array.from({ length: 129 }, (_, i) => `f${i}.csv`));
    const oversized = await runCli(["sftp", "sync", "stats", "--file", sourceFile, "--paths", tooMany, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(oversized.code, 1);
    assert.match(oversized.stdout + oversized.stderr, /128/);
    assert.equal(backend.state.rpcCalls, 0, "parameter errors must never open an RPC round trip");
    assert.equal(backend.state.capabilitiesCalls, 0, "parameter errors must not even start the API handshake");
  } finally { await backend.close(); }
});

test("sync stats echoes the bounded stats contract", async () => {
  const backend = await startBackend();
  const dir = fixtureDir("sync-stats");
  const sourceFile = writeJson(dir, "source.json", SOURCE);
  const pathsFile = writeJson(dir, "paths.json", ["work_dirs/a.csv", "work_dirs/b.csv"]);
  try {
    const ok = await runCli(["sftp", "sync", "stats", "--file", sourceFile, "--paths", pathsFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(backend.state.lastParams, { source: SOURCE, paths: ["work_dirs/a.csv", "work_dirs/b.csv"] });
    assert.equal(JSON.parse(ok.stdout).files["work_dirs/a.csv"].size, 3);
  } finally { await backend.close(); }
});

test("sync delete previews with zero execution; execution needs the echoed absolute path plus all confirmations", async () => {
  const backend = await startBackend();
  const dir = fixtureDir("sync-delete");
  const sourceFile = writeJson(dir, "source.json", SOURCE);
  const ABS = "/data/projects/exp/tmp/stale";
  const base = ["sftp", "sync", "delete", "--file", sourceFile, "--path", "tmp/stale"];
  try {
    // 1) Safe first-time preview: no confirmation flags, no absolute path — server answers with
    //    the derived absolutePath and the fixed four factors, and nothing executes.
    const preview = await runCli([...base, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(preview.code, 2, preview.stdout + preview.stderr);
    const previewBody = JSON.parse(preview.stdout);
    assert.equal(previewBody.error.code, "ENV");
    assert.match(previewBody.error.message, /CONFIRM_REQUIRED: sync.deletePath/);
    assert.deepEqual(previewBody.error.detail.requires, ["confirm", "pathConfirmed", "secondConfirmation", "confirmedAbsolutePath"]);
    assert.equal(previewBody.error.detail.absolutePath, ABS);
    assert.ok(!preview.stdout.includes(TOKEN));
    assert.equal(backend.state.deleteExecuted, 0);

    // 2) All boolean flags but a wrong absolute path: still refused, nothing executes.
    const wrong = await runCli([...base, "--confirmed-absolute", "/data/projects/exp/tmp/other", "--confirm", "--path-confirmed", "--second-confirmation", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(wrong.code, 2);
    assert.deepEqual(JSON.parse(wrong.stdout).error.detail.requires, ["confirm", "pathConfirmed", "secondConfirmation", "confirmedAbsolutePath"]);
    assert.equal(backend.state.deleteExecuted, 0);

    // 3) Partial confirmation with the correct absolute path: refused by the missing factor.
    const partial = await runCli([...base, "--confirmed-absolute", ABS, "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(partial.code, 2);
    assert.equal(backend.state.deleteExecuted, 0);

    // 4) Exact four factors: only now the backend runs it, parameters forwarded untouched.
    const done = await runCli([...base, "--confirmed-absolute", ABS, "--confirm", "--path-confirmed", "--second-confirmation", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(done.code, 0, done.stdout + done.stderr);
    assert.deepEqual(backend.state.lastParams, { target: SOURCE, relativePath: "tmp/stale", confirm: true, pathConfirmed: true, secondConfirmation: true, confirmedAbsolutePath: ABS });
    assert.equal(JSON.parse(done.stdout).ok, true);
    assert.equal(backend.state.deleteExecuted, 1);
  } finally { await backend.close(); }
});

test("remote list-dirs keeps the confirm/pathConfirmed contract visible", async () => {
  const backend = await startBackend();
  const preview = await runCli(["sftp", "remote", "list-dirs", "--remote-path", "/data/projects", "--json"], { env: sftpEnv(backend.file) });
  try {
    assert.equal(preview.code, 2);
    const body = JSON.parse(preview.stdout);
    assert.deepEqual(body.error.detail.requires, ["confirm", "pathConfirmed"]);
    const ok = await runCli(["sftp", "remote", "list-dirs", "--remote-path", "/data/projects", "--confirm", "--path-confirmed", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).dirs[0].name, "exp1");
  } finally { await backend.close(); }
});

test("transfers list/reconcile/cancel pass receipts through without inventing status", async () => {
  const backend = await startBackend();
  try {
    const list = await runCli(["sftp", "transfers", "list", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(list.code, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout).ok, true);

    const unknown = await runCli(["sftp", "transfers", "reconcile", "--operation-id", "op-9", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(unknown.code, 0, unknown.stderr);
    const unknownBody = JSON.parse(unknown.stdout);
    assert.equal(unknownBody.status, "notFound");
    assert.equal(unknownBody.settled, false, "a notFound receipt must not be reported as settled");

    const cancelled = await runCli(["sftp", "transfers", "cancel", "--transfer-id", "t-1", "--reason", "cli test", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.deepEqual(backend.state.lastParams, { transferId: "t-1", reason: "cli test" });
    assert.equal(JSON.parse(cancelled.stdout).status, "cancelling");
  } finally { await backend.close(); }
});

test("business refusals from the backend stay exit 3 with the real message", async () => {
  const backend = await startBackend({ rpc: (method) => (method === "sync.projectInventory" ? { error: { code: -32000, message: "远端项目清单无效。" } } : { result: { ok: true } }) });
  const dir = fixtureDir("sync-refuse");
  const sourceFile = writeJson(dir, "source.json", SOURCE);
  try {
    const result = await runCli(["sftp", "sync", "inventory", "--file", sourceFile, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(result.code, 3);
    assert.match(result.stdout, /远端项目清单无效/);
  } finally { await backend.close(); }
});

test("--instance pins every call to one live instance and mismatch refuses before the RPC", async () => {
  const backend = await startBackend();
  try {
    const wrong = await runCli(["sftp", "capabilities", "--instance", "9999:2026-01-01T00:00:00.000Z", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(wrong.code, 2, wrong.stdout + wrong.stderr);
    assert.match(wrong.stdout, /Instance pin mismatch/);
    assert.ok(!wrong.stdout.includes(TOKEN));

    const wrongRpc = await runCli(["sftp", "transfers", "list", "--instance", "9999:2026-01-01T00:00:00.000Z", "--json"], { env: sftpEnv(backend.file) });
    assert.equal(wrongRpc.code, 2);
    assert.equal(backend.state.rpcCalls, 0, "a pinned mismatch must never reach the RPC endpoint");

    const right = await runCli(["sftp", "transfers", "list", "--instance", `${PID}:${STARTED_AT}`, "--json"], { env: sftpEnv(backend.file) });
    assert.equal(right.code, 0, right.stderr);
    assert.equal(backend.state.rpcCalls, 1);

    const envPinned = await runCli(["sftp", "transfers", "list", "--json"], { env: sftpEnv(backend.file, { SIMPLE_CLI_INSTANCE_ID: "7:7" }) });
    assert.equal(envPinned.code, 2);
    assert.match(envPinned.stdout, /Instance pin mismatch/);
  } finally { await backend.close(); }
});

// A live SimpleExperiment fake with its own identity, different from the sftp fake on purpose.
const EXP_PID = 55;
const EXP_STARTED_AT = "2026-02-02T02:22:22.000Z";
function startExperiment(override = {}) {
  const state = { capabilitiesCalls: 0, rpcCalls: 0, lastParams: null };
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/v1/capabilities") {
      state.capabilitiesCalls += 1;
      res.end(JSON.stringify({ schemaVersion: 1, name: "SimpleExperiment", version: "0.5.403", instanceId: override.instanceId || `${EXP_PID}:${EXP_STARTED_AT}`, rpc: "json-rpc-2.0", methods: ["status", "tasks.dispatch"] }));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      state.rpcCalls += 1;
      state.lastParams = JSON.parse(Buffer.concat(chunks).toString("utf8")).params;
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const file = path.join(fixtureDir("exp-discovery"), "exp-api.json");
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "SimpleExperiment", version: "0.5.403", baseUrl: `http://127.0.0.1:${server.address().port}`, host: "127.0.0.1", port: server.address().port, token: TOKEN, pid: EXP_PID, startedAt: EXP_STARTED_AT }), "utf8");
      resolve({ state, file, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) });
    });
  });
}

test("doctor per-plugin pins verify two fully live plugins with different identities", async () => {
  const sftp = await startBackend();
  const exp = await startExperiment();
  const sftpId = `${PID}:${STARTED_AT}`;
  const expId = `${EXP_PID}:${EXP_STARTED_AT}`;
  const env = { SIMPLE_SFTP_MAC_API_FILE: sftp.file, SIMPLE_EXPERIMENT_MAC_API_FILE: exp.file };
  try {
    // Joint view with a per-plugin pin each: both must pass with distinct identities.
    const both = await runCli(["doctor", "--instance-experiment", expId, "--instance-sftp", sftpId, "--json"], { env });
    assert.equal(both.code, 0, both.stdout + both.stderr);
    const bothBody = JSON.parse(both.stdout);
    assert.equal(bothBody.plugins.length, 2);
    for (const row of bothBody.plugins) {
      assert.equal(row.ok, true, JSON.stringify(row));
      assert.ok(row.checks.some((check) => check.name === "instance-pin" && check.ok), JSON.stringify(row));
    }

    // Single-plugin view with the matching --instance: exit 0 and only that row reported.
    const single = await runCli(["doctor", "--plugin", "experiment", "--instance", expId, "--json"], { env });
    assert.equal(single.code, 0, single.stdout + single.stderr);
    const singleBody = JSON.parse(single.stdout);
    assert.equal(singleBody.plugins.length, 1);
    assert.equal(singleBody.plugins[0].plugin, "SimpleExperiment");

    // The sftp identity cannot pin the experiment plugin (they started apart on purpose).
    const crossed = await runCli(["doctor", "--plugin", "experiment", "--instance", sftpId, "--json"], { env });
    assert.equal(crossed.code, 2);
    const crossedRow = JSON.parse(crossed.stdout).plugins[0];
    assert.equal(crossedRow.ok, false);
    assert.ok(crossedRow.checks.some((check) => check.name === "instance-pin" && !check.ok), JSON.stringify(crossedRow));

    // A pin never switches targets: with both plugins selected and one pin the CLI refuses as usage.
    const ambiguous = await runCli(["doctor", "--instance", expId, "--json"], { env });
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.stdout + ambiguous.stderr, /--plugin/);
  } finally { await sftp.close(); await exp.close(); }
});

test("the A domain honours --instance from the CLI with the flag outranking the env", async () => {
  const exp = await startExperiment();
  const expId = `${EXP_PID}:${EXP_STARTED_AT}`;
  const wrongId = "9999:2026-01-01T00:00:00.000Z";
  const dispatch = (env) => runCli(["task", "dispatch", "--workflow", "wf", "--jobs", "0", "--worker", "w", "--gpu", "0", "--confirm", "--json"], { env: { SIMPLE_EXPERIMENT_MAC_API_FILE: exp.file, ...env } });
  try {
    // Explicit wrong flag, no env: refused before the RPC.
    const badRun = await runCli(["task", "dispatch", "--workflow", "wf", "--jobs", "0", "--worker", "w", "--gpu", "0", "--confirm", "--instance", wrongId, "--json"], { env: { SIMPLE_EXPERIMENT_MAC_API_FILE: exp.file } });
    assert.equal(badRun.code, 2, badRun.stdout + badRun.stderr);
    assert.match(badRun.stdout, /Instance pin mismatch/);
    assert.equal(exp.state.rpcCalls, 0, "a pinned A-domain mismatch must send zero RPC");

    // Correct explicit flag: succeeds through the same transport.
    const good = await runCli(["task", "dispatch", "--workflow", "wf", "--jobs", "0", "--worker", "w", "--gpu", "0", "--confirm", "--instance", expId, "--json"], { env: { SIMPLE_EXPERIMENT_MAC_API_FILE: exp.file } });
    assert.equal(good.code, 0, good.stdout + good.stderr);
    assert.equal(exp.state.rpcCalls, 1);

    // Conflict: correct flag + wrong env -> flag wins (success).
    const flagWins = await runCli(["task", "dispatch", "--workflow", "wf", "--jobs", "0", "--worker", "w", "--gpu", "0", "--confirm", "--instance", expId, "--json"], { env: { SIMPLE_EXPERIMENT_MAC_API_FILE: exp.file, SIMPLE_CLI_INSTANCE_ID: wrongId } });
    assert.equal(flagWins.code, 0, flagWins.stdout + flagWins.stderr);

    // Conflict: wrong flag + correct env -> flag still wins (refusal, no RPC this round).
    const before = exp.state.rpcCalls;
    const envWins = await runCli(["task", "dispatch", "--workflow", "wf", "--jobs", "0", "--worker", "w", "--gpu", "0", "--confirm", "--instance", wrongId, "--json"], { env: { SIMPLE_EXPERIMENT_MAC_API_FILE: exp.file, SIMPLE_CLI_INSTANCE_ID: expId } });
    assert.equal(envWins.code, 2);
    assert.equal(exp.state.rpcCalls, before, "the CLI flag must outrank the env, never the reverse");

    // Env-only pin (no flag) still guards as before.
    const envOnly = await dispatch({ SIMPLE_CLI_INSTANCE_ID: wrongId });
    assert.equal(envOnly.code, 2);
    assert.match(envOnly.stdout, /Instance pin mismatch/);
  } finally { await exp.close(); }
});

test("sftp help advertises the new domains and the instance pin", async () => {
  const result = await runCli(["sftp", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /sync inventory --file source\.json/);
  assert.match(result.stdout, /transfers cancel/);
  assert.match(result.stdout, /--instance <pid:startedAt>/);
  const doctor = await runCli(["doctor", "--help"]);
  assert.match(doctor.stdout, /--instance/);
});
