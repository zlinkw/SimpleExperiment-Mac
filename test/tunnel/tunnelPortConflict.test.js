const test = require("node:test");
const assert = require("node:assert/strict");

const { detectStaticTunnelPortConflicts } = require("../../dist/tunnel/TunnelPortAllocator.js");

test("static detector rejects invalid/duplicate Worker ports without reserving old Hub ports", () => {
  const conflicts = detectStaticTunnelPortConflicts([
    { endpointId: "hub", role: "hub_control", localForwardHost: "127.0.0.1", localForwardPort: 18765, remoteBindHost: "127.0.0.1", remoteServicePort: 18765, remoteHostLabel: "hub", assignedAt: "t", source: "manual" },
    { endpointId: "w1", role: "worker_telemetry", localForwardHost: "127.0.0.1", localForwardPort: 18765, remoteBindHost: "127.0.0.1", remoteServicePort: 18765, remoteHostLabel: "w1", assignedAt: "t", source: "manual" },
    { endpointId: "w2", role: "worker_telemetry", localForwardHost: "127.0.0.1", localForwardPort: 19000, remoteBindHost: "127.0.0.1", remoteServicePort: 18765, remoteHostLabel: "w2", assignedAt: "t", source: "manual" },
    { endpointId:"w3",role:"worker_telemetry",localForwardPort:18765 },
    { endpointId:"invalid",role:"worker_telemetry",localForwardPort:22 },
  ], { start: 18766, end: 18999 });
  assert.ok(conflicts.some((item) => item.conflictType === "duplicate_in_config"));
  assert.equal(conflicts.some(item=>item.conflictType==="reserved_for_hub"),false);
  assert.ok(conflicts.some(item=>item.conflictType==="invalid_port"));
  assert.ok(conflicts.every(item=>item.endpointId!=="hub"));
  assert.equal(conflicts.some(item=>item.conflictType==="outside_allowed_range"),false,"configured valid ports are not restricted to an allocation hint");
});

test("worker-only topology allows one local 18765 while remote service ports match", () => {
  const conflicts = detectStaticTunnelPortConflicts([
    { endpointId: "w1", role: "worker_telemetry", localForwardHost: "127.0.0.1", localForwardPort: 18765, remoteBindHost: "127.0.0.1", remoteServicePort: 18765, remoteHostLabel: "w1", assignedAt: "t", source: "manual" },
    { endpointId: "w2", role: "worker_telemetry", localForwardHost: "127.0.0.1", localForwardPort: 18766, remoteBindHost: "127.0.0.1", remoteServicePort: 18765, remoteHostLabel: "w2", assignedAt: "t", source: "manual" },
  ], { start: 18766, end: 18999 });
  assert.deepEqual(conflicts, []);
});
