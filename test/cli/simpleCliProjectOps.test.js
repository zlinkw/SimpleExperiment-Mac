const { assert, fs, http, os, path, test, runCli } = require("./simpleCli.support.cjs");

// Batch 3 (A project.prepare / project.bootstrap / project.bootstrap.operation): the fake mirrors the
// real handler gates at the RPC boundary — confirmationRequired = LocalApiError(2001,"CONFIRM_REQUIRED",preview)
// when params.confirm!==true (src/extension/legacy.ts:2310-2317 prepare, :2794-2804 bootstrap with
// preview {prepare,validation}), {ok:true,operationId,status:"started"} once confirmed (:2827), and the
// operation lookup that throws for unknown ids (:2874-2881 → business refusal). CLI-side coverage here is
// parameter passthrough + refusal shapes against this mock; it is NOT real-server proof — the confirmed
// path against a live extension host (Xshell/SFTP profile/runtime writes) is never exercised here and
// nothing real is touched anywhere. FIXTURE POLICY: zero cleanup; unique retained run directory.
const TOKEN = "projectops-batch-token";
const PID = 6363;
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `simple-projectops-fixtures-${Date.now()}-${process.pid}-`));
console.log(`[fixtures retained, no cleanup] ${FIXTURE_ROOT}`);

function fixtureDir(name) {
  const dir = path.join(FIXTURE_ROOT, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

function startProjectOpsBackend() {
  const state = { capabilitiesCalls: 0, rpcCalls: 0, lastMethod: "", lastParams: null, seenMethods: [] };
  const methods = ["status", "project.prepare", "project.bootstrap", "project.bootstrap.operation"];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.end("{}"); return; }
    if (req.method === "GET" && req.url === "/api/v1/capabilities") {
      state.capabilitiesCalls += 1;
      res.end(JSON.stringify({ schemaVersion: 1, name: "SimpleExperiment", version: "0.0.0-fake", instanceId: `${PID}:${STARTED_AT}`, rpc: "json-rpc-2.0", methods }));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      state.rpcCalls += 1;
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.lastMethod = rpc.method;
      state.lastParams = rpc.params;
      state.seenMethods.push(rpc.method);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...handle(rpc.method, rpc.params || {}) }));
    });
  });
  function handle(method, params) {
    if (method === "project.prepare") {
      if (params.confirm !== true) {
        return { error: { code: 2001, message: "CONFIRM_REQUIRED", data: { operation: "project.prepare", requires: ["confirm"], missing: [{ step: "validate_plan", reason: "需要选择 PLAN" }], preview: { operation: "project.prepare", workspace: params.workspace || "/host-workspace" }, params: { ...params, confirm: undefined } } } };
      }
      return { result: { ok: true, operation: "project.prepare", enabledServers: params.serverIds || [], deferredValidation: true } };
    }
    if (method === "project.bootstrap") {
      if (params.confirm !== true) {
        return { error: { code: 2001, message: "CONFIRM_REQUIRED", data: { operation: "project.bootstrap", requires: ["confirm"], missing: [{ step: "validate_plan", reason: "需要选择 PLAN" }], preview: { prepare: { operation: "project.prepare" }, validation: { ok: true, missing: [] } }, params: { ...params, confirm: undefined } } } };
      }
      return { result: { ok: true, operationId: "op-boot-1", status: "started", startedAt: "2026-10-23T00:00:00.000Z" } };
    }
    if (method === "project.bootstrap.operation") {
      const operationId = String(params.operationId || params.opId || "");
      if (operationId === "op-fail-1") {
        // Real failed shape (legacy.ts:2811-2827): the LOOKUP still answers ok:true — the failure lives inside operation.
        return { result: { ok: true, operation: { operationId, type: "bootstrap-project", status: "failed", error: "project.bootstrap 前置检查未通过：[{\"step\":\"validate_plan\"}]", message: "project.bootstrap 前置检查未通过：[{\"step\":\"validate_plan\"}]", finishedAt: "2026-10-23T00:05:00.000Z" } } };
      }
      if (operationId !== "op-boot-1") return { error: { code: 2010, message: `未找到 project.bootstrap 操作：${operationId || "-"}` } };
      return { result: { ok: true, operation: { operationId, type: "bootstrap-project", status: "succeeded" } } };
    }
    return { error: { code: -32601, message: `Method unavailable: ${method}` } };
  }
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const file = path.join(fixtureDir("discovery"), "experiment-api.json");
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "SimpleExperiment", version: "0.0.0-fake", baseUrl: `http://127.0.0.1:${server.address().port}`, host: "127.0.0.1", port: server.address().port, token: TOKEN, pid: PID, startedAt: STARTED_AT }), "utf8");
      resolve({ state, file, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) });
    });
  });
}

