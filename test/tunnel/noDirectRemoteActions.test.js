const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");
const childProcess = require("node:child_process");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { HttpTunnelClient, tunnelActions } = require("../../dist/tunnel/TunnelClient.js");
const { FileTransferClient } = require("../../dist/tunnel/FileTransferClient.js");

test("Agent actions and file browsing use localhost clients without direct remote processes", async () => {
  const childCommands = [];
  const oldSpawn = childProcess.spawn;
  const oldExec = childProcess.exec;
  childProcess.spawn = (cmd, ...args) => { childCommands.push(String(cmd)); return oldSpawn(cmd, ...args); };
  childProcess.exec = (cmd, ...args) => { childCommands.push(String(cmd).split(/\s+/)[0]); return oldExec(cmd, ...args); };

  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, host: req.socket.localAddress });
    if (req.url.startsWith("/api/files/download")) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", "3");
      return res.end("csv");
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/health") return res.end(JSON.stringify({ state: "agent_ok", checkedAt: new Date().toISOString() }));
    if (req.url === "/api/snapshot") return res.end(JSON.stringify({ schemaVersion: 1 }));
    if (req.url === "/api/gpu") return res.end(JSON.stringify({ schemaVersion: 1, gpu: [] }));
    if (req.url.startsWith("/api/gpu/history")) return res.end(JSON.stringify({ schemaVersion: 1, bucketSeconds: 60, retentionHours: 72, maxPointsPerSeries: 4320, updatedAt: "", series: [] }));
    if (req.url === "/api/scheduler") return res.end(JSON.stringify({ schemaVersion: 1, schedulerStates: [] }));
    if (req.url === "/api/traces") return res.end(JSON.stringify({ schemaVersion: 1, experimentTraces: [] }));
    if (req.url.startsWith("/api/live-output")) return res.end(JSON.stringify({ schemaVersion: 1, text: "" }));
    if (req.url === "/api/diagnostics") return res.end(JSON.stringify({ schemaVersion: 1 }));
    if (req.url === "/api/audit/tail") return res.end(JSON.stringify({ schemaVersion: 1, tail: "" }));
    if (req.url.startsWith("/api/files/list")) return res.end(JSON.stringify({ schemaVersion: 1, path: "results", entries: [] }));
    if (req.url === "/api/files/upload-init") return res.end(JSON.stringify({ schemaVersion: 1, transferId: "upload-1", chunkSize: 1024, accepted: true, resumeFromByte: 0 }));
    if (req.url.startsWith("/api/files/upload-chunk")) return res.end(JSON.stringify({ schemaVersion: 1, transferId: "upload-1", receivedBytes: 3, nextOffset: 3 }));
    if (req.url === "/api/files/upload-complete") return res.end(JSON.stringify({ schemaVersion: 1, transferId: "upload-1", status: "completed", sha256: "" }));
    if (req.url.startsWith("/api/actions/")) return res.end(JSON.stringify({ schemaVersion: 1, opId: "op", accepted: true, operationId: "operation-op" }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  await listen(server);
  const port = server.address().port;
  const budget = new RequestBudget({ ...defaultRequestBudgetConfig, maxRequestsPerMinute: 100, minIntervalByPurpose: {}, disabledPurposes: [] });
  const client = new HttpTunnelClient({ localHost: "127.0.0.1", localPort: port, timeoutMs: 1000 }, budget);
  const files = new FileTransferClient({ localHost: "127.0.0.1", localPort: port, chunkSizeBytes: 1024 }, budget);
  try {
    await client.getHealth({ userInitiated: true });
    await client.getSnapshot({ manual: true });
    await client.getGpu();
    await client.getGpuHistory({ serverId: "worker-a", gpuId: "0" });
    await client.getScheduler();
    await client.getTraces();
    await client.getLiveOutput("simple_cluster/logs/train.log", 0);
    await client.getDiagnostics();
    await client.getAuditTail();
    for (const action of tunnelActions) {
      await client.postAction(action, { opId: "op" });
    }
    await files.list("results/metrics.csv");

    assert.equal(childCommands.some((cmd) => ["ssh", "ssh.exe", "scp", "scp.exe", "rsync", "rsync.exe"].includes(path.basename(cmd).toLowerCase())), false);
    assert.equal(requests.every((item) => item.host === "127.0.0.1"), true);
    assert.equal(requests.some((item) => item.url === "/api/actions/run-plan"), true);
    assert.equal(requests.some((item) => item.url === "/api/actions/delete-artifacts"), true);
    assert.equal(requests.some((item) => item.url.startsWith("/api/files/list")), true);
    assert.equal(requests.some((item) => item.url.startsWith("/api/gpu/history?serverId=worker-a&gpuId=0")), true);
  } finally {
    server.close();
    childProcess.spawn = oldSpawn;
    childProcess.exec = oldExec;
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
