const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function extractMethod(name) {
  const match = new RegExp(`^\\s*(?:private\\s+)?(?:async\\s+)?${name}\\(`, "m").exec(source);
  assert.ok(match, `missing method ${name}`);
  const body = source.indexOf("{", match.index);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1).trim();
  }
  throw new Error(`unterminated method ${name}`);
}

test("Extension Host reuses endpoint assignments and port conflicts by config", () => {
  let assignmentCalls = 0;
  let conflictCalls = 0;
  const sandbox = {
    endpointAssignmentsFromConfig(config) {
      assignmentCalls += 1;
      return [
        { endpointId: "hub", role: "hub_control", localForwardPort: 18765 },
        ...config.workerTunnels.map((worker) => ({ endpointId: worker.id, role: "worker_telemetry", localForwardPort: worker.localForwardPort })),
      ];
    },
    detectStaticTunnelPortConflicts(assignments, range) {
      conflictCalls += 1;
      return assignments.filter((item) => item.localForwardPort < range.start || item.localForwardPort > range.end);
    },
  };
  const methods = ["currentAssignments", "currentPortConflicts"].map(extractMethod).join("\n")
    .replace(/\(0, TunnelEndpointRegistry_1\.endpointAssignmentsFromConfig\)/g, "endpointAssignmentsFromConfig")
    .replace(/\(0, TunnelPortAllocator_1\.detectStaticTunnelPortConflicts\)/g, "detectStaticTunnelPortConflicts");
  vm.createContext(sandbox);
  vm.runInContext(`
    class Subject {
      currentAssignmentsCacheConfig;
      currentAssignmentsCacheHubAllowed;
      currentAssignmentsCacheValue = [];
      currentPortConflictsCacheAssignments;
      currentPortConflictsCacheRangeKey = "";
      currentPortConflictsCacheValue = [];
      enabledWorkerConfigs() { return this.setupConfig.workerTunnels.filter((worker) => worker.enabled !== false); }
      hubAllowed = true;
      projectTopologyAssessment() { return { hubAllowed: this.hubAllowed }; }
      ${methods}
    }
    this.Subject = Subject;
  `, sandbox);

  const subject = new sandbox.Subject();
  subject.setupConfig = {
    workerTunnels: [
      { id: "a", enabled: true, localForwardPort: 18766 },
      { id: "disabled", enabled: false, localForwardPort: 18767 },
    ],
    ports: { workerLocalPortRange: { start: 18000, end: 19000 } },
  };
  const assignments = subject.currentAssignments();
  const conflicts = subject.currentPortConflicts();
  assert.equal(subject.currentAssignments(), assignments);
  assert.equal(subject.currentPortConflicts(), conflicts);
  assert.deepEqual(assignments.map((item) => item.endpointId), ["hub", "a"]);
  assert.equal(assignmentCalls, 1);
  assert.equal(conflictCalls, 1);

  subject.setupConfig.ports.workerLocalPortRange.start = 18766;
  assert.notEqual(subject.currentPortConflicts(), conflicts);
  assert.equal(assignmentCalls, 1);
  assert.equal(conflictCalls, 2);

  subject.hubAllowed = false;
  const workerOnlyAssignments = subject.currentAssignments();
  assert.deepEqual(workerOnlyAssignments.map((item) => item.endpointId), ["a"]);
  assert.equal(assignmentCalls, 2);
  assert.notStrictEqual(workerOnlyAssignments, assignments);

  subject.setupConfig = {
    workerTunnels: [{ id: "b", enabled: true, localForwardPort: 18768 }],
    ports: { workerLocalPortRange: { start: 18000, end: 19000 } },
  };
  assert.notEqual(subject.currentAssignments(), assignments);
  subject.currentPortConflicts();
  assert.equal(assignmentCalls, 3);
  assert.equal(conflictCalls, 3);
});

test("endpoint registry state consumes shared assignment and conflict views", () => {
  const endpointState = extractMethod("endpointRegistryState");
  assert.match(endpointState, /const assignments = this\.currentAssignments\(\)/);
  assert.match(endpointState, /const conflicts = this\.currentPortConflicts\(\)/);
});

test("endpoint registry state reuses stable inputs and invalidates on replacement", () => {
  let registryCalls = 0;
  const sandbox = {
    endpointAssignmentsFromConfig(config) {
      return [
        { endpointId: "hub", role: "hub_control", localForwardPort: config.localForwardPort },
        ...config.workerTunnels.map((worker) => ({ endpointId: worker.id, role: "worker_telemetry", localForwardPort: worker.localForwardPort })),
      ];
    },
    detectStaticTunnelPortConflicts() {
      return [];
    },
    buildTunnelEndpointRegistry(config, probes) {
      registryCalls += 1;
      return { endpoints: [], workers: [], config, probes };
    },
  };
  const methods = ["currentAssignments", "currentPortConflicts", "endpointRegistryState"].map(extractMethod).join("\n")
    .replace(/\(0, TunnelEndpointRegistry_1\.endpointAssignmentsFromConfig\)/g, "endpointAssignmentsFromConfig")
    .replace(/\(0, TunnelPortAllocator_1\.detectStaticTunnelPortConflicts\)/g, "detectStaticTunnelPortConflicts")
    .replace(/\(0, TunnelEndpointRegistry_1\.buildTunnelEndpointRegistry\)/g, "buildTunnelEndpointRegistry");
  vm.createContext(sandbox);
  vm.runInContext(`
    class Subject {
      currentAssignmentsCacheConfig;
      currentAssignmentsCacheHubAllowed;
      currentAssignmentsCacheValue = [];
      currentPortConflictsCacheAssignments;
      currentPortConflictsCacheRangeKey = "";
      currentPortConflictsCacheValue = [];
      endpointRegistryStateCacheConfig;
      endpointRegistryStateCacheHubProbe;
      endpointRegistryStateCacheWorkerProbes;
      endpointRegistryStateCacheAssignments;
      endpointRegistryStateCacheConflicts;
      endpointRegistryStateCachePolicy;
      endpointRegistryStateCacheValue;
      lastProbe;
      lastWorkerProbes = {};
      enabledWorkerConfigs() { return this.setupConfig.workerTunnels.filter((worker) => worker.enabled !== false); }
      projectTopologyAssessment() { return { hubAllowed: true }; }
      ${methods}
    }
    this.Subject = Subject;
  `, sandbox);

  const subject = new sandbox.Subject();
  subject.setupConfig = {
    localForwardPort: 18765,
    workerTunnels: [{ id: "a", enabled: true, localForwardPort: 18766 }],
    ports: { workerLocalPortRange: { start: 18000, end: 19000 } },
    realtime: { pauseWhenHidden: true },
  };
  const first = subject.endpointRegistryState();
  assert.strictEqual(subject.endpointRegistryState(), first);
  assert.equal(registryCalls, 1);

  subject.lastWorkerProbes = { a: { status: "ok" } };
  const workerRefresh = subject.endpointRegistryState();
  assert.notStrictEqual(workerRefresh, first);
  assert.equal(workerRefresh.registry.probes.a.status, "ok");

  subject.lastProbe = { status: "ok" };
  assert.notStrictEqual(subject.endpointRegistryState(), workerRefresh);

  const policyRefresh = subject.endpointRegistryState();
  subject.setupConfig.realtime = { pauseWhenHidden: false };
  assert.notStrictEqual(subject.endpointRegistryState(), policyRefresh);
  assert.equal(registryCalls, 4);
});