test("input-deterministic refusals are local: zero capabilities, zero RPC, from a foreign cwd without root env", async () => {
  const cwd = fixtureDir("empty-cwd");
  const backend = await startProjectOpsBackend();
  const dir = fixtureDir("refusals");
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{oops", "utf8");
  const objectWorkers = writeJson(dir, "object-workers.json", { id: "n1" });
  const emptyWorkers = writeJson(dir, "empty-workers.json", []);
  const scalarWorker = writeJson(dir, "scalar-worker.json", ["n1"]);
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  assert.ok(!("SIMPLE_EXPERIMENT_PROJECT_ROOT" in process.env), "the test process itself must not carry the root env");
  try {
    const zeroBefore = { c: backend.state.capabilitiesCalls, r: backend.state.rpcCalls };
    for (const args of [
      ["project", "prepare", "--mode", "hub", "--json"], // HUB_REMOVED fast path (backend refuses the same input)
      ["project", "prepare", "--server-ids", "hub,n1", "--json"], // hub in serverIds
      ["project", "prepare", "--hub", writeJson(dir, "hub-any.json", { host: "legacy.example" }), "--json"], // hub retirement red line: refused before any file read or RPC
      ["project", "bootstrap", "--hub", writeJson(dir, "hub-any.json", { host: "legacy.example" }), "--json"],
      ["project", "prepare", "--server-ids", " , ", "--json"], // empty id list
      ["project", "prepare", "--workers", objectWorkers, "--json"], // workerTunnels must be an array
      ["project", "prepare", "--workers", emptyWorkers, "--json"],
      ["project", "prepare", "--workers", scalarWorker, "--json"], // entries must be objects
      ["project", "prepare", "extra-positional", "--json"],
      ["project", "bootstrap", "--legacy-migration-digests", broken, "--json"],
      ["project", "bootstrap", "--no-apply-topology", "--json"], // bootstrap forces applyTopology:true (:2850) — opt-out is prepare-only
      ["project", "prepare", "--start-sessions", "--no-start-sessions", "--json"], // paired conflict
      ["project", "bootstrap", "--auto-test", "--no-auto-test", "--json"], // paired conflict
      ["project", "bootstrap", "--start-sessions", "--json"], // wrong action: bootstrap defaults it on
      ["project", "bootstrap", "--auto-test", "--json"],
      ["project", "prepare", "--no-start-sessions", "--json"], // wrong action: prepare defaults it off
      ["project", "prepare", "--no-auto-test", "--json"],
      ["project", "bootstrap-operation", "--json"], // missing --operation-id
    ]) {
      const result = await runCli([...args, "--json"], env);
      assert.equal(result.code, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    }
    assert.equal(backend.state.capabilitiesCalls, zeroBefore.c, "project ops route before the root probe: refusals read no capabilities/RPC");
    assert.equal(backend.state.rpcCalls, zeroBefore.r);
  } finally { await backend.close(); }
});

test("project prepare forwards exactly the real parameter set and the preview path keeps confirm absent", async () => {
  const cwd = fixtureDir("cwd");
  const backend = await startProjectOpsBackend();
  const dir = fixtureDir("params");
  const workers = writeJson(dir, "workers.json", [{ id: "n1", host: "w1.example" }, { id: "n2", host: "w2.example" }]);
  const digests = writeJson(dir, "digests.json", { "n1": "a".repeat(64) });
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  try {
    const preview = await runCli(["project", "prepare", "--workspace", "/srv/proj", "--server-ids", "n1,n2",
      "--workers", workers, "--plan-file", "experiments/plans/base.yaml", "--skip-xshell", "--skip-runtime",
      "--no-apply-topology", "--start-sessions", "--auto-test", "--legacy-migration-digests", digests, "--json"], env);
    assert.equal(preview.code, 2, preview.stdout + preview.stderr); // 2001 CONFIRM_REQUIRED → ENV(2) with the full preview
    assert.match(preview.stdout, /"requires":\s*\[\s*"confirm"\s*\]/);
    assert.match(preview.stdout, /validate_plan/);
    assert.deepEqual(backend.state.lastParams, {
      workspace: "/srv/proj",
      serverIds: ["n1", "n2"],
      workerTunnels: [{ id: "n1", host: "w1.example" }, { id: "n2", host: "w2.example" }],
      planFile: "experiments/plans/base.yaml",
      applyXshell: false,
      deployRuntime: false,
      applyTopology: false, // prepare-only opt-out honored (legacy.ts:2317)
      startSessions: true,
      autoTest: true,
      legacyMigrationDigests: { "n1": "a".repeat(64) },
    }, "confirm is forwarded only when the flag is actually given — never auto-filled as false");

    const confirmed = await runCli(["project", "prepare", "--mode", "worker_pool", "--server-ids", "n1", "--plan-id", "plan-7", "--confirm", "--json"], env);
    assert.equal(confirmed.code, 0, confirmed.stdout + confirmed.stderr);
    assert.deepEqual(backend.state.lastParams, { topologyMode: "worker_pool", serverIds: ["n1"], planId: "plan-7", confirm: true });
    assert.equal(JSON.parse(confirmed.stdout).ok, true);
  } finally { await backend.close(); }
});

test("bootstrap answers the started receipt once confirmed, exposes both default opt-outs, and the operation is only re-read", async () => {
  const cwd = fixtureDir("cwd");
  const backend = await startProjectOpsBackend();
  const env = { cwd, env: { SIMPLE_EXPERIMENT_MAC_API_FILE: backend.file } };
  try {
    const gated = await runCli(["project", "bootstrap", "--server-ids", "n1", "--plan-file", "p.yaml", "--json"], env);
    assert.equal(gated.code, 2, gated.stdout + gated.stderr);
    assert.match(gated.stdout, /"validation"/); // preview carries {prepare,validation}
    assert.ok(!("confirm" in backend.state.lastParams));

    const started = await runCli(["project", "bootstrap", "--server-ids", "n1", "--plan-file", "p.yaml", "--no-start-sessions", "--no-auto-test", "--confirm", "--json"], env);
    assert.equal(started.code, 0, started.stdout + started.stderr);
    assert.deepEqual(backend.state.lastParams, { serverIds: ["n1"], planFile: "p.yaml", startSessions: false, autoTest: false, confirm: true });
    const receipt = JSON.parse(started.stdout);
    assert.equal(receipt.status, "started");
    assert.equal(receipt.operationId, "op-boot-1");

    const reread = await runCli(["project", "bootstrap-operation", "--operation-id", "op-boot-1", "--json"], env);
    assert.equal(reread.code, 0, reread.stdout + reread.stderr);
    assert.deepEqual(backend.state.lastParams, { operationId: "op-boot-1" }, "the lookup carries only the operation identity");
    assert.equal(JSON.parse(reread.stdout).operation.status, "succeeded");

    const unknown = await runCli(["project", "bootstrap-operation", "--operation-id", "op-missing", "--json"], env);
    assert.equal(unknown.code, 3, unknown.stdout + unknown.stderr); // backend refusal → BUSINESS(3), never a fake success
    assert.match(unknown.stdout, /未找到 project\.bootstrap 操作/);

    // A FAILED bootstrap still answers the lookup with ok:true — query success ≠ bootstrap success.
    const bootCallsBefore = backend.state.seenMethods.filter((m) => m === "project.bootstrap").length; // gated preview + the one confirmed submit
    const failed = await runCli(["project", "bootstrap-operation", "--operation-id", "op-fail-1", "--json"], env);
    assert.equal(failed.code, 0, failed.stdout + failed.stderr); // exit 0 = the QUERY succeeded; the failure is inside operation
    const report = JSON.parse(failed.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.operation.status, "failed");
    assert.match(report.operation.error, /project\.bootstrap 前置检查未通过/); // the full error survives — nothing dropped
    assert.equal(JSON.parse(started.stdout).operationId, "op-boot-1", "a failed operation is never answered by re-submitting bootstrap");
    assert.equal(backend.state.seenMethods.filter((m) => m === "project.bootstrap").length, bootCallsBefore, "reading a failed operation never re-issues project.bootstrap");
  } finally { await backend.close(); }
});

test("project help and the domain overview document the ops entries", async () => {
  const help = await runCli(["project", "--help"]);
  assert.equal(help.code, 0);
  for (const probe of ["project bootstrap-operation --operation-id", "requires:[\"confirm\"]", "never auto-fills", "HUB_REMOVED", "never replays",
    "--no-apply-topology is prepare-only", "no Hub configuration path", "input conflicts refused with zero API", "never re-submits bootstrap"]) {
    assert.ok(help.stdout.includes(probe), `help must mention ${probe}`);
  }
  const overview = await runCli(["--help"]);
  assert.equal(overview.code, 0);
  assert.ok(overview.stdout.includes("status | prepare | bootstrap | bootstrap-operation"));
});
