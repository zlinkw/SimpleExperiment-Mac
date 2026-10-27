const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const { readSource } = require("../_helpers/sourceReader");

const execFileAsync = promisify(execFile);

function runCli(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...extraEnv }, timeout:10000, windowsHide:true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const root = path.resolve(__dirname, "../..");
const { LocalApiServer, confirmationRequired, loopbackRequest, parseRemoteAddress } = require("../../dist/api/LocalApiServer.js");
const extensionSource = readSource("src/extension.ts");
const apiServerSource = readSource("src/api/LocalApiServer.ts");
const workflow = require("../../dist/features/ApiWorkflow.js");
const topologyMode = require("../../dist/features/TopologyMode.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function startServer(methods = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-api-test-"));
  const port = await freePort();
  const server = new LocalApiServer({
    name: "SimpleExperiment Test",
    version: "0.3.0-test",
    preferredPort: port,
    discoveryPath: path.join(dir, "api.json"),
    methods,
    ...options,
  });
  const discovery = await server.start();
  return {
    root: dir,
    server,
    baseUrl: discovery.baseUrl,
    token: discovery.token,
    cleanup: async () => {
      await server.dispose();
      // Keep the private API fixture directory for audit.
    },
  };
}

function request(port, requestOptions, body) {
  return new Promise((resolve, reject) => {
    const options = { hostname: "127.0.0.1", port, ...requestOptions };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function rpc(port, token, method, params = {}) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  return request(port, {
    method: "POST",
    path: "/api/v1/rpc",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  }, body).then((response) => ({ status: response.status, body: JSON.parse(response.text) }));
}

test("SimpleExperiment local API rejects non-loopback peers", () => {
  assert.equal(parseRemoteAddress("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(loopbackRequest({ socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(loopbackRequest({ socket: { remoteAddress: "::1" } }), true);
  assert.equal(loopbackRequest({ socket: { remoteAddress: "10.0.0.1" } }), false);
  assert.equal(loopbackRequest({ socket: { remoteAddress: "fe80::1" } }), false);
});

test("SimpleExperiment local API requires bearer auth and handles invalid RPC", async () => {
  const f = await startServer({ "status": async () => ({ ok: true }) });
  try {
    const health = await request(f.server.port, { method: "GET", path: "/api/v1/health" });
    assert.equal(health.status, 401);
    const unknown = await rpc(f.server.port, f.token, "unknown");
    assert.equal(unknown.body.error.code, -32601);
    const invalid = await request(f.server.port, {
      method: "POST",
      path: "/api/v1/rpc",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.token}` },
    }, JSON.stringify({ method: "status" }));
    assert.equal(invalid.status, 400);
    assert.equal(JSON.parse(invalid.text).error.code, -32600);
  } finally {
    await f.cleanup();
  }
});

test("SimpleExperiment local API exposes health, capabilities and OpenAPI", async () => {
  const f = await startServer({ "status": async () => ({ ok: true }), "plans.list": async () => ({ plans: [] }) });
  try {
    const health = await request(f.server.port, {
      method: "GET",
      path: "/api/v1/health",
      headers: { Authorization: `Bearer ${f.token}` },
    });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).version, "0.3.0-test");

    const capabilities = await request(f.server.port, {
      method: "GET",
      path: "/api/v1/capabilities",
      headers: { Authorization: `Bearer ${f.token}` },
    });
    assert.equal(JSON.parse(capabilities.text).confirmation.required, true);

    const openapi = await request(f.server.port, {
      method: "GET",
      path: "/api/v1/openapi.json",
      headers: { Authorization: `Bearer ${f.token}` },
    });
    const spec = JSON.parse(openapi.text);
    assert.equal(spec.openapi, "3.0.0");
    assert.ok(spec.paths["/api/v1/rpc"].post);
  } finally {
    await f.cleanup();
  }
});

test("CONFIRM_REQUIRED is returned as a JSON-RPC API error", async () => {
  const f = await startServer({
    "invoke": async () => {
      throw confirmationRequired({ operation: "runPlan", requires: ["confirm"] });
    },
  });
  try {
    const response = await rpc(f.server.port, f.token, "invoke", { command: "runPlan" });
    assert.equal(response.body.error.code, 2001);
    assert.equal(response.body.error.message, "CONFIRM_REQUIRED");
    assert.deepEqual(response.body.error.data.requires, ["confirm"]);
  } finally {
    await f.cleanup();
  }
});

test("SSE stream is bounded and terminates after the event cap", async () => {
  const f = await startServer({}, { maxEvents: 2, sseTimeoutMs: 500 });
  try {
    f.server.publish({ type: "one", data: 1 });
    f.server.publish({ type: "two", data: 2 });
    f.server.publish({ type: "three", data: 3 });
    const response = await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: "127.0.0.1",
        port: f.server.port,
        path: "/api/v1/events",
        headers: { Authorization: `Bearer ${f.token}` },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
    });
    assert.equal(response.status, 200);
    assert.equal((response.text.match(/^id: /gm) || []).length, 2);
  } finally {
    await f.cleanup();
  }
});

test("simpleex CLI reads the discovery file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-cli-test-"));
  try {
    const discoveryPath = path.join(dir, "api.json");
    fs.writeFileSync(discoveryPath, `${JSON.stringify({
      schemaVersion: 1,
      name: "SimpleExperiment",
      baseUrl: "http://127.0.0.1:19765",
      port: 19765,
      token: "test-token",
      pid: 123,
    })}\n`, "utf8");
    process.env.SIMPLE_EXPERIMENT_MAC_API_FILE = discoveryPath;
    const { readApiDiscovery } = require("../../dist/cli.js");
    const discovery = readApiDiscovery();
    assert.equal(discovery.port, 19765);
    assert.equal(discovery.token, "test-token");
  } finally {
    delete process.env.SIMPLE_EXPERIMENT_MAC_API_FILE;
    // FIXTURE POLICY: zero cleanup — retained for audit instead of rmSync (2026-10-23 rework).
    console.log(`[fixtures retained, no cleanup] ${dir}`);
  }
});

// The revoked `simpleex api` passthrough and `simpleex self-check` are replaced by named
// commands plus `simpleex doctor` (user decision 2026-10-23). These migrated tests keep the
// same intent: a named command must reach the live listener through the unified transport,
// and doctor must report missing discovery honestly instead of faking success.
test("simpleex named command reaches the live listener through the unified transport", async () => {
  const f = await startServer(
    { status: async () => ({ ok: true, mode: "cli" }), "tasks.dispatch": async (params) => ({ ok: true, echo: params }) },
    { name: "SimpleExperiment" },
  );
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(root, "dist", "cli.js"), "task", "dispatch",
      "--workflow", "wf-1", "--jobs", "0,2", "--worker", "w-a", "--gpu", "0", "--confirm", "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, SIMPLE_EXPERIMENT_MAC_API_FILE: path.join(f.root, "api.json") },
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.echo.confirm, true, "the confirm flag must reach the server-side handler");
    assert.deepEqual(parsed.echo.indices, [0, 2]);
    assert.equal(parsed.echo.workflowId, "wf-1");
  } finally {
    await f.cleanup();
  }
});

test("simpleex doctor reports missing discovery and listener", async () => {
  const missing = path.join(os.tmpdir(), `simple-experiment-doctor-${process.pid}-${Date.now()}.json`);
  const result = await runCli([path.join(root, "dist", "cli.js"), "doctor", "--json"], {
    SIMPLE_EXPERIMENT_MAC_API_FILE: missing,
    SIMPLE_SFTP_MAC_API_FILE: `${missing}.sftp`,
  });
  assert.equal(result.code, 2, result.stderr || "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  const experiment = parsed.plugins.find((row) => row.discoveryPath === missing);
  assert.ok(experiment, "doctor must report the experiment plugin row");
  assert.equal(experiment.ok, false);
  assert.equal(experiment.instanceId, null);
  assert.ok(experiment.checks.some((item) => item.name === "discovery" && !item.ok && /discovery not found/i.test(item.detail)));
});

test("simpleex doctor passes with live listener", async () => {
  const f = await startServer({ status: async () => ({ ok: true }) }, { name: "SimpleExperiment" });
  try {
    const result = await runCli([path.join(root, "dist", "cli.js"), "doctor", "--json"], {
      SIMPLE_EXPERIMENT_MAC_API_FILE: path.join(f.root, "api.json"),
      SIMPLE_SFTP_MAC_API_FILE: path.join(f.root, "absent-sftp-api.json"),
    });
    const parsed = JSON.parse(result.stdout);
    const experiment = parsed.plugins.find((row) => row.discoveryPath === path.join(f.root, "api.json"));
    assert.ok(experiment, "doctor must report the experiment plugin row");
    assert.equal(experiment.ok, true, `live experiment plugin must pass: ${JSON.stringify(experiment)}`);
    assert.ok(experiment.checks.every((item) => item.ok));
    assert.equal(experiment.version, "0.3.0-test");
    // The SFTP plugin is deliberately not running here: doctor must not claim overall success
    // on a partial handshake, so the aggregate exit stays ENV(2).
    assert.equal(parsed.ok, false);
    assert.equal(result.code, 2, result.stderr || "");
  } finally {
    await f.cleanup();
  }
});

test("SimpleExperiment exposes the planned API methods and explicit confirmation gate", () => {
  const methods = [
    "status",
    "state",
    "actions.list",
    "plans.list",
    "results.list",
    "tasks.list",
    "operations.list",
    "gpu.list",
    "gpu.history",
    "live.output",
    "config.list",
    "config.get",
    "config.set",
    "config.reset",
    "state.list",
    "state.get",
    "state.set",
    "state.reset",
    "invoke",
  ];
  for (const method of methods) {
    const pattern = method.includes(".")
      ? new RegExp(`"${method.replace(/\./g, "\\.")}": async`)
      : new RegExp(`["']?${method}["']?\\s*:\\s*async`);
    assert.match(extensionSource, pattern, `missing API method ${method}`);
  }
  assert.match(extensionSource, /LOCAL_API_PREFERRED_PORT = 19765/);
  assert.match(extensionSource, /API_DISCOVERY_PATH = path\.join\(API_DISCOVERY_DIR, "api\.json"\)/);
  assert.match(extensionSource, /const API_CONFIRM_COMMANDS = new Set\(/);
  assert.match(extensionSource, /API_CONFIRM_COMMANDS\.has\(command\) && \(params\.confirm !== true \|\| deletionConfirmation && params\.pathConfirmed !== true\)/);
  assert.match(extensionSource, /throw confirmationRequired\(/);
  assert.match(extensionSource, /new LocalApiServerClass\(/);
  assert.match(extensionSource, /"config\.set": async \(params\) => this\.apiConfigSet\(params\)/);
  assert.match(extensionSource, /"state\.set": async \(params\) => this\.apiStateSet\(params\)/);
  assert.match(extensionSource, /validateApiConfigValue\(/);
  assert.match(extensionSource, /normalizeApiStateValue\(/);
  assert.doesNotMatch(apiServerSource, /\bscp\b|\brsync\b/);
});

test("live output Local API returns the direct Worker response before cached logs", () => {
  const start = extensionSource.indexOf("async apiLiveOutput(");
  const end = extensionSource.indexOf("apiConfigSchema()", start);
  assert.ok(start >= 0 && end > start);
  const body = extensionSource.slice(start, end);
  assert.match(body, /const direct = [\s\S]*?this\.client\.getLiveOutput/);
  assert.match(body, /direct\.(?:text|output|tail)/);
  assert.ok(body.indexOf("fetchSelectedLiveOutput") < body.indexOf("this.buildState().logs"));
  assert.ok(body.indexOf("direct.text") < body.indexOf("this.buildState().logs"));
});

test("SimpleExperiment accepts topology aliases and keeps configured remote roots authoritative", () => {
  assert.equal(topologyMode.normalizeTopologyMode("standalone"), "worker_pool");
  assert.equal(topologyMode.normalizeTopologyMode("worker_only"), "worker_pool");
  assert.equal(topologyMode.normalizeTopologyMode("hub_available"), "worker_pool");
  // Mac working-tree contract: worker_pool is the only executable mode; legacy values stay readable and collapse to it.
  assert.equal(topologyMode.normalizeTopologyMode("banana"), undefined);
  assert.equal(workflow.resolveApiRemoteRoot("/data/qgking/zlk", { id: "nwpu3" }), "/data/qgking/zlk");
  assert.equal(workflow.resolveApiRemoteRoot("/data/custom", { id: "nwpu3" }), "/data/custom");
  assert.equal(workflow.resolveApiRemoteRoot("/data/other", { host: "10.0.0.2" }), "/data/other");
  assert.throws(
    () => workflow.resolveApiRemoteRootWithPolicy("/root/disk1/qgking/zlk", { id: "nwpu3" }, { deniedRoots: ["/root/disk1/qgking/zlk"] }),
    /remote\.deniedRoots/,
  );
  assert.throws(() => workflow.resolveApiRemoteRoot("/srv/simple_agent/projects", {}), /simple_agent/);
  assert.throws(() => workflow.resolveApiRemoteRoot("/srv/zlk_agent/projects", {}), /zlk_agent/);
  assert.throws(() => workflow.resolveApiRemoteRoot("/data/../secret", {}), /\.\./);
  assert.throws(
    () => workflow.resolveApiRemoteRootWithPolicy("/data/qgking/simple", { id: "nwpu3" }, { allowedRoots: ["/data/qgking/zlk"] }),
    /历史命名迁移缺陷/,
  );
});

test("SimpleExperiment workflow state persists every required stage", () => {
  assert.deepEqual(workflow.FLOW_STEPS, [
    "select_servers",
    "select_mode",
    "prepare_agents",
    "validate_plan",
    "dry_run",
    "upload",
    "run",
    "parse_results",
    "quality_gate",
    "statistics",
    "claims_export",
  ]);
  let state = workflow.defaultFlowState();
  state = workflow.advanceFlowStep(state, "select_servers", { completed: true });
  state = workflow.advanceFlowStep(state, "select_mode", { completed: true });
  state = workflow.advanceFlowStep(state, "prepare_agents", { blocked: true });
  assert.equal(state.currentStep, "validate_plan");
  assert.equal(workflow.nextFlowStep(state), "prepare_agents");
  assert.equal(state.steps.prepare_agents.blocked, true);
  assert.match(String(state.steps.prepare_agents.appliedAt || ""), /^\d{4}-\d{2}-\d{2}T/);
});

test("SimpleExperiment plan filter keeps review choices bounded and explicit", () => {
  const plans = [
    { planId: "active-a", planFile: "experiments/plans/a.yaml", status: "ready" },
    { planId: "archived-b", planFile: "archive/b.yaml", status: "ready", archived: true },
    { planId: "blocked-c", planFile: "experiments/plans/c.yaml", status: "blocked" },
  ];
  const ready = workflow.filterPlans(plans, { status: ["ready"], limit: 1 });
  assert.equal(ready.count, 1);
  assert.equal(ready.total, 3);
  assert.equal(ready.plans[0].planId, "active-a");
  const archived = workflow.filterPlans(plans, { archived: true, planId: "archived-b" });
  assert.equal(archived.count, 1);
  assert.equal(archived.plans[0].planId, "archived-b");
});

test("SimpleExperiment preparation selects plans without blocking infrastructure", () => {
  const plans = [
    { planId: "alpha", planFile: "experiments/plans/alpha.yaml" },
    { planId: "beta", planFile: "experiments/plans/beta.yaml" },
  ];
  const explicit = workflow.selectWorkflowPlan(plans, { planFile: "experiments/plans/beta.yaml" });
  assert.equal(explicit.plan.planId, "beta");
  assert.equal(explicit.needsChoice, false);
  assert.deepEqual(explicit.missing, []);

  const choice = workflow.selectWorkflowPlan(plans, {});
  assert.equal(choice.needsChoice, true);
  assert.equal(choice.missing.length, 1);
  assert.equal(choice.missing[0].step, "validate_plan");
  assert.equal(choice.missing[0].reason, "需要选择 PLAN");
  assert.deepEqual(choice.missing[0].options, ["plans.filter"]);
  assert.deepEqual(choice.missing[0].requiredConfirm, []);

  const automatic = workflow.selectWorkflowPlan([plans[0]], {});
  assert.equal(automatic.plan.planId, "alpha");
  assert.deepEqual(automatic.missing, []);

  const absent = workflow.selectWorkflowPlan([], {});
  assert.equal(absent.plan, undefined);
  assert.match(absent.missing[0].reason, /未找到可自动选择的 PLAN/);
});

test("SimpleExperiment prepare decouples infrastructure from PLAN validation", () => {
  const start = extensionSource.indexOf("async apiProjectPrepare");
  const end = extensionSource.indexOf("apiMergedSetupConfig(params = {})", start);
  assert.ok(start >= 0 && end > start);
  const body = extensionSource.slice(start, end);
  assert.match(body, /refreshLocalPlanMetadata\(\{ post: false, force: true \}\)/);
  assert.match(body, /selectWorkflowPlan\(this\.localPlanMetadata\.plans \|\| \[\], params\)/);
  assert.match(body, /plan: planSelection\.plan,/);
  assert.match(body, /requirePlan: false/);
  assert.match(body, /if \(infrastructureMissing\.length \|\| params\.confirm !== true\)/);
  assert.doesNotMatch(body, /if \(missing\.length \|\| params\.confirm !== true\)/);
  assert.match(body, /workDir: this\.agentRuntimeDirs\(target\.remoteRoot\)\.workDir \|\| ""/);
  assert.match(body, /missing,\s*plan: planSelection\.plan/s);
  assert.match(body, /deferredValidation: true/);

  const bootstrapStart = extensionSource.indexOf("async runApiBootstrapOperation");
  const bootstrapEnd = extensionSource.indexOf("async apiProjectBootstrapOperation", bootstrapStart);
  const bootstrapBody = extensionSource.slice(bootstrapStart, bootstrapEnd);
  assert.ok(bootstrapBody.indexOf("await this.apiProjectPrepare") < bootstrapBody.indexOf("const missing = await this.apiPlanValidate"));
});

test("SimpleExperiment NWPU3 worker targets resolve the exact project workDir", () => {
  assert.equal(topologyMode.normalizeTopologyMode("worker_only"), "worker_pool");
  const remoteRoot = workflow.resolveApiRemoteRoot("/data/qgking/zlk", { id: "nwpu3" });
  assert.equal(remoteRoot, "/data/qgking/zlk");
  assert.equal(workflow.remoteProjectWorkDir(remoteRoot, "MultiModal"), "/data/qgking/zlk/MultiModal");
});

test("SimpleExperiment workflow router returns one deterministic next call", () => {
  const plan = { planId: "alpha", planFile: "experiments/plans/alpha.yaml" };
  const selection = workflow.selectWorkflowPlan([plan], {});
  const prepareParams = { serverIds: ["nwpu3"], topologyMode: "worker_only", confirm: true };
  const runParams = { planFile: plan.planFile, planId: plan.planId, debugMode: false };

  const prepare = workflow.buildWorkflowRoute({
    infrastructureMissing: [{ step: "select_servers", reason: "需要 Worker", options: [], requiredConfirm: [] }],
    planSelection: selection,
    validationMissing: [],
    prepareParams,
    runParams,
  });
  assert.equal(prepare.ready, false);
  assert.equal(prepare.nextAction, "project.prepare");
  assert.equal(prepare.calls[0].method, "project.prepare");

  const choose = workflow.buildWorkflowRoute({
    infrastructureMissing: [],
    planSelection: workflow.selectWorkflowPlan([plan, { planId: "beta" }], {}),
    validationMissing: [],
  });
  assert.equal(choose.nextAction, "plans.filter");
  assert.equal(choose.calls[0].method, "plans.filter");

  const validate = workflow.buildWorkflowRoute({
    infrastructureMissing: [],
    planSelection: selection,
    validationMissing: [{ step: "validate_plan", reason: "输出契约未通过", options: [], requiredConfirm: [] }],
  });
  assert.equal(validate.nextAction, "plan.validate");
  assert.equal(validate.calls[0].method, "plan.validate");

  const run = workflow.buildWorkflowRoute({
    infrastructureMissing: [],
    planSelection: selection,
    validationMissing: [],
    runParams,
  });
  assert.equal(run.ready, true);
  assert.equal(run.nextAction, "workflow.run");
  assert.deepEqual(run.calls, [{ method: "workflow.run", params: runParams }]);
});

test("SimpleExperiment uses one configured root across workflow, runtime and SFTP targets", () => {
  const remoteRoot = workflow.resolveApiRemoteRootWithPolicy(
    "/data/qgking/zlk",
    { id: "nwpu3" },
    { allowedRoots: ["/data/qgking/zlk"], deniedRoots: ["/root/disk1/qgking/zlk"] },
  );
  assert.equal(remoteRoot, "/data/qgking/zlk");
  assert.equal(workflow.remoteProjectWorkDir(remoteRoot, "MultiModal"), "/data/qgking/zlk/MultiModal");

  const prepareStart = extensionSource.indexOf("async apiProjectPrepare");
  const prepareEnd = extensionSource.indexOf("apiMergedSetupConfig(params = {})", prepareStart);
  const prepareBody = extensionSource.slice(prepareStart, prepareEnd);
  assert.match(prepareBody, /writeSftpManagerServerProfiles\(targets\.map\(\(target\) => target\.id\)\)/);

  const targetStart = extensionSource.indexOf("apiPrepareServerTargets(topology, serverIds, workerTunnels, setup = this.setupConfig)");
  const targetEnd = extensionSource.indexOf("apiMergedWorkerConfigs(workerTunnels, setup = this.setupConfig)", targetStart);
  const targetBody = extensionSource.slice(targetStart, targetEnd);
  // Retired Hub is never a preparation target (HUB_REMOVED contract); only Worker endpoints are resolved.
  assert.doesNotMatch(targetBody, /hub\.remotePath/);
  assert.doesNotMatch(targetBody, /role: "hub"/);
  assert.doesNotMatch(targetBody, /resolveApiRemoteRootWithPolicy\(hub\.remotePath/);
  assert.match(targetBody, /resolveApiRemoteRootWithPolicy\(target\.remotePath, worker/);
  assert.match(targetBody, /workDir: this\.agentRuntimeDirs\(remoteRoot\)\.workDir \|\| ""/);

  const mergedStart = extensionSource.indexOf("apiMergedWorkerConfigs(workerTunnels, setup = this.setupConfig)");
  const mergedEnd = extensionSource.indexOf("apiPublicTopology(topology)", mergedStart);
  const mergedBody = extensionSource.slice(mergedStart, mergedEnd);
  assert.match(mergedBody, /agentProjectDir: worker\.agentProjectDir \|\| worker\.remoteRoot \|\| existing\.agentProjectDir/);
});

test("SimpleExperiment blocks unconfigured placeholder conda environments before workflow submission", () => {
  assert.match(extensionSource, /assertExecutionCondaEnvReady\(this\.workerActionTargets\(\)\)/);
  assert.match(extensionSource, /condaEnv: worker\.condaEnv === undefined \? existing\.condaEnv : normalizeCondaEnvSetting\(worker\.condaEnv\),/);
  const start = extensionSource.indexOf("assertExecutionCondaEnvReady(workers = this.workerActionTargets())");
  const end = extensionSource.indexOf("assertHubAgentProjectReady()", start);
  assert.ok(start >= 0 && end > start);
  const method = extensionSource.slice(start, end);
  assert.match(method, /未配置 condaEnv/);
  assert.match(method, /workerTunnels\[\]\.condaEnv/);
});

test("SimpleExperiment prepare previews expose the resolved final project path", () => {
  const start = extensionSource.indexOf("async apiProjectPrepare(params = {})");
  const end = extensionSource.indexOf("apiMergedSetupConfig(params = {})", start);
  assert.ok(start >= 0 && end > start);
  const method = extensionSource.slice(start, end);
  for (const field of ["serverId", "role", "sshConfigAlias", "remoteRoot", "projectPath", "agentProjectDir", "condaEnv", "maxConcurrentGpus"]) {
    assert.match(method, new RegExp(`${field}:`));
  }
});

test("SimpleExperiment records local and GitHub versions before run submission", () => {
  assert.match(extensionSource, /async collectRunGitProvenance\(root\)/);
  assert.match(extensionSource, /const repo = await this\.primaryGitRepository\(\)/);
  assert.match(extensionSource, /localCommit = String\(head\.commit \|\| ""\)\.trim\(\)/);
  assert.match(extensionSource, /await repo\.getCommit\(branch \? `\$\{remote\?\.name\}\/\$\{branch\}` : "origin\/HEAD"\)/);
  assert.match(extensionSource, /body\.gitProvenance = await this\.recordRunGitProvenance\(/);
  const record = extensionSource.slice(
    extensionSource.indexOf("async recordRunGitProvenance(planFile"),
    extensionSource.indexOf("async confirmPlanBatchRunSubmission"),
  );
  assert.match(record, /localCommit/);
  assert.match(record, /githubCommit/);
  assert.match(record, /simple_cluster\/runs\/git_provenance/);
  assert.match(record, /await atomicWriteText\(targetPath, `\$\{JSON\.stringify\(provenance, null, 2\)\}\\n`\)/);
  assert.doesNotMatch(record, /child_process|execFile|spawn/);
});

test("workflow blockers distinguish stale local submissions from active plan runs", () => {
  assert.match(extensionSource, /code: activeEvidence \? "ACTIVE_PLAN_RUN_EXISTS" : "STALE_LOCAL_RUN_OPERATION"/);
  assert.match(extensionSource, /new LocalApiError\(2002,[\s\S]{0,220}\{ blocker \}\)/);
  for (const field of ["operationIds", "checkedServerIds", "evidenceCounts", "recommendedAction"]) {
    assert.match(extensionSource, new RegExp(`${field}:`));
  }
});

test("one-shot workflow can auto prepare only after explicit confirmation", () => {
  assert.match(extensionSource, /params\.autoPrepare === true && infrastructureMissing\.length/);
  assert.match(extensionSource, /code: "AUTO_PREPARE_CONFIRM_REQUIRED"/);
  assert.match(extensionSource, /核对 project\.prepare 预览后，使用 confirm:true 重新调用 workflow\.run。/);
  assert.match(extensionSource, /await this\.apiProjectPrepare\(\{ \.\.\.params, confirm: true \}\)/);
});

test("SimpleExperiment exposes a standard runner with explicit output confirmation in the main panel", () => {
  assert.match(extensionSource, /"workflow\.plan": async \(params\) => this\.apiWorkflowPlan\(params\)/);
  assert.match(extensionSource, /"workflow\.run": async \(params\) => this\.apiWorkflowRun\(params\)/);
  assert.match(extensionSource, /confirmation: "main_panel_if_outputs_exist"/);
  assert.match(extensionSource, /await this\.runActionCommand\("runPlan", route\.calls\[0\]\.params\)/);
  assert.match(extensionSource, /status: "checking_workers"/);
});

test("SimpleExperiment uses manual SFTP addresses and scopes runtime deployment", () => {
  assert.match(extensionSource, /buildSftpServerOptions\(target, this\.sshTransportIdentity\(target\)\)/);
  assert.match(extensionSource, /sshConfigHost: identity\.sshConfigHost/);
  assert.match(extensionSource, /sshConfigAlias: identity\.sshConfigAlias/);
  assert.match(extensionSource, /networkHost: identity\.networkHost/);
  assert.doesNotMatch(extensionSource, /inspectOpenSshAlias\(identity\.sshConfigAlias\)/);
  assert.match(extensionSource, /async deployLatestAgentRuntime\(showMessage = true, pathConfirmed = false, serverIds = \[\], deferVerification = false, migrationOptions: any = \{\}\)/);
  assert.match(extensionSource, /AgentRuntimeScope_1\.selectAgentRuntimeTargets\(this\.agentRuntimeUploadTargets\(\), serverIds\)/);
  const prepareStart = extensionSource.indexOf("async apiProjectPrepare");
  const prepareEnd = extensionSource.indexOf("apiMergedSetupConfig(params = {})", prepareStart);
  const prepareBody = extensionSource.slice(prepareStart, prepareEnd);
  assert.match(prepareBody, /deployLatestAgentRuntime\(false, true, serverIds, true, \{ migrationDigests: params\.legacyMigrationDigests \}\)/);
});

test("SimpleExperiment server test rows always expose the AI contract", () => {
  const row = workflow.serverTestRow({
    id: "nwpu3",
    host: "127.0.0.1",
    port: 22,
    user: "qgking",
    remoteRoot: "/data/qgking/zlk",
  }, undefined);
  assert.deepEqual(Object.keys(row).sort(), [
    "host",
    "message",
    "nextAction",
    "port",
    "remoteRoot",
    "serverId",
    "status",
    "user",
  ]);
  assert.equal(row.status, "unknown");
  assert.equal(row.nextAction, "startAllConnections");
});

test("SimpleExperiment parameterized onboarding uses one structured confirmation gate", () => {
  const methods = [
    "project.prepare",
    "project.bootstrap",
    "project.bootstrap.operation",
    "flow.get",
    "flow.update",
    "server.testAll",
    "plans.filter",
    "plan.validate",
    "workflow.plan",
    "workflow.run",
  ];
  for (const method of methods) {
    assert.match(extensionSource, new RegExp(`"${method.replace(/\./g, "\\.")}": async`), `missing API method ${method}`);
  }
  assert.match(extensionSource, /enabledServers: targets\.filter\(\(target\) => target\.enabled !== false\)/);
  assert.match(extensionSource, /xshellSessions: params\.applyXshell === false \? \[\] : targets\.map/);
  assert.match(extensionSource, /remoteRuntime: params\.deployRuntime === false \? \[\] : targets\.map/);
  assert.match(extensionSource, /preview: \{\s*operation: "startAllConnections",\s*topology/s);
  assert.match(extensionSource, /ports,\s*remoteRoots:/);
  assert.match(extensionSource, /command === "testAll" && params\.uiMode !== true/);
  assert.match(extensionSource, /PLAN_PREFLIGHT_COMMANDS\??\.has\(command\)/);
  assert.match(extensionSource, /API_PARAMETERIZED_CONNECTION_COMMANDS\??\.has\(command\)/);
  assert.match(extensionSource, /if \(command === "prepareAgents"\)/);
  assert.match(extensionSource, /PROJECT_FLOW_STATE_PATH = "simple_cluster\/ui\/flow_state\.json"/);
  // The retired-Hub gate no longer fabricates saved-session identity in prepare; identity stays at the manual boundary.
  assert.match(extensionSource, /HUB_REMOVED/);
  // Mac contract: apiMergedSetupConfig derives the Worker agent project directory
  // from the resolved remote root through the Mac runtime layout (workDir child),
  // instead of copying the raw row paths the Windows baseline stores.
  assert.match(extensionSource, /agentProjectDir: remoteRoot \? this\.agentRuntimeDirs\(remoteRoot\)\.workDir : ""/);

  const start = extensionSource.indexOf("async runApiBootstrapOperation");
  const end = extensionSource.indexOf("async apiProjectBootstrapOperation", start);
  assert.ok(start >= 0 && end > start);
  const bootstrapBody = extensionSource.slice(start, end);
  assert.ok(bootstrapBody.indexOf("await this.apiProjectPrepare") < bootstrapBody.indexOf("const missing = await this.apiPlanValidate"));
});

test("multi-window: per-instance discovery records coexist and workspace routing refuses ambiguity without leaking tokens", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-instances-"));
  const discoveryPath = path.join(dir, "api.json");
  const workspaceA = path.join(dir, "wsA");
  const workspaceB = path.join(dir, "wsB");
  process.env.SIMPLE_EXPERIMENT_MAC_API_FILE = discoveryPath;
  try {
    const client = require("../../dist/cli/LocalApiClient.js");
    const serverA = new LocalApiServer({
      name: "SimpleExperiment", version: "0.5.409-test", preferredPort: await freePort(),
      discoveryPath, workspace: workspaceA, methods: { status: async () => ({ ok: true }) },
    });
    const discA = await serverA.start();
    // startedAt 以毫秒计时：留出间隔避免同进程内两条实例记录身份相同。
    await new Promise((resolve) => setTimeout(resolve, 15));
    const serverB = new LocalApiServer({
      name: "SimpleExperiment", version: "0.5.409-test", preferredPort: await freePort(),
      discoveryPath, workspace: workspaceB, methods: { status: async () => ({ ok: true }) },
    });
    const discB = await serverB.start();
    try {
      const instDir = path.join(dir, "instances");
      const names = fs.readdirSync(instDir).filter((name) => name.endsWith(".json"));
      assert.equal(names.length, 2, "两个窗口各自写入一条实例记录，互不覆盖");

      // 兼容合同：默认 api.json 仍被写入且可解析（last-writer 语义保持）。
      const legacy = JSON.parse(fs.readFileSync(discoveryPath, "utf8"));
      assert.ok(typeof legacy.baseUrl === "string" && typeof legacy.token === "string");

      const listing = client.listPluginInstances("experiment");
      assert.equal(listing.truncated, false);
      const rows = listing.rows;
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.status, "running");
        assert.ok(!("token" in row), "枚举结果不得携带 token");
        const serialized = JSON.stringify(row);
        assert.ok(!serialized.includes(discA.token) && !serialized.includes(discB.token), "序列化行中不得出现任一 token");
      }
      const rowA = rows.find((row) => row.workspace === workspaceA);
      const rowB = rows.find((row) => row.workspace === workspaceB);
      assert.ok(rowA && rowB, "实例记录必须携带各自工作区");
      assert.equal(rowA.instanceId, `${discA.pid}:${discA.startedAt}`);
      assert.equal(rowB.instanceId, `${discB.pid}:${discB.startedAt}`);

      const resolved = await client.resolveInstanceByWorkspace("experiment", workspaceA);
      assert.equal(resolved.instanceId, rowA.instanceId);
      await assert.rejects(() => client.resolveInstanceByWorkspace("experiment", path.join(dir, "wsUnknown")), /未找到.*可达实例/);

      const preflightA = await client.preflightPluginAt("experiment", rowA.discoveryPath, workspaceA);
      assert.equal(preflightA.capabilities.workspace, workspaceA);
      await assert.rejects(() => client.preflightPluginAt("experiment", rowA.discoveryPath, workspaceB), /工作区核对失败/);

      // 崩溃遗留的旧 running 记录（端口无人监听）不得挡住当前唯一有效实例：实际握手后照常路由，记录保留。
      const staleFile = path.join(instDir, "999999_injected.json");
      fs.writeFileSync(staleFile, `${JSON.stringify({
        schemaVersion: 1, name: "SimpleExperiment", version: "0.5.409-test",
        baseUrl: "http://127.0.0.1:19999", host: "127.0.0.1", port: 19999, token: "injected-token-aaaaaaaa",
        pid: 999999, startedAt: "2026-01-01T00:00:00.000Z", instanceId: "999999:2026-01-01T00:00:00.000Z",
        workspace: workspaceA, status: "running",
      })}\n`, "utf8");
      const staleBytes = fs.readFileSync(staleFile);
      const resolvedPastStale = await client.resolveInstanceByWorkspace("experiment", workspaceA);
      assert.equal(resolvedPastStale.instanceId, rowA.instanceId, "旧 running 遗留记录经实际握手被排除，不永久误判双活");
      assert.deepEqual(fs.readFileSync(staleFile), staleBytes, "排除的遗留记录必须原样保留，不自动清理");
      // 已支持 pin 的精确指向也照常工作（pin 先筛后核）。
      const pinned = await client.resolveInstanceByWorkspace("experiment", workspaceA, rowA.instanceId);
      assert.equal(pinned.instanceId, rowA.instanceId);
      await assert.rejects(() => client.resolveInstanceByWorkspace("experiment", workspaceA, "999999:2026-01-01T00:00:00.000Z"), /握手|不可达|存活/);

      // 真双活：同一工作区第二个实际存活实例出现时仍拒绝，不按时间猜测；pin 精确消歧。
      const serverC = new LocalApiServer({
        name: "SimpleExperiment", version: "0.5.409-test", preferredPort: await freePort(),
        discoveryPath, workspace: workspaceA, methods: { status: async () => ({ ok: true }) },
      });
      const discC = await serverC.start();
      try {
        await assert.rejects(() => client.resolveInstanceByWorkspace("experiment", workspaceA), /存活实例.*请用 --instance|实际存在 2 个存活实例/);
        const pinnedC = await client.resolveInstanceByWorkspace("experiment", workspaceA, `${discC.pid}:${discC.startedAt}`);
        assert.equal(pinnedC.instanceId, `${discC.pid}:${discC.startedAt}`, "pin 必须先按精确实例筛选再存活核对");
      } finally {
        await serverC.dispose();
      }

      // 停止只写自身记录：B 的记录逐字节不变。
      const bBytes = fs.readFileSync(rowB.discoveryPath);
      await serverA.dispose();
      const stoppedA = JSON.parse(fs.readFileSync(rowA.discoveryPath, "utf8"));
      assert.equal(stoppedA.status, "stopped");
      assert.deepEqual(fs.readFileSync(rowB.discoveryPath), bBytes, "dispose 不得改写其它窗口的记录");
    } finally {
      await serverA.dispose().catch(() => undefined);
      await serverB.dispose();
    }
  } finally {
    delete process.env.SIMPLE_EXPERIMENT_MAC_API_FILE;
    // FIXTURE POLICY: zero cleanup — retained for audit instead of rmSync (2026-10-23 rework).
    console.log(`[fixtures retained, no cleanup] ${dir}`);
  }
});

test("instance enumeration: over-cap directory is reported truncated, never silently partial", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-instances-trunc-"));
  const discoveryPath = path.join(dir, "api.json");
  process.env.SIMPLE_EXPERIMENT_MAC_API_FILE = discoveryPath;
  try {
    const client = require("../../dist/cli/LocalApiClient.js");
    const instDir = path.join(dir, "instances");
    fs.mkdirSync(instDir, { recursive: true });
    for (let i = 0; i < 257; i++) {
      fs.writeFileSync(path.join(instDir, `${String(i).padStart(4, "0")}_trunc.json`), JSON.stringify({
        schemaVersion: 1, name: "SimpleExperiment", version: "0.5.409-test",
        baseUrl: "http://127.0.0.1:1", host: "127.0.0.1", port: 1, token: "x".repeat(16),
        pid: 1, startedAt: "2026-01-01T00:00:00.000Z", instanceId: `1:2026-01-01T00:00:0${String(i).padStart(1, "0")}.000Z`,
        workspace: path.join(dir, "ws"), status: "stopped",
      }), "utf8");
    }
    const listing = client.listPluginInstances("experiment");
    assert.equal(listing.rows.length, 256);
    assert.equal(listing.truncated, true, "超出 256 条上限必须显式报告未完整枚举，不得静默省略");
    await assert.rejects(() => client.resolveInstanceByWorkspace("experiment", path.join(dir, "ws")), /未完整枚举|枚举上限/);
  } finally {
    delete process.env.SIMPLE_EXPERIMENT_MAC_API_FILE;
    console.log(`[fixtures retained, no cleanup] ${dir}`);
  }
});

test("实例握手预算：候选超过16条整体先拒，绝不部分握手后声称唯一或不存在；显式 discoveryPath 照常", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-instances-budget-"));
  const discoveryPath = path.join(dir, "api.json");
  const workspace = path.join(dir, "ws");
  process.env.SIMPLE_EXPERIMENT_MAC_API_FILE = discoveryPath;
  try {
    const client = require("../../dist/cli/LocalApiClient.js");
    const instDir = path.join(dir, "instances");
    fs.mkdirSync(instDir, { recursive: true });
    for (let i = 0; i < 17; i++) {
      fs.writeFileSync(path.join(instDir, `${String(i).padStart(4, "0")}_budget.json`), JSON.stringify({
        schemaVersion: 1, name: "SimpleExperiment", version: "0.5.409-test",
        baseUrl: "http://127.0.0.1:1", host: "127.0.0.1", port: 1, token: "y".repeat(16),
        pid: 1, startedAt: `2026-01-01T00:00:0${i}.000Z`, instanceId: `1:2026-01-01T00:00:0${i}.000Z`,
        workspace, status: "running",
      }), "utf8");
    }
    const listing = client.listPluginInstances("experiment");
    assert.equal(listing.truncated, false, "17 条不触发 256 枚举上限；这是握手预算层");
    // 候选全部指向不可达端口：若先对前 16 条做半截握手，会把“还有未核验候选”谎报成不存在。
    await assert.rejects(() => client.resolveInstanceByWorkspace("experiment", workspace), /未完整核验|握手预算/);
    // 显式已知 discoveryPath 不受该拒绝影响：真实实例照常握手。
    const server = new LocalApiServer({ name: "SimpleExperiment", version: "0.5.409-test", preferredPort: await freePort(),
      discoveryPath, workspace: path.join(dir, "other-ws"), methods: { status: async () => ({ ok: true }) } });
    await server.start();
    try {
      const rows = client.listPluginInstances("experiment").rows;
      const target = rows.find((row) => row.workspace === path.join(dir, "other-ws"));
      assert.ok(target, "新窗口照常写入实例记录");
      const preflight = await client.preflightPluginAt("experiment", target.discoveryPath, path.join(dir, "other-ws"));
      assert.equal(preflight.instanceId, target.instanceId, "显式 discoveryPath 路由正常");
    } finally {
      await server.dispose();
    }
  } finally {
    delete process.env.SIMPLE_EXPERIMENT_MAC_API_FILE;
    console.log(`[fixtures retained, no cleanup] ${dir}`);
  }
});

test("块C1 分支派发路由：经真实实例握手通道调 plans.list/workflow.plan/workflow.run/operations.list，参数取契约形状、业务拒绝如实复述、传输未知绝不重发", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-branch-dispatch-"));
  const discoveryPath = path.join(dir, "api.json");
  const workspace = path.join(dir, "wsBranch");
  process.env.SIMPLE_EXPERIMENT_MAC_API_FILE = discoveryPath;
  const seen = [];
  let runBehaviour = "started";
  try {
    const branch = require("../../dist/project/BranchPlanDispatch.js");
    const server = new LocalApiServer({
      name: "SimpleExperiment", version: "0.5.409-test", preferredPort: await freePort(), discoveryPath, workspace,
      methods: {
        "plans.list": async () => { seen.push({ method: "plans.list" }); return { plans: [
          { planFile: "plans/a.yaml", planId: "pid-a", updatedAt: "2026-10-25T00:00:00.000Z" },
          { file: "plans/b.yaml" },
          { planFile: "plans/a.yaml", planId: "duplicate-must-be-ignored" },
          null, { planFile: "" },
          { planFile: "plans/c.yaml", planId: "pid-c", metadataTruncated: true }] }; },
        "workflow.plan": async params => { seen.push({ method: "workflow.plan", params });
          if (params.planFile === "plans/validate.yaml") return { ok: false, blocker: { code: "VALIDATION_REQUIRED", recommendedAction: "请先完成 PLAN 校验" } };
          if (params.planFile === "plans/infra.yaml") return { ok: false, blocker: { code: "INFRASTRUCTURE_NOT_READY", recommendedAction: "缺少 conda 环境" } };
          return { ok: true, nextAction: "workflow.run" }; },
        "workflow.run": async params => { seen.push({ method: "workflow.run", params });
          if (runBehaviour === "business") throw new Error("该 PLAN 已有运行中的操作");
          return { ok: true, started: true, operationId: "op-branch-1" }; },
        "operations.list": async () => { seen.push({ method: "operations.list" }); return { records: Array.from({ length: 60 },
          (_unused, index) => ({ operationId: `op-${index}`, type: "workflow-run", state: index ? "running" : "completed", message: "m".repeat(400),
            planFile: "plans/a.yaml", startedAt: "s", finishedAt: "" })) }; },
      },
    });
    const disc = await server.start();
    try {
      const route = await branch.resolveBranchRoute(workspace);
      assert.equal(route.instanceId, `${disc.pid}:${disc.startedAt}`, "路由必须来自 A 块实例握手通道，不是按时间猜记录");
      assert.equal(route.workspace, workspace);
      await assert.rejects(() => branch.resolveBranchRoute(path.join(dir, "wsNone")), /未找到.*可达实例/, "未存活实例的工作区如实拒绝");
      const rpc = branch.branchRpc(route);
      const plans = await branch.listBranchPlans(rpc);
      assert.deepEqual(plans.map(row => row.planFile), ["plans/a.yaml", "plans/b.yaml", "plans/c.yaml"], "planFile 兼容 file 字段、按文件去重、跳过空行");
      assert.deepEqual(plans.map(row => row.planId), ["pid-a", "plans/b.yaml", "pid-c"], "planId 缺失回退文件名");
      assert.equal(plans[2].metadataTruncated, true, "元数据截断必须如实上抛给 UI");
      // 预览：只读形状——参数不得携带 autoPrepare/confirm（绝不代为准备/确认）。
      const okPreview = await branch.previewBranchRun(rpc, workspace, plans[0]);
      assert.equal(okPreview.ready, true);
      assert.deepEqual(seen.at(-1).params, { workspace, planFile: "plans/a.yaml", planId: "pid-a" }, "workflow.plan 参数为已验证契约形状");
      const needValidation = await branch.previewBranchRun(rpc, workspace, { planFile: "plans/validate.yaml", planId: "v", updatedAt: "", metadataTruncated: false });
      assert.equal(needValidation.ready, true, "VALIDATION_REQUIRED 放行提交（run 走 forRun 路径），但必须如实提示校验");
      assert.equal(needValidation.needsValidation, true);
      assert.match(needValidation.guidance, /校验/);
      const blocked = await branch.previewBranchRun(rpc, workspace, { planFile: "plans/infra.yaml", planId: "i", updatedAt: "", metadataTruncated: false });
      assert.equal(blocked.ready, false);
      assert.equal(blocked.guidance, "缺少 conda 环境", "阻断原因原文展示，不粉饰");
      // 提交启动：started 才回执 operationId。
      const started = await branch.submitBranchRun(rpc, workspace, plans[0]);
      assert.equal(started.kind, "started");
      assert.equal(started.operationId, "op-branch-1");
      assert.deepEqual(seen.at(-1).params, { workspace, planFile: "plans/a.yaml", planId: "pid-a", debugMode: false }, "workflow.run 参数为已验证契约形状");
      // 业务拒绝（JSON-RPC 错误带 apiCode）＝确定未启动，可复述原因；每次调用只发一条 run（不自动重发）。
      runBehaviour = "business";
      const before = seen.filter(row => row.method === "workflow.run").length;
      const rejected = await branch.submitBranchRun(rpc, workspace, plans[1]);
      assert.equal(rejected.kind, "notStarted");
      assert.match(rejected.reason, /已有运行中的操作/);
      assert.equal(seen.filter(row => row.method === "workflow.run").length, before + 1, "业务拒绝也只发一次，不重试");
      // 进度：有界映射，message 截断、state 兼容 status。
      const progress = await branch.branchRunProgress(rpc, 8);
      assert.equal(progress.length, 8, "只取有界前若干条");
      assert.equal(progress[0].status, "completed");
      assert.equal(progress[0].message.length, 200);
      assert.equal(progress[1].status, "running", "operations.list 的 state 字段兼容");
      // 传输层失败（实例已停止=连接被拒）＝结果未知：kind=unknown，调用方不得据此重发。
      await server.dispose();
      const lost = await branch.submitBranchRun(rpc, workspace, plans[2]);
      assert.equal(lost.kind, "unknown");
      assert.ok(lost.error.length > 0);
      assert.equal(seen.filter(row => row.method === "workflow.run").length, before + 1, "服务器已停时不可能有第二次提交抵达；unknown 语义即不得自动重发");
    } finally {
      await server.dispose().catch(() => undefined);
    }
  } finally {
    delete process.env.SIMPLE_EXPERIMENT_MAC_API_FILE;
    console.log(`[fixtures retained, no cleanup] ${dir}`);
  }
});
