const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const childProcess = require("node:child_process");

const { RequestBudget, defaultRequestBudgetConfig } = require("../../dist/tunnel/RequestBudget.js");
const { RealtimeTunnelClient, defaultRealtimeRefreshPolicy } = require("../../dist/tunnel/RealtimeTunnelClient.js");

test("realtime tunnel mode never invokes ssh/scp/rsync", async () => {
  const commands = [];
  const oldSpawn = childProcess.spawn;
  const oldExec = childProcess.exec;
  childProcess.spawn = (cmd, ...args) => { commands.push(cmd); return oldSpawn(cmd, ...args); };
  childProcess.exec = (cmd, ...args) => { commands.push(String(cmd).split(/\s+/)[0]); return oldExec(cmd, ...args); };
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/snapshot") return res.end(JSON.stringify({ schemaVersion: 1 }));
    if (req.url === "/api/actions/parse-results") return res.end(JSON.stringify({ ok: true }));
    if (req.url.startsWith("/api/files/download")) return res.end("x");
    res.end(JSON.stringify({ ok: true }));
  });
  await listen(server);
  const client = new RealtimeTunnelClient(
    { localHost: "127.0.0.1", localPort: server.address().port },
    new RequestBudget({ ...defaultRequestBudgetConfig, minIntervalByPurpose: {} }),
    { ...defaultRealtimeRefreshPolicy, preferWebSocket: false, fallbackToSse: false, fallbackToPolling: true, snapshotFallbackIntervalSeconds: 60 },
  );
  try {
    await client.connect(0);
    await client.getSnapshot();
    await client.postAction("parse-results", { opId: "op" });
    assert.equal(commands.some((cmd) => ["ssh", "scp", "rsync"].includes(String(cmd).toLowerCase())), false);
  } finally {
    await client.disconnect();
    childProcess.spawn = oldSpawn;
    childProcess.exec = oldExec;
    await closeServer(server);
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
}
