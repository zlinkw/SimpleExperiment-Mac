const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { probeLocalTunnel, probeWorkerTelemetryTunnel } = require("../../dist/tunnel/XshellTunnelPortProbe.js");

test("xshell port probe detects ok health capabilities and file api", async () => {
  const schedulerDependencies = { ok: false, missingModules: [{ module: "yaml", package: "PyYAML" }], installCommand: "python -m pip install PyYAML" };
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") return res.end(JSON.stringify({ schemaVersion: 1, agentVersion: "0.2.0", apiVersion: "1", mode: "realtime", startedAt: "x", serverTime: "x", uptimeSeconds: 1, projectRoot: "p", schedulerDependencies, status: "ok" }));
    if (req.url === "/api/capabilities") return res.end(JSON.stringify({ schemaVersion: 1, apiVersion: "1", agentVersion: "0.2.0", endpoints: { health: true, snapshot: true, websocketEvents: true, sseEvents: true, logsTail: true, fileList: true, fileDownload: true, fileRangeDownload: true, fileUploadChunk: true, fileTransferStatus: true, actions: true }, limits: { maxUploadChunkBytes: 1024, maxConcurrentTransfers: 1 }, auth: { required: false, scheme: "none" } }));
    if (req.url === "/api/files/capabilities") return res.end(JSON.stringify({ schemaVersion: 1, rootPolicy: "project_root_only", supportsList: true, supportsStat: true, supportsDownload: true, supportsRangeDownload: true, supportsUploadChunk: true, supportsSha256: true, supportsResume: true, maxUploadChunkBytes: 1024, safeRoots: ["simple_cluster"] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await listen(server);
  try {
    const result = await probeLocalTunnel({ localForwardPort: server.address().port, remoteAgentPort: 18765, realtimeEnabled: true, fileTransferEnabled: true });
    assert.equal(result.status, "ok");
    assert.equal(result.healthOk, true);
    assert.equal(result.fileApiOk, true);
    assert.equal(result.projectRoot, "p");
    assert.deepEqual(result.schedulerDependencies, schedulerDependencies);
  } finally {
    server.close();
  }
});

test("xshell port probe reports local port closed", async () => {
  const result = await probeLocalTunnel({ localForwardPort: 9, remoteAgentPort: 18765, realtimeEnabled: true, fileTransferEnabled: true }, { timeoutMs: 200 });
  assert.equal(result.status, "local_port_closed");
  assert.match(result.message, /未打开|closed/);
});

test("worker telemetry port probe accepts an Agent with install-rich and SSE", async () => {
  const schedulerDependencies = { ok: true, missingModules: [] };
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") return res.end(JSON.stringify({ schemaVersion: 1, agentVersion: "0.2.0", apiVersion: "1", mode: "worker_telemetry", startedAt: "x", serverTime: "x", uptimeSeconds: 1, projectRoot: "p", schedulerDependencies, status: "ok" }));
    if (req.url === "/api/capabilities") return res.end(JSON.stringify({
      schemaVersion: 1,
      apiVersion: "1",
      agentVersion: "0.2.0",
      mode: "worker_telemetry",
      endpoints: { health: true, capabilities: true, gpu: true, workerTasks: true, liveOutput: true, diagnostics: true, websocketEvents: false, sseEvents: true, actions: true, fileList: false, fileDownload: true, fileUploadChunk: false },
      actionEndpoints: { "start-worker-task": true, "install-rich": true },
    }));
    res.statusCode = 404;
    res.end("{}");
  });
  await listen(server);
  try {
    const result = await probeWorkerTelemetryTunnel({ localForwardPort: server.address().port, remoteAgentPort: 18765 }, { timeoutMs: 500 });
    assert.equal(result.status, "ok");
    assert.equal(result.capabilitiesOk, true);
    assert.equal(result.gpuApiOk, true);
    assert.equal(result.workerTasksApiOk, true);
    assert.equal(result.projectRoot, "p");
    assert.deepEqual(result.schedulerDependencies, schedulerDependencies);
  } finally {
    server.close();
  }
});

test("a startup dependency check is polled only while pending and completes inside the probe budget", async () => {
  let reads = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Connection", "close");
    if (req.url === "/api/health") return res.end(JSON.stringify({ schemaVersion: 1, projectRoot: "p", status: "ok",
      schedulerDependencies: ++reads === 1 ? { ok: null, pending: true } : { ok: true } }));
    if (req.url === "/api/capabilities") return res.end(JSON.stringify(productionWorkerTelemetryCapabilities()));
    res.writeHead(404); res.end("{}");
  });
  await listen(server);
  try {
    const result = await probeWorkerTelemetryTunnel({ localForwardPort: server.address().port, remoteAgentPort: 19001 }, { timeoutMs: 1000 });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.schedulerDependencies, { ok: true });
    assert.equal(reads, 2);
    await probeWorkerTelemetryTunnel({ localForwardPort: server.address().port, remoteAgentPort: 19001 }, { timeoutMs: 1000 });
    assert.equal(reads, 3, "already-ready checks must not sleep or retry");
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("worker telemetry port probe explains stale hub-mode agent", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") return res.end(JSON.stringify({ schemaVersion: 1, agentVersion: "0.2.0", apiVersion: "1", mode: "realtime", startedAt: "x", serverTime: "x", uptimeSeconds: 1, projectRoot: "p", status: "ok" }));
    if (req.url === "/api/capabilities") return res.end(JSON.stringify({
      schemaVersion: 1,
      apiVersion: "1",
      agentVersion: "0.2.0",
      mode: "hub_control",
      endpoints: { health: true, snapshot: true, websocketEvents: false, sseEvents: true, logsTail: true, fileList: true, fileDownload: true, fileRangeDownload: true, fileUploadChunk: true, fileTransferStatus: true, actions: true },
      limits: { maxUploadChunkBytes: 1024, maxConcurrentTransfers: 1 },
      auth: { required: false, scheme: "none" },
    }));
    res.statusCode = 404;
    res.end("{}");
  });
  await listen(server);
  try {
    const result = await probeWorkerTelemetryTunnel({ localForwardPort: server.address().port, remoteAgentPort: 18765 }, { timeoutMs: 500 });
    assert.equal(result.status, "worker_api_invalid");
    assert.match(result.suggestion, /hub_control Agent/);
    assert.match(result.suggestion, /重新写入 Agent 自动启动命令/);
  } finally {
    server.close();
  }
});

