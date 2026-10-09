const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkAgentApiCompatibility,
  validateAgentCapabilities,
  validateAgentHealth,
  validateFileCapabilities,
} = require("../../dist/tunnel/AgentCapabilities.js");

test("agent capabilities schema and compatibility pass for realtime file gateway", () => {
  const health = { schemaVersion: 1, agentVersion: "0.2.0", apiVersion: "1", mode: "realtime", startedAt: "x", serverTime: "x", uptimeSeconds: 1, projectRoot: "p", status: "ok" };
  const caps = {
    schemaVersion: 1,
    apiVersion: "1",
    agentVersion: "0.2.0",
    endpoints: { health: true, snapshot: true, websocketEvents: false, sseEvents: true, logsTail: true, fileList: true, fileDownload: true, fileRangeDownload: true, fileUploadChunk: true, fileTransferStatus: true, actions: true },
    limits: { maxUploadChunkBytes: 1024, maxConcurrentTransfers: 1 },
    auth: { required: false, scheme: "none" },
  };
  const fileCaps = { schemaVersion: 1, rootPolicy: "project_root_only", supportsList: true, supportsStat: true, supportsDownload: true, supportsRangeDownload: true, supportsUploadChunk: true, supportsSha256: true, supportsResume: true, maxUploadChunkBytes: 1024, safeRoots: ["simple_cluster"] };
  assert.equal(validateAgentHealth(health), true);
  assert.equal(validateAgentCapabilities(caps), true);
  assert.equal(validateFileCapabilities(fileCaps), true);
  assert.equal(checkAgentApiCompatibility(caps).compatible, true);
});