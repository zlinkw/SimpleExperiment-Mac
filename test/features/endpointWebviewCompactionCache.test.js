const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

function extractFunction(name) {
  const start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const body = extension.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadCompactors() {
  const sandbox = {
    endpointRegistryForWebviewCache: new WeakMap(),
    EMPTY_TUNNEL_PORT_ASSIGNMENTS_FOR_WEBVIEW: Object.freeze([]),
    tunnelPortAssignmentsForWebviewCache: new WeakMap(),
    EMPTY_TUNNEL_PORT_CONFLICTS_FOR_WEBVIEW: Object.freeze([]),
    tunnelPortConflictsForWebviewCache: new WeakMap(),
    realtimePolicyForWebviewCache: new WeakMap(),
    sensitiveCalls: 0,
    objectRecord(value) {
      return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    },
    dropUndefined(record) {
      return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
    },
    compactSensitiveText(value, limit) {
      sandbox.sensitiveCalls += 1;
      return String(value || "").slice(0, limit);
    },
    compactStringArrayForWebview(value, limit, itemLimit) {
      return Array.isArray(value) ? value.slice(0, limit).map((item) => String(item || "").slice(0, itemLimit)) : undefined;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("compactEndpointProbeForWebview"),
    extractFunction("compactEndpointForWebview"),
    extractFunction("compactEndpointRegistryForWebview"),
    extractFunction("compactTunnelPortAssignmentsForWebview"),
    extractFunction("compactTunnelPortConflictsForWebview"),
    extractFunction("compactRealtimePolicyForWebview"),
    "this.compactRegistry = compactEndpointRegistryForWebview;",
    "this.compactAssignments = compactTunnelPortAssignmentsForWebview;",
    "this.compactConflicts = compactTunnelPortConflictsForWebview;",
    "this.compactPolicy = compactRealtimePolicyForWebview;",
  ].join("\n"), sandbox);
  return sandbox;
}

function endpoint(id, role, probe) {
  return {
    id,
    role,
    displayName: id.toUpperCase(),
    enabled: true,
    tunnel: { localHost: "127.0.0.1", localPort: 18765, remoteHost: "127.0.0.1", remotePort: 18765 },
    api: { mode: role, expectedCapabilities: ["endpoints.health"] },
    lastProbe: probe,
  };
}

test("endpoint Webview compactors reuse stable snapshot objects", () => {
  const sandbox = loadCompactors();
  const hub = endpoint("hub", "hub_control", { status: "ok", message: "ready" });
  const worker = endpoint("worker-a", "worker_telemetry", { status: "ok" });
  const registry = { endpoints: [hub, worker], hub, workers: [worker] };
  const assignments = [{ endpointId: "hub", role: "hub_control", displayName: "Hub", localForwardPort: 18765, remoteServicePort: 18765 }];
  const conflicts = [{ endpointId: "worker-a", requestedPort: 18765, conflictType: "duplicate", severity: "error", message: "duplicate", suggestion: "change port" }];
  const policy = { hubPollSeconds: 60, workerPollSeconds: 60, workerStatusTtlSeconds: 180, uiBatchMs: 100 };

  const compactedRegistry = sandbox.compactRegistry(registry);
  const compactedAssignments = sandbox.compactAssignments(assignments);
  const compactedConflicts = sandbox.compactConflicts(conflicts);
  const compactedPolicy = sandbox.compactPolicy(policy);
  const sensitiveCalls = sandbox.sensitiveCalls;

  assert.strictEqual(sandbox.compactRegistry(registry), compactedRegistry);
  assert.strictEqual(sandbox.compactAssignments(assignments), compactedAssignments);
  assert.strictEqual(sandbox.compactConflicts(conflicts), compactedConflicts);
  assert.strictEqual(sandbox.compactPolicy(policy), compactedPolicy);
  assert.equal(sandbox.sensitiveCalls, sensitiveCalls);
  assert.equal(compactedRegistry.endpointCount, 2);
  assert.equal(compactedRegistry.workerCount, 1);
  assert.equal(compactedAssignments[0].localForwardPort, 18765);
  assert.equal(compactedConflicts[0].conflictType, "duplicate");
  assert.equal(compactedPolicy.uiBatchMs, 100);
});

test("endpoint Webview compactors invalidate on source replacement", () => {
  const sandbox = loadCompactors();
  const hub = endpoint("hub", "hub_control");
  const registry = { endpoints: [hub], hub, workers: [] };
  const assignments = [{ endpointId: "hub" }];
  const conflicts = [{ endpointId: "hub", message: "one" }];
  const policy = { hubPollSeconds: 60 };

  assert.notStrictEqual(sandbox.compactRegistry({ ...registry }), sandbox.compactRegistry(registry));
  assert.notStrictEqual(sandbox.compactAssignments([...assignments]), sandbox.compactAssignments(assignments));
  assert.notStrictEqual(sandbox.compactConflicts([...conflicts]), sandbox.compactConflicts(conflicts));
  assert.notStrictEqual(sandbox.compactPolicy({ ...policy }), sandbox.compactPolicy(policy));
});

test("endpoint Webview compactors preserve limits and shared empty arrays", () => {
  const sandbox = loadCompactors();
  const assignments = Array.from({ length: 245 }, (_, index) => ({ endpointId: `worker-${index}` }));
  const conflicts = Array.from({ length: 125 }, (_, index) => ({ endpointId: `worker-${index}`, message: `conflict-${index}` }));

  assert.equal(sandbox.compactAssignments(assignments).length, 240);
  assert.equal(sandbox.compactConflicts(conflicts).length, 120);
  assert.strictEqual(sandbox.compactAssignments(undefined), sandbox.EMPTY_TUNNEL_PORT_ASSIGNMENTS_FOR_WEBVIEW);
  assert.strictEqual(sandbox.compactAssignments(null), sandbox.EMPTY_TUNNEL_PORT_ASSIGNMENTS_FOR_WEBVIEW);
  assert.strictEqual(sandbox.compactConflicts(undefined), sandbox.EMPTY_TUNNEL_PORT_CONFLICTS_FOR_WEBVIEW);
  assert.strictEqual(sandbox.compactConflicts(null), sandbox.EMPTY_TUNNEL_PORT_CONFLICTS_FOR_WEBVIEW);
});
