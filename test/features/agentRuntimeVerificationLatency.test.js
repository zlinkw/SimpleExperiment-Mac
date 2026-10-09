const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("runtime verification overlaps Workers without dropping SHA256 or version checks", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const start = source.indexOf("async verifyDeployedAgentRuntime(");
  const end = source.indexOf("async checkRemoteAgentVersionAndNotify(", start);
  assert.ok(start >= 0 && end > start);
  let active = 0, maxActive = 0, mismatch = false;
  const requests = [];
  const sandbox = { AbortController, setTimeout, clearTimeout,
    RuntimeManifest_1: { CURRENT_RUNTIME_VERSION: "v1" },
    tunnelHttpOrigin: (host, port) => `http://${host}:${port}`,
    fetch: async (url) => {
      requests.push(url); active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 10)); active--;
      return { ok: true, json: async () => url.includes("sha256")
        ? { ok: true, sha256: (mismatch && url.includes(':2/') ? 'b' : 'a').repeat(64) }
        : { agentVersion: "v1", runtimeVersion: mismatch && url.includes(':3/') ? 'old' : "v1", pluginVersion: "v1" } };
    } };
  vm.createContext(sandbox);
  vm.runInContext("this.verify = ({" + source.slice(start, end) + "}).verifyDeployedAgentRuntime", sandbox);
  const targets = [1, 2, 3].map(port => ({ label: `worker-${port}`, localForwardHost: "configured.example", localForwardPort: port,
    remotePath: `/srv/agent-${port}/simple_cluster/runtime` }));
  const result = await sandbox.verify.call({ tunnelConfig: {} }, targets,
    { runtimeVersion: "v1", pluginVersion: "v1", files: { "cluster_agent.py": "a".repeat(64), "cluster_scheduler.py": "a".repeat(64) } });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { fatal: [], warnings: [] });
  assert.equal(requests.length, 9);
  assert.ok(maxActive >= 6, `Workers were serialized: maximum ${maxActive} requests`);
  for (const target of targets) assert.equal(requests.filter(url => url.startsWith(`http://configured.example:${target.localForwardPort}/`)).length, 3);
  mismatch = true;
  const failures = await sandbox.verify.call({ tunnelConfig: {} }, targets,
    { runtimeVersion: 'v1', pluginVersion: 'v1', files: { 'cluster_agent.py': 'a'.repeat(64), 'cluster_scheduler.py': 'a'.repeat(64) } });
  assert.ok(failures.fatal.some(message => message.includes('worker-2') && message.includes('sha256')));
  assert.ok([...failures.fatal, ...failures.warnings].some(message => message.includes('worker-3') && message.includes('版本')));
});
