const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require("../_helpers/registerTsRequire");
const { normalizeDistributedProjectContract } = require("../../src/features/DistributedProjectContract.ts");
const queue = require("../../src/features/DistributedPlanQueue.ts");

const source = fs.readFileSync(require.resolve("../../src/extension/legacy.ts"), "utf8");
const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
const members = new Map();
function collect(node) {
  if (ts.isMethodDeclaration(node)) members.set(node.name.getText(ast), node);
  ts.forEachChild(node, collect);
}
collect(ast);
function productionMethod(name) {
  const node = members.get(name);
  assert.ok(node, name);
  const code = ts.transpileModule(`class Subject { ${node.getText(ast)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function("operationResultPlanFile", `${code}; return Subject.prototype.${name};`)(
    body => body.planFile || body.options?.planFile || "",
  );
}
const eligible = productionMethod("distributedPlanEligible");
const primary = productionMethod("selectDistributedPlanPrimary");
const preflightTarget = productionMethod("ensureWorkerPoolPlanTarget");

// Replay the actual submission branch, including its chooser and final routing.
const submission = members.get("runActionCommandCore").body.statements.find(node =>
  ts.isIfStatement(node) && node.expression.getText(ast) === "PLAN_SUBMISSION_COMMANDS.has(command)");
assert.ok(submission);
const routingStatements = submission.thenStatement.statements.filter(node => {
  const text = node.getText(ast);
  return text.startsWith('const distributedPlan =') ||
    ts.isIfStatement(node) && node.expression.getText(ast) === "distributedPlan";
});
assert.equal(routingStatements.length, 3);
const route = new Function("operationResultPlanFile", "assertWorkflowCurrent", "workflowBinding", `return async function(command, body, plan, message) {
  ${routingStatements.map(node => node.getText(ast)).join("\n")}
};`)(body => body.planFile || body.options?.planFile || "", () => {}, undefined);

function provider(rules = { distributedResults: true }, mode = "worker_pool") {
  return {
    localPlanMetadata: { detectedProject: { adapterRules: rules } },
    projectTopologyAssessment: () => ({ mode }),
    assertPlanTopologyReady: () => ({ mode }),
    distributedProjectContract: () => normalizeDistributedProjectContract(rules.distributed || {}),
    distributedPlanEligible: eligible,
  };
}

test("automatic distribution accepts tuning and arbitrary relative Plan directories by default", () => {
  const host = provider();
  for (const file of ["experiments/plans/comparison_tuning/method.yaml", "experiments/plans/ablation/method.yml", "custom_plans/search.yaml", "experiments\\plans\\comparison\\method.yaml"]) {
    assert.equal(eligible.call(host, file), true, file);
  }
  assert.equal(eligible.call(provider({ distributedResults: false }), "custom_plans/search.yaml"), false);
  assert.equal(eligible.call(provider(undefined, "single_worker"), "custom_plans/search.yaml"), false);
  assert.equal(eligible.call(provider(undefined, "hub_worker"), "custom_plans/search.yaml"), false);
  assert.equal(eligible.call(host, "custom_plans/search.json"), false);
  for (const file of ["../search.yaml", "/search.yaml", "C:/search.yaml", "plans/../search.yaml", "plans//search.yaml"]) {
    assert.equal(eligible.call(host, file), false, file);
  }
});

test("an explicit project Plan prefix still restricts automatic distribution", () => {
  const host = provider({ distributedResults: true, distributed: { planPrefixes: ["plans/formal/"] } });
  assert.equal(eligible.call(host, "plans/formal/train.yaml"), true);
  assert.equal(eligible.call(host, "plans/formal_other/train.yaml"), false);
  assert.equal(eligible.call(host, "plans/prepare.yaml"), false);
});

test("tuning Plan submission automatically validates on one Worker and allocates its jobs across the pool", async () => {
  const host = provider();
  const calls = [];
  const workers = ["worker-a", "worker-b", "worker-c"];
  const availability = workers.map((workerId, index) => ({ workerId, availableGpuIds: [[], ["0", "1", "2"], ["1"]][index] }));
  Object.assign(host, {
    client: { getGpu: async () => ({}) },
    schedulerSettings: () => ({}), availabilityPushTtlSeconds: () => 45,
    localWorkerAvailabilityRows: () => availability,
    lastWorkerProbes: Object.fromEntries(workers.map(id => [id, { status: "ok" }])),
    stampWorkerPoolManualTarget: (body, workerId) => { body.schedulerOwnerWorkerId = workerId; },
    selectDistributedPlanPrimary: primary,
    selectPlanSubmissionWorker: async () => { throw new Error("unexpected manual Worker chooser"); },
    finishDistributedPlanSubmission: async (_command, _message, _plan, body) => {
      calls.push(body.schedulerOwnerWorkerId);
      const jobs = Array.from({ length: 36 }, (_, index) => ({ index, case: `case-${Math.floor(index / 3)}`, seed: 42 + index % 3, outputDir: `work_dirs/tuning/job-${index}` }));
      const pending = queue.enqueuePlan(queue.emptyDistributedQueue(), { planFile: body.planFile, revision: "revision", codeFingerprint: "code", jobs }, "run-tuning");
      const allocation = queue.allocateAvailable(pending, availability.map(row => ({ workerId: row.workerId, idleGpuIds: row.availableGpuIds, online: true })));
      assert.equal(allocation.queue.plans[0].jobs.length, 36);
      assert.equal(allocation.dispatches.length, 4);
      assert.deepEqual(new Set(allocation.dispatches.map(job => job.workerId)), new Set(["worker-b", "worker-c"]));
      assert.equal(allocation.queue.plans[0].jobs.filter(job => job.status === "pending").length, 32);
    },
  });
  await route.call(host, "runPlan", { planFile: "experiments/plans/comparison_tuning/method.yaml" }, {}, {});
  assert.deepEqual(calls, ["worker-b"]);
});

test("standalone validation and dry-run use automatic primary selection for a distributed Plan", async () => {
  const host = provider();
  host.planSchedulerWorkerId = () => undefined;
  host.enabledWorkerConfigs = () => [{ id: "worker-b" }];
  host.lastWorkerProbes = { "worker-b": { status: "ok" } };
  host.missingWorkerActionCapabilities = () => [];
  host.selectDistributedPlanPrimary = async body => { body.schedulerOwnerWorkerId = "worker-b"; return "worker-b"; };
  const body = { planFile: "experiments/plans/comparison_tuning/method.yaml" };
  assert.equal(await preflightTarget.call(host, body, "校验"), "worker-b");
  assert.equal(body.schedulerOwnerWorkerId, "worker-b");
});

test("preflight preserves an already verified code-sync Worker instead of switching versions", async () => {
  const host = provider();
  Object.assign(host, {
    planSchedulerWorkerId: body => body.schedulerOwnerWorkerId,
    enabledWorkerConfigs: () => [{ id: "worker-a" }, { id: "worker-b" }],
    lastWorkerProbes: { "worker-a": { status: "ok" }, "worker-b": { status: "ok" } },
    missingWorkerActionCapabilities: () => [],
    stampWorkerPoolManualTarget: (body, workerId) => { body.schedulerOwnerWorkerId = workerId; },
    selectDistributedPlanPrimary: async () => { throw new Error("must preserve the verified code-sync owner"); },
  });
  const body = { planFile: "custom_plans/search.yaml", schedulerOwnerWorkerId: "worker-a" };
  assert.equal(await preflightTarget.call(host, body, "预演"), "worker-a");
});
