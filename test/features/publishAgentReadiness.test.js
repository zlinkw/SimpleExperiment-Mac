const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const panel = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");

function extractFunction(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const bodyStart = panel.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < panel.length; index += 1) {
    if (panel[index] === "{") depth += 1;
    if (panel[index] === "}") depth -= 1;
    if (depth === 0) return panel.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function readiness(state) {
  const sandbox = {
    HUB_OPERATION_READY_STATUS_TOKENS: new Set(["agent_ok", "ok", "file_api_unavailable"]),
    EMPTY_WORKER_TUNNELS_FOR_ALIAS: [],
    enabledWorkerTunnelsCacheSource: null,
    enabledWorkerTunnelsCacheValue: [],
    projectEndpointReadinessCacheState: null,
    projectEndpointReadinessCacheValue: null,
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("enabledWorkerTunnelsForState"),
    extractFunction("projectEndpointReadiness"),
    extractFunction("publishAgentReadiness"),
    "this.check = publishAgentReadiness;",
  ].join("\n"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.check(state)));
}

test("publish workflow reports actual Hub and Worker Agent readiness", () => {
  const setup = { workerTunnels: [{ id: "w1", displayName: "Worker A", enabled: true }] };
  assert.deepEqual(readiness({ setup, probe: { status: "ok" }, workerProbes: { w1: { status: "ok" } } }), {
    ready: true,
    status: "已就绪",
    detail: "Hub/Worker Agent 可达",
  });
  assert.equal(readiness({ setup, probe: { status: "agent_version_mismatch" }, workerProbes: { w1: { status: "ok" } } }).status, "需升级");
  assert.equal(readiness({ setup, probe: { status: "agent_restart_required" }, workerProbes: { w1: { status: "ok" } } }).status, "待重启");
  assert.equal(readiness({ setup, probe: { status: "ok" }, workerProbes: { w1: { status: "agent_project_mismatch" } } }).status, "项目不匹配");
});

test("publish workflow rerenders on endpoint changes via the settings chain overview", () => {
  // 单链第二步：旧 sync 分发/renderPublishFlow/4步标题已下线，新链为 settings-chain-overview 3按钮
  assert.doesNotMatch(panel, /function renderPublishFlow\(state\)/);
  assert.doesNotMatch(panel, /\{ title: "4\. Agent", ok: agent\.ready, status: agent\.status, detail: agent\.detail,/);
  assert.match(panel, /function renderServerChainOverview\(/);
  assert.match(panel, /data-anchor="settings-chain-overview"/);
  assert.match(panel, /publishAgentReadiness\(data\)/);
  assert.doesNotMatch(panel, /onboardingStep\("4\. 部署 Agent", false, "按需执行"/);
  // 单链第二步：旧 renderActionSections 产物/实验/结果/诊断占位文案已随之下线
  assert.doesNotMatch(panel, /function renderActionSections/);
});
