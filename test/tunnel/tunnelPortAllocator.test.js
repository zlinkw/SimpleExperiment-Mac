const test = require("node:test");
const assert = require("node:assert/strict");

const { allocateTunnelPorts } = require("../../dist/tunnel/TunnelPortAllocator.js");

test("all enabled tunnel endpoints have unique local ports", async () => {
  const result = await allocateTunnelPorts({
    hub: { id: "hub", host: "hub", requestedLocalPort: 18765, remoteAgentPort: 18765 },
    workers: [
      { id: "w1", host: "w1", requestedLocalPort: 18766, enabled: true },
      { id: "w2", host: "w2", requestedLocalPort: 18766, enabled: true },
      { id: "w3", host: "w3", requestedLocalPort: 18765, enabled: true },
    ],
    portRange: { start: 18766, end: 18770 },
    preserveExistingAssignments: false,
  });
  const ports = result.assignments.map((item) => item.localForwardPort);
  assert.equal(new Set(ports).size, ports.length);
  assert.equal(result.assignments.find((item) => item.endpointId === "hub").localForwardPort, 18765);
  assert.ok(result.conflicts.some((item) => item.conflictType === "duplicate_in_config"));
  assert.equal(result.conflicts.some((item) => item.conflictType === "reserved_for_hub"), false);
  assert.ok(result.conflicts.every((item) => item.suggestion));
});

test("allocator skips ports occupied by unknown processes", async () => {
  const result = await allocateTunnelPorts({
    hub: { id: "hub", host: "hub", requestedLocalPort: 18765, remoteAgentPort: 18765 },
    workers: [{ id: "w1", host: "w1", requestedLocalPort: 18766, enabled: true }],
    portRange: { start: 18766, end: 18770 },
    preserveExistingAssignments: false,
  }, (port) => port === 18766 ? "unknown_process" : "available");
  assert.equal(result.assignments.find((item) => item.endpointId === "w1").localForwardPort, 18767);
  assert.ok(result.conflicts.some((item) => item.conflictType === "occupied_by_unknown_process"));
});