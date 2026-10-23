const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "..", "..");
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");

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

test("worker-only server setup does not require Hub session or project root", () => {
  // Mac 适配：就绪判定走 ../platform/Terminal 的 Termius 转发端点（host+user+localForwardPort≥1024+remoteAgentPort），
  // 等价替代 Windows 的 savedSessionPath（Xshell 会话）；Hub 会话/Hub 项目根均不在缺失项，断言强度不变。
  const sandbox = { require: (id) => id === "../platform/Terminal" ? require("../../dist/platform/Terminal.js") : require(id) };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("serverSetupMissingItems")}\nthis.check = serverSetupMissingItems;`, sandbox);
  const missing = sandbox.check({ savedSessionPath: "", agentProjectDir: "", workerTunnels: [{ id: "w1", workerHost: "10.0.0.2", workerUser: "zlk", localForwardPort: 18080, remoteAgentPort: 8080, agentProjectDir: "/srv/project" }] }, false);
  assert.equal(missing.length, 0);
});

test("worker-only bootstrap readiness ignores offline Hub and Hub dependency data", () => {
  const sandbox = { HUB_READY_STATUSES: new Set(["ok", "agent_ok", "file_api_unavailable"]) };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("projectBootstrapEndpointReadiness")}\nthis.check = projectBootstrapEndpointReadiness;`, sandbox);
  const readiness = sandbox.check({
    hubRequired: false,
    hubStatus: "local_port_closed",
    hubSchedulerDependencies: { ok: false, message: "Hub unavailable" },
    workers: [{ label: "Worker A", status: "ok", schedulerDependencies: { ok: true } }],
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.hubRequired, false);
  assert.equal(readiness.missing.length, 0);
});

test("rendered readiness cannot restore a Hub requirement from any old topology",()=>{
  const panelFunction=require('../_helpers/panelFunction');
  const sandbox={EMPTY_WORKER_TUNNELS_FOR_ALIAS:[],enabledWorkerTunnelsCacheSource:null,enabledWorkerTunnelsCacheValue:[],projectEndpointReadinessCacheState:null,projectEndpointReadinessCacheValue:null};
  vm.runInNewContext(panelFunction('enabledWorkerTunnelsForState')+'\n'+panelFunction('projectEndpointReadiness')+'\nthis.check=projectEndpointReadiness;',sandbox);
  for(const mode of ['hub_worker','worker_pool',undefined]) {
    const setup={workerTunnels:[{id:'a',enabled:true}]};
    const ready=sandbox.check({setup,topology:{mode},probe:{status:'offline'},workerProbes:{a:{status:'ok'}}});
    assert.equal(ready.ready,true);assert.equal(ready.hubRequired,false);assert.equal(ready.missing.length,0);
    const blocked=sandbox.check({setup,topology:{mode},probe:{status:'ok'},workerProbes:{a:{status:'offline'}}});
    assert.equal(blocked.ready,false);assert.match(blocked.missing.join(','),/a/);
  }
});
