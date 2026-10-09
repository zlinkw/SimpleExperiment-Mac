const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

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

function trackedTargets(rows) {
  let iterations = 0;
  return {
    rows: new Proxy(rows, {
      get(target, property, receiver) {
        if (property !== Symbol.iterator) return Reflect.get(target, property, receiver);
        return function iterator() {
          iterations += 1;
          return target[Symbol.iterator]();
        };
      },
    }),
    iterations: () => iterations,
  };
}

test("Worker scoped selections collect all fields in one target traversal", () => {
  const sandbox = {
    usableSelectionKey(value) {
      const text = String(value || "").trim();
      return text && text !== "-" ? text : "";
    },
    uniqueStrings(values) { return Array.from(new Set(values)); },
  };
  vm.createContext(sandbox);
  const source = extractFunction("workerScopedSelectionLists");
  assert.doesNotMatch(source, /scopedTargets\.(?:map|filter)\(/);
  vm.runInContext(`${source}\nthis.collect = workerScopedSelectionLists;`, sandbox);
  const targets = trackedTargets([
    { runKey: "run-a", experimentId: "exp-a", archiveKey: "arc-a", taskUiKey: "ui-a", planFile: "plans/a.yaml" },
    { runKey: "run-a", experimentId: "exp-b", archiveKey: "-", taskUiKey: "ui-b", planFile: "plans/a.yaml" },
    { runKey: " ", experimentId: "exp-b", archiveKey: "arc-b", taskUiKey: "", planFile: "plans/b.yaml" },
  ]);
  const result = sandbox.collect(targets.rows);

  assert.equal(targets.iterations(), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    selectedRunKeys: ["run-a"],
    selectedExperimentIds: ["exp-a", "exp-b"],
    selectedArchiveKeys: ["arc-a", "arc-b"],
    selectedTaskUiKeys: ["ui-a", "ui-b"],
    selectedPlanFiles: ["plans/a.yaml", "plans/b.yaml"],
  });
});

test("Worker action body consumes the shared scoped selection derivation", () => {
  const start = extension.indexOf("workerScopedActionBody(body, workerId)");
  const end = extension.indexOf("async syncToGitHub", start);
  assert.ok(start >= 0 && end > start);
  const source = extension.slice(start, end);
  assert.match(source, /workerScopedSelectionLists\(scopedTargets\)/);
  assert.doesNotMatch(source, /scopedTargets\.map\(/);
});
