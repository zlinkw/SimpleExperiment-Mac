const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "extension", "legacy.ts"), "utf8");

function methodBody(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing method ${start}`);
  return source.slice(from + start.length, to);
}

test("one enabled Worker is stamped as the Plan target after current owner checks", async () => {
  const body = { planFile: "experiments/plans/current.yaml" };
  const worker = { id: "worker-a", remoteAgentHost: "127.0.0.1", remoteAgentPort: 33441 };
  const target = { id: worker.id, projectDir: "/project" };
  const preamble = methodBody(
    'async selectPlanSubmissionWorker(body, label = "当前 Plan") {',
    "        let gpuSnapshot: any =",
  );
  const compiled = ts.transpileModule(`class Subject { async selectPlanSubmissionWorker(body, label) {${preamble}} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const select = new Function('operationResultPlanFile', 'workspaceRoot', 'ProjectResultTables', 'resolvePlanWorkerAffinity', `${compiled}; return Subject.prototype.selectPlanSubmissionWorker;`)(
    body => body.planFile, () => undefined, require('../../dist/results/ProjectResultTables.js'), require('../../dist/features/PlanWorkerAffinity.js').resolvePlanWorkerAffinity);
  const provider = {
    assertPlanTopologyReady: () => ({ mode: "hub_worker" }),
    enabledWorkerConfigs: () => [worker],
    workerActionTargets: () => [target],
    client: {getResultsSummary: async file => { assert.equal(file, body.planFile); return {availableWorkerIds:[worker.id],results:[]}; }},
    planSchedulerWorkerId: () => '',
    stampWorkerPoolManualTarget: new Function('tunnelHttpOrigin', 'return ({' + require('../_helpers/legacyMethod')(fs.readFileSync(path.join(__dirname, '../../dist/extension/legacy.js'), 'utf8'), 'stampWorkerPoolManualTarget(') + '}).stampWorkerPoolManualTarget;')((host, port) => {assert.equal(host, worker.remoteAgentHost); assert.equal(port, worker.remoteAgentPort); return 'http://' + host + ':' + port;}),
  };
  assert.equal(await select.call(provider, body, "Plan"), worker.id);
  assert.deepEqual(body.selectedWorkerIds, [worker.id]);
  assert.equal(body.options.workerId, worker.id);
  assert.deepEqual(body.options.workers, [{...target, local_agent_url: "http://127.0.0.1:33441", topology_mode: "worker_pool", scheduler_owner_worker_id: worker.id}]);
});

test("tmux reads fall back from a removed Worker, while targeted actions reject it", () => {
  const body = methodBody("tmuxWorkerId(message: any, allowFallback = false): string {", "    tmuxEndpoint(workerId: string): any {");
  const resolve = new Function("message", "allowFallback", body.trim().replace(/}\s*$/, ""));
  const provider = { enabledWorkerConfigs: () => [{ id: "worker-a" }, { id: "worker-b" }] };
  assert.equal(resolve.call(provider, { workerId: "worker-b" }, true), "worker-b");
  assert.equal(resolve.call(provider, { workerId: "removed-worker" }, true), "worker-a");
  assert.throws(() => resolve.call(provider, { workerId: "removed-worker" }, false), /未配置 tmux Worker/);
});

test("tmux responses stay scoped to the selected Worker and show failures", () => {
  const panel = fs.readFileSync(path.join(__dirname, "..", "..", "src", "ui", "PanelHtml.legacy.ts"), "utf8");
  assert.match(source, /this\.tmuxWorkerId\(_message, true\)/);
  assert.match(source, /this\.realtimeEndpoints\(\)\.find\(\(item\) => item\.id === workerId && item\.role === "worker"\)/);
  assert.match(panel, /if \(item\.workerId !== tmuxSelectedWorkerId\) continue;/);
  assert.match(panel, /item\.ok === false \|\| item\.error/);
  assert.doesNotMatch(panel, /zlk-worker-agent \(fallback\)/);
});
