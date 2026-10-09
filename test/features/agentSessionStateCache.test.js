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

function loadSubject() {
  const sandbox = {
    AgentTmuxPolicy_1: {
      defaultAgentTmuxSessionName(role, id) { return id ? `${role}-${id}` : role; },
      agentTmuxStartupCommand(options) { return `${options.role}:${options.endpointId || "hub"}:${options.workDir || ""}`; },
    },
    effectiveWorkerCondaEnv(worker, hubEnv) { return worker.condaEnv === undefined ? hubEnv : worker.condaEnv; },
  };
  vm.createContext(sandbox);
  const raw = extractMethod("agentSessionState");
  const cleaned = raw.replace(/\s+as\s+any/g, "").replace(/\s+as\s+unknown/g, "");
  vm.runInContext(`
    class Subject {
      agentSessionStateCacheSetup;
      agentSessionStateCacheSessions;
      agentSessionStateCachePortConflicts;
      agentSessionStateCacheProjectGeneration = -1;
      agentSessionStateCacheTopologyMode = "";
      agentSessionStateCacheValue;
      projectContextGeneration = 1;
      topologyMode = "hub_worker";
      startupCalls = 0;
      blockerCalls = 0;
      portConflicts = [];
      xshellLibrary = { sessions: [] };
      currentPortConflicts() { return this.portConflicts; }
      projectTopologyAssessment() { return { mode: this.topologyMode, hubAllowed: this.topologyMode === "hub_worker" }; }
      agentRuntimeDirs(root) {
        return root ? { workRoot: root, installDir: root + "/simple_agent", workDir: root + "/demo", projectName: "demo" } : { projectName: "demo" };
      }
      agentStartupTargets() { this.startupCalls += 1; return this.setupConfig.savedSessionPath ? [{ id: "hub" }] : []; }
      currentAgentPreparationBlockers() { this.blockerCalls += 1; return this.blockers || []; }
      hubDisplayName() { return this.setupConfig.hubDisplayName || "Hub"; }
      ${cleaned}
    }
    this.Subject = Subject;
  `, sandbox);
  return sandbox.Subject;
}

function setup(workerId = "worker-a") {
  return {
    savedSessionPath: "hub.xsh",
    agentProjectDir: "/srv/projects",
    remoteAgentPort: 18765,
    condaEnv: "research",
    workerTunnels: [{
      id: workerId,
      displayName: workerId,
      enabled: true,
      savedSessionPath: `${workerId}.xsh`,
      agentProjectDir: "/srv/workers",
      remoteTelemetryPort: 18766,
    }],
  };
}

test("Agent session state reuses stable local derivation sources", () => {
  const Subject = loadSubject();
  const subject = new Subject();
  subject.setupConfig = setup();
  const first = subject.agentSessionState();

  assert.strictEqual(subject.agentSessionState(), first);
  assert.equal(subject.startupCalls, 1);
  assert.equal(subject.blockerCalls, 1);
  assert.equal(first.hub.workDir, "/srv/projects/demo");
  assert.equal(first.workers[0].workDir, "/srv/workers/demo");
});

test("Agent session state invalidates configuration, sessions, ports, project, and topology", () => {
  const Subject = loadSubject();
  const subject = new Subject();
  subject.setupConfig = setup();
  const first = subject.agentSessionState();

  subject.xshellLibrary = { sessions: [{ filePath: "hub.xsh" }] };
  const sessions = subject.agentSessionState();
  assert.notStrictEqual(sessions, first);

  subject.portConflicts = [{ endpointId: "hub" }];
  const ports = subject.agentSessionState();
  assert.notStrictEqual(ports, sessions);

  subject.projectContextGeneration += 1;
  const project = subject.agentSessionState();
  assert.notStrictEqual(project, ports);

  subject.topologyMode = "worker_pool";
  const topology = subject.agentSessionState();
  assert.notStrictEqual(topology, project);

  subject.setupConfig = setup("worker-b");
  const configuration = subject.agentSessionState();
  assert.notStrictEqual(configuration, topology);
  assert.equal(configuration.workers[0].id, "worker-b");
});
