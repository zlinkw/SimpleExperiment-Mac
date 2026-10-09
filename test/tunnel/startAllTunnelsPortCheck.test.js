const test = require("node:test");
const assert = require("node:assert/strict");

const { allocateTunnelPorts } = require("../../dist/tunnel/TunnelPortAllocator.js");

test("start all tunnel precheck blocks unknown occupied ports but allows existing current tunnels", async () => {
  const request = {
    hub: { id: "hub", host: "hub", requestedLocalPort: 18765, remoteAgentPort: 18765 },
    workers: [
      { id: "w1", host: "w1", requestedLocalPort: 18766, enabled: true },
      { id: "w2", host: "w2", requestedLocalPort: 18767, enabled: true },
    ],
    portRange: { start: 18766, end: 18999 },
    preserveExistingAssignments: true,
  };
  const result = await allocateTunnelPorts(request, (port) => port === 18765 ? "current_tunnel" : port === 18766 ? "unknown_process" : "available");
  assert.ok(result.conflicts.some((item) => item.conflictType === "occupied_by_unknown_process"));
  assert.equal(result.assignments.find((item) => item.endpointId === "hub").localForwardPort, 18765);
});