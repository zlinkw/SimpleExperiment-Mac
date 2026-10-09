const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function extractFunction(name) {
  const functionStart = source.indexOf(`function ${name}(`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart).endsWith("async ")
    ? functionStart - 6
    : functionStart;
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", functionStart);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function loadFlowHelpers() {
  const sandbox = {};
  vm.createContext(sandbox);
  const selected = `${extractFunction("runOnboardingSteps")}\n${extractFunction("createSingleFlightRunner")}\nthis.runSteps = runOnboardingSteps; this.createRunner = createSingleFlightRunner;`;
  vm.runInContext(ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  return sandbox;
}

test("onboarding continues to project prompt after an earlier step rejects", async () => {
  const { runSteps } = loadFlowHelpers();
  const calls = [];
  const errors = [];
  await runSteps([
    { name: "resume", run: async () => { calls.push("resume"); throw new Error("resume failed"); } },
    { name: "project", run: async () => { calls.push("project"); } },
    { name: "prompt", run: async () => { calls.push("prompt"); } },
  ], async (step, error) => {
    errors.push([step, error.message]);
    throw new Error("report failed");
  });
  assert.deepEqual(calls, ["resume", "project", "prompt"]);
  assert.deepEqual(errors, [["resume", "resume failed"]]);
});

test("project prompt runner shares concurrent work and resets after settlement", async () => {
  const { createRunner } = loadFlowHelpers();
  const run = createRunner();
  let release;
  let calls = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = run(async () => { calls += 1; await blocked; return "first"; });
  const second = run(async () => { calls += 1; return "duplicate"; });
  assert.strictEqual(first, second);
  release();
  assert.equal(await first, "first");
  assert.equal(await run(async () => { calls += 1; return "next"; }), "next");
  assert.equal(calls, 2);
});
