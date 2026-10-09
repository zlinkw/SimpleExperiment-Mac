const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { XshellIntegration } = require("../../dist/tunnel/XshellTunnelIntegration.js");

test("xshell integration check produces layered report", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simple-real-check-"));
  const exe = path.join(dir, "Xshell.exe");
  await fs.writeFile(exe, "");
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Connection", "close");
    if (req.url === "/api/health") return res.end(JSON.stringify({ schemaVersion: 1, agentVersion: "0.2.0", apiVersion: "1", mode: "realtime", startedAt: "x", serverTime: "x", uptimeSeconds: 1, projectRoot: "p", status: "ok" }));
    if (req.url === "/api/capabilities") return res.end(JSON.stringify({ schemaVersion: 1, apiVersion: "1", agentVersion: "0.2.0", endpoints: { health: true, snapshot: true, websocketEvents: false, sseEvents: true, logsTail: true, fileList: true, fileDownload: true, fileRangeDownload: true, fileUploadChunk: true, fileTransferStatus: true, actions: true }, limits: { maxUploadChunkBytes: 1024, maxConcurrentTransfers: 1 }, auth: { required: false, scheme: "none" } }));
    if (req.url === "/api/files/capabilities") return res.end(JSON.stringify({ schemaVersion: 1, rootPolicy: "project_root_only", supportsList: true, supportsStat: true, supportsDownload: true, supportsRangeDownload: true, supportsUploadChunk: true, supportsSha256: true, supportsResume: true, maxUploadChunkBytes: 1024, safeRoots: ["simple_cluster"] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await listen(server);
  const config = {
    xshellExePath: exe,
    hubHost: "hub",
    hubUser: "simple",
    hubSshPort: 22,
    localForwardHost: "127.0.0.1",
    localForwardPort: server.address().port,
    remoteAgentHost: "127.0.0.1",
    remoteAgentPort: 18765,
    launchMode: "open_xshell_exec",
    realtimeEnabled: true,
    fileTransferEnabled: true,
    keepWindowVisible: true,
    useNewTab: true,
    autoStartTunnelOnExtensionActivation: false,
    autoTestTunnelAfterStart: true,
  };
  try {
    const result = await new XshellIntegration({ configuredPath: exe }).runIntegrationCheck(config);
    assert.equal(result.executable.found, true);
    assert.equal(result.probe.status, "ok");
    assert.equal(result.report.overall, "ok");
    assert.equal(result.report.fileTransfer.downloadOk, true);
  } finally {
    await closeServer(server);
  }
});

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
}
