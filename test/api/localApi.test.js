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
      env: { ...process.env, ...extraEnv },
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
      fs.rmSync(dir, { recursive: true, force: true });
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
    process.env.SIMPLE_EXPERIMENT_API_FILE = discoveryPath;
    const { readApiDiscovery } = require("../../dist/cli.js");
    const discovery = readApiDiscovery();
    assert.equal(discovery.port, 19765);
    assert.equal(discovery.token, "test-token");
  } finally {
    delete process.env.SIMPLE_EXPERIMENT_API_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("simpleex CLI forwards the api subcommand", async () => {
  const f = await startServer({ status: async () => ({ ok: true, mode: "cli" }) });
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(root, "dist", "cli.js"), "api", "status"], {
      encoding: "utf8",
      env: { ...process.env, SIMPLE_EXPERIMENT_API_FILE: path.join(f.root, "api.json") },
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.ok, true);
    assert.equal(parsed.result.mode, "cli");
  } finally {
    await f.cleanup();
  }
});

test("simpleex self-check reports missing discovery and listener", async () => {
  const missing = path.join(os.tmpdir(), `simple-experiment-self-check-${process.pid}-${Date.now()}.json`);
  const result = await runCli([path.join(root, "dist", "cli.js"), "self-check"], {
    SIMPLE_EXPERIMENT_API_FILE: missing,
  });
  assert.equal(result.code, 1, result.stderr || "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "missing");
  assert.ok(parsed.checks.some((item) => item.name === "discovery" && !item.ok && item.detail.includes("missing discovery")));
  assert.ok(parsed.checks.some((item) => item.name === "listener" && !item.ok && item.detail.includes("missing listener")));
});

test("simpleex self-check passes with live listener", async () => {
  const f = await startServer({ status: async () => ({ ok: true }) });
  try {
    const result = await runCli([path.join(root, "dist", "cli.js"), "self-check"], {
      SIMPLE_EXPERIMENT_API_FILE: path.join(f.root, "api.json"),
    });
    assert.equal(result.code, 0, result.stderr || "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.checks.every((item) => item.ok));
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
  assert.equal(topologyMode.normalizeTopologyMode("standalone"), "single_worker");
  assert.equal(topologyMode.normalizeTopologyMode("worker_only"), "worker_pool");
  assert.equal(topologyMode.normalizeTopologyMode("hub_available"), "hub_worker");
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
  assert.match(targetBody, /resolveApiRemoteRootWithPolicy\(hub\.remotePath/);
  assert.match(targetBody, /resolveApiRemoteRootWithPolicy\(target\.remotePath, worker/);
  assert.match(targetBody, /workDir: this\.agentRuntimeDirs\(remoteRoot\)\.workDir \|\| ""/);

  const mergedStart = extensionSource.indexOf("apiMergedWorkerConfigs(workerTunnels, setup = this.setupConfig)");
  const mergedEnd = extensionSource.indexOf("apiPublicTopology(topology)", mergedStart);
  const mergedBody = extensionSource.slice(mergedStart, mergedEnd);
  assert.match(mergedBody, /agentProjectDir: worker\.agentProjectDir \|\| worker\.remoteRoot \|\| existing\.agentProjectDir/);
});

test("SimpleExperiment blocks unconfigured placeholder conda environments before workflow submission", () => {
  assert.match(extensionSource, /assertExecutionCondaEnvReady\(this\.workerActionTargets\(\)\)/);
  assert.match(extensionSource, /condaEnv: normalizeCondaEnvSetting\(row\.condaEnv \?\? existing\?\.condaEnv\) \|\| undefined/);
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

test("SimpleExperiment exposes a modal-confirmed standard experiment runner", () => {
  assert.match(extensionSource, /"workflow\.plan": async \(params\) => this\.apiWorkflowPlan\(params\)/);
  assert.match(extensionSource, /"workflow\.run": async \(params\) => this\.apiWorkflowRun\(params\)/);
  assert.match(extensionSource, /confirmation: "vscode_modal"/);
  assert.match(extensionSource, /await this\.runActionCommand\("runPlan", route\.calls\[0\]\.params\)/);
  assert.match(extensionSource, /status: "waiting_confirmation"/);
});

test("SimpleExperiment uses manual SFTP addresses and scopes runtime deployment", () => {
  assert.match(extensionSource, /buildSftpServerOptions\(target, this\.sshTransportIdentity\(target\)\)/);
  assert.match(extensionSource, /sshConfigHost: identity\.sshConfigHost/);
  assert.match(extensionSource, /sshConfigAlias: identity\.sshConfigAlias/);
  assert.match(extensionSource, /networkHost: identity\.networkHost/);
  assert.doesNotMatch(extensionSource, /inspectOpenSshAlias\(identity\.sshConfigAlias\)/);
  assert.match(extensionSource, /async deployLatestAgentRuntime\(showMessage = true, pathConfirmed = false, serverIds = \[\], deferVerification = false\)/);
  assert.match(extensionSource, /AgentRuntimeScope_1\.selectAgentRuntimeTargets\(this\.agentRuntimeUploadTargets\(\), serverIds\)/);
  const prepareStart = extensionSource.indexOf("async apiProjectPrepare");
  const prepareEnd = extensionSource.indexOf("apiMergedSetupConfig(params = {})", prepareStart);
  const prepareBody = extensionSource.slice(prepareStart, prepareEnd);
  assert.match(prepareBody, /deployLatestAgentRuntime\(false, true, serverIds\)/);
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
  assert.match(extensionSource, /savedSessionPath: "",\s*agentProjectDir: "",/);

  const start = extensionSource.indexOf("async runApiBootstrapOperation");
  const end = extensionSource.indexOf("async apiProjectBootstrapOperation", start);
  assert.ok(start >= 0 && end > start);
  const bootstrapBody = extensionSource.slice(start, end);
  assert.ok(bootstrapBody.indexOf("await this.apiProjectPrepare") < bootstrapBody.indexOf("const missing = await this.apiPlanValidate"));
});
