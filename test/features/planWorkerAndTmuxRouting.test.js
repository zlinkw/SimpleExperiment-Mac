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

test("one Hub Worker is stamped as the Plan target before submission", async () => {
  const body = {};
  const worker = { id: "worker-a" };
  const target = { id: worker.id, projectDir: "/project" };
  const preamble = methodBody(
    'async selectPlanSubmissionWorker(body, label = "当前 Plan") {',
    "        let gpuSnapshot: any =",
  );
  const compiled = ts.transpileModule(`class Subject { async selectPlanSubmissionWorker(body, label) {${preamble}} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const select = new Function(`${compiled}; return Subject.prototype.selectPlanSubmissionWorker;`)();
  const provider = {
    assertPlanTopologyReady: () => ({ mode: "hub_worker" }),
    enabledWorkerConfigs: () => [worker],
    workerActionTargets: () => [target],
  };
  assert.equal(await select.call(provider, body, "Plan"), worker.id);
  assert.deepEqual(body.selectedWorkerIds, [worker.id]);
  assert.equal(body.options.workerId, worker.id);
  assert.deepEqual(body.options.workers, [target]);
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
