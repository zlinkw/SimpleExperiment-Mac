const test = require("node:test");
const assert = require("node:assert/strict");

const { checkAgentApiCompatibility } = require("../../dist/tunnel/AgentCapabilities.js");

test("api version compatibility reports upgrade when major version or endpoints mismatch", () => {
  const caps = {
    schemaVersion: 1,
    apiVersion: "2",
    agentVersion: "0.1.0",
    endpoints: { health: true, snapshot: true, websocketEvents: false, sseEvents: false, logsTail: true, fileList: false, fileDownload: true, fileRangeDownload: false, fileUploadChunk: false, fileTransferStatus: true, actions: true },
    limits: { maxUploadChunkBytes: 1024, maxConcurrentTransfers: 1 },
    auth: { required: false, scheme: "none" },
  };
  const result = checkAgentApiCompatibility(caps, "1");
  assert.equal(result.compatible, false);
  assert.equal(result.requiredAgentUpgrade, true);
  assert.ok(result.missingEndpoints.includes("fileList"));
  assert.ok(result.unsupportedFeatures.includes("fileRangeDownload"));
});