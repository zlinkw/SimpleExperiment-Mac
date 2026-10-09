const test = require("node:test");
const assert = require("node:assert/strict");

const { CLUSTER_AGENT_RUNTIME } = require("../../dist/clusterAgentRuntime.js");

test("hub agent realtime gateway exposes event, log, file, and action APIs", () => {
  for (const route of [
    "/api/events/sse",
    "/api/logs/tail",
    "/api/logs/stream",
    "/api/files/list",
    "/api/files/stat",
    "/api/files/download",
    "/api/files/download-range",
    "/api/files/upload-init",
    "/api/files/upload-chunk",
    "/api/files/upload-complete",
    "/api/files/transfer-status",
    "/api/actions/rescan-results",
  ]) {
    assert.match(CLUSTER_AGENT_RUNTIME, new RegExp(route.replace(/[/-]/g, (ch) => `\\${ch}`)));
  }
  assert.match(CLUSTER_AGENT_RUNTIME, /--mode/);
  assert.match(CLUSTER_AGENT_RUNTIME, /safe_project_path/);
  assert.doesNotMatch(CLUSTER_AGENT_RUNTIME, /ControlMaster|ControlPath/);
});