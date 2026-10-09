const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyTunnelHealth } = require("../../dist/tunnel/TunnelHealth.js");

test("tunnel health classifies closed, paused, ok, stale", () => {
  assert.equal(classifyTunnelHealth({ configured: false }).state, "not_configured");
  assert.equal(classifyTunnelHealth({ configured: true, paused: true }).state, "paused");
  assert.equal(classifyTunnelHealth({ configured: true, error: new Error("ECONNREFUSED") }).state, "local_port_closed");
  assert.equal(classifyTunnelHealth({ configured: true, response: { snapshotAge: 10 } }).state, "agent_ok");
  assert.equal(classifyTunnelHealth({ configured: true, response: { snapshotAge: 999 }, staleAfterSeconds: 60 }).state, "stale");
});
