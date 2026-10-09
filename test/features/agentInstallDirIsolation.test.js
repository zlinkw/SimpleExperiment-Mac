const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension/legacy.ts");

function method(name) {
  const start = new RegExp(`^\\s*${name}\\(`, "m").exec(source)?.index;
  assert.notEqual(start, undefined, `missing ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1).trim().replace(/\s+as\s+any/g, "");
  }
  throw new Error(`unterminated ${name}`);
}

const sandbox = {
  remoteProjectName: () => "demo",
  normalizeRemoteWorkRoot: (root) => String(root || "").replace(/\/+$/, ""),
  AgentTmuxPolicy_1: {
    defaultAgentTmuxSessionName: (role, id) => `${role}-${id || "hub"}`,
    agentTmuxStartupCommand: ({ installDir }) => `INSTALL_DIR=${installDir}`,
  },
  effectiveWorkerCondaEnv: (worker, hubEnv) => worker.condaEnv || hubEnv,
};
vm.createContext(sandbox);
vm.runInContext(`class Subject {
  ${method("agentRuntimeDirs")}
  ${method("agentStartupTargets")}
  ${method("agentRuntimeDeployTargets")}
  projectTopologyAssessment() { return { hubAllowed: false }; }
  enabledWorkerConfigs() { return this.setupConfig.workerTunnels; }
  assertTopologyReady() { return { hubAllowed: false }; }
  workerActualWorkRootTargets() { return this.setupConfig.workerTunnels.map((worker) => ({ id: worker.id, label: worker.id, remotePath: worker.agentProjectDir, agentInstallDir: worker.agentInstallDir })); }
}
this.Subject = Subject;`, sandbox);

test("worker install directories stay isolated from hub and other worker probes", () => {
  const subject = new sandbox.Subject();
  subject.setupConfig = {
    agentProjectDir: "/hub/root",
    agentInstallDir: "/hub/custom_agent",
    workerTunnels: [
      { id: "nwpu2", savedSessionPath: "2.xsh", agentProjectDir: "/data/nwpu2", agentInstallDir: "/data/nwpu2/custom_agent" },
      { id: "nwpu5", savedSessionPath: "5.xsh", agentProjectDir: "/mnt/nwpu5" },
    ],
  };
  subject.lastProbe = { agentInstallDir: "/wrong/hub_probe" };
  subject.lastWorkerProbes = { nwpu2: { agentInstallDir: "/wrong/worker_probe" } };

  const startup = subject.agentStartupTargets();
  assert.match(startup.find((item) => item.id === "nwpu2").command, /INSTALL_DIR=\/data\/nwpu2\/custom_agent/);
  assert.match(startup.find((item) => item.id === "nwpu5").command, /INSTALL_DIR=\/mnt\/nwpu5\/simple_agent/);

  const deploy = subject.agentRuntimeDeployTargets();
  assert.equal(deploy.find((item) => item.id === "nwpu2").remotePath, "/data/nwpu2/custom_agent");
  assert.equal(deploy.find((item) => item.id === "nwpu5").remotePath, "/mnt/nwpu5/simple_agent");
});