test("worker telemetry production probe accepts the live worker capability sample", async () => {
  const capabilities = productionWorkerTelemetryCapabilities();
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") return res.end(JSON.stringify({ schemaVersion: 1, agentVersion: "0.5.156", apiVersion: "1", mode: "worker_telemetry", projectRoot: "/data/project", status: "ok" }));
    if (req.url === "/api/capabilities") return res.end(JSON.stringify(capabilities));
    res.statusCode = 404;
    res.end("{}");
  });
  await listen(server);
  try {
    const result = await probeWorkerTelemetryTunnel({ localForwardPort: server.address().port, remoteAgentPort: 19001 }, { timeoutMs: 500 });
    assert.equal(result.status, "ok");
    assert.equal(result.capabilitiesOk, true);
    assert.equal(result.capabilities.actionEndpoints["stop-worker-task-exact-pane"], true);
    assert.equal(result.capabilities.endpoints.fileDownload, true);
    assert.equal(result.capabilities.endpoints.fileList, false);
    assert.equal(result.capabilities.endpoints.fileUploadChunk, false);
    assert.deepEqual(result.warnings, []);
  } finally {
    server.close();
  }
});

test("worker telemetry production probe rejects unknown control and file writes", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") return res.end(JSON.stringify({ schemaVersion: 1, mode: "worker_telemetry", projectRoot: "p", status: "ok" }));
    if (req.url === "/api/capabilities") return res.end(JSON.stringify({
      schemaVersion: 1,
      apiVersion: "1",
      agentVersion: "0.5.156",
      mode: "worker_telemetry",
      endpoints: { health: true, capabilities: true, gpu: true, workerTasks: true, diagnostics: true, sseEvents: true, actions: true, fileList: true, fileDownload: true, fileUploadChunk: true, fileUploadInit: true },
      actionEndpoints: { "stop-worker-task-exact-pane": true, "deploy-runtime": true },
    }));
    res.statusCode = 404;
    res.end("{}");
  });
  await listen(server);
  try {
    const result = await probeWorkerTelemetryTunnel({ localForwardPort: server.address().port, remoteAgentPort: 19002 }, { timeoutMs: 500 });
    assert.equal(result.status, "worker_api_invalid");
    assert.match(result.suggestion, /不允许的控制动作：deploy-runtime/);
    assert.match(result.suggestion, /不允许的文件写入或列表端点：fileList、fileUploadChunk、fileUploadInit/);
    assert.equal(/允许只读文件下载/.test(result.suggestion), false);
    assert.ok(result.warnings.includes("Worker Telemetry 暴露了不允许的控制动作：deploy-runtime"));
    assert.ok(result.warnings.includes("Worker Telemetry 暴露了不允许的文件写入或列表端点：fileList、fileUploadChunk、fileUploadInit。"));
  } finally {
    server.close();
  }
});

test("worker telemetry production probe still separates token and closed port failures", async () => {
  const closed = await probeWorkerTelemetryTunnel({ localForwardPort: 9, remoteAgentPort: 19003 }, { timeoutMs: 200 });
  assert.equal(closed.status, "local_port_closed");
  const server = http.createServer((req, res) => {
    res.statusCode = 401;
    res.end("{}");
  });
  await listen(server);
  try {
    const denied = await probeWorkerTelemetryTunnel({ localForwardPort: server.address().port, remoteAgentPort: 19004, token: "secret" }, { timeoutMs: 500 });
    assert.equal(denied.status, "agent_token_invalid");
  } finally {
    server.close();
  }
});

test("prepare agent health loop finishes when the worker probe recovers", async () => {
  const { tunnelTestCompletion, sleep } = loadPrepareAgentHelpers();
  let probes = { NWPU3: { status: "worker_api_invalid", suggestion: "不允许的控制动作：stop-worker-task-exact-pane" } };
  const setup = { workerTunnels: [{ id: "NWPU3", displayName: "NWPU3", enabled: true }] };
  const deadline = Date.now() + 2000;
  let polls = 0;
  let completion = tunnelTestCompletion(setup, { status: "ok" }, {}, probes, false);
  while (Date.now() < deadline) {
    polls += 1;
    if (polls === 2) probes = { NWPU3: { status: "ok", capabilities: { actionEndpoints: { "stop-worker-task-exact-pane": true }, endpoints: { fileDownload: true } } } };
    completion = tunnelTestCompletion(setup, { status: "ok" }, {}, probes, false);
    if (completion.ready) break;
    if (Date.now() + 20 >= deadline) break;
    await sleep(20);
  }
  assert.equal(completion.ready, true);
  assert.ok(polls < 60);
  assert.equal(completion.issues.length, 0);
});

function productionWorkerTelemetryCapabilities() {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../../src/clusterAgentRuntime.legacy.ts"), "utf8");
  const fn = source.indexOf("def api_capabilities(");
  const branch = source.indexOf('if mode == "worker_telemetry":', fn);
  const actionsAt = source.indexOf('"actionEndpoints": {', branch);
  const endpointsAt = source.indexOf('"endpoints": {', branch);
  const endpointsBlock = source.slice(endpointsAt, actionsAt);
  const actionsEnd = source.indexOf("},", actionsAt);
  const names = (constant) => {
    const marker = `${constant} = `;
    const at = source.indexOf(marker);
    assert.ok(at >= 0, constant);
    const brace = source.indexOf("{", at);
    let depth = 0;
    for (let index = brace; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          return [...source.slice(brace, index + 1).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
        }
      }
    }
    throw new Error(`unterminated ${constant}`);
  };
  const quoted = (block, key) => [...block.matchAll(new RegExp(`"${key}":\\s*(True|False)`, "g"))].map((match) => [key, match[1] === "True"]);
  const endpoints = Object.fromEntries(["health", "capabilities", "gpu", "workerTasks", "liveOutput", "diagnostics", "resultsSummary", "websocketEvents", "sseEvents", "actions", "fileList", "fileDownload", "fileUploadChunk"].flatMap((key) => quoted(endpointsBlock, key)));
  const actionEndpoints = Object.fromEntries([...source.slice(actionsAt, actionsEnd).matchAll(/"([a-z0-9-]+)":\s*True/g)].map((match) => [match[1], true]));
  for (const name of [...names("WORKER_RESULT_ACTIONS"), ...names("WORKER_TENSORBOARD_ACTIONS"), ...names("WORKER_ENV_ACTIONS")]) actionEndpoints[name] = true;
  return {
    schemaVersion: 1,
    apiVersion: "1",
    agentVersion: "0.5.156",
    mode: "worker_telemetry",
    endpoints,
    actionEndpoints,
  };
}

function loadPrepareAgentHelpers() {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
  const start = source.indexOf("function tunnelTestCompletion(");
  const end = source.indexOf("function initialServerSetupComplete(");
  assert.ok(start >= 0 && end > start);
  const sandbox = { HUB_READY_STATUSES: new Set(["ok", "agent_ok", "degraded"]), setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end)}\nthis.tunnelTestCompletion = tunnelTestCompletion;\nthis.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));`, sandbox);
  return sandbox;
}

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
