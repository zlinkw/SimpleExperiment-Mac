const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/extension.ts");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next).trim();
}

test("local Plan gate checks explicit relative Python entries without blocking remote commands", () => {
  const sandbox = {
    path,
    PLAN_TRAIN_MODE_TOKENS: new Set(["train", "training", "train_only"]),
    PLAN_TEST_MODE_TOKENS: new Set(["test", "eval", "evaluate", "evaluation", "test_only", "eval_only"]),
    PLAN_COMMAND_KEYS_BY_MODE: {
      train: new Set(["train_command", "trainCommand", "command"]),
      test: new Set(["test_command", "testCommand"]),
      train_test: new Set(["train_command", "trainCommand", "test_command", "testCommand", "command"]),
    },
    PYTHON_COMMAND_REFERENCE_CACHE_LIMIT: 256,
    pythonCommandEntryReferencesCache: new Map(),
    uniqueStrings: (values) => [...new Set(values.filter(Boolean))],
    stripYamlComment: (value) => String(value).replace(/\s+#.*$/, ""),
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("planCommandValues"),
    extractFunction("pythonCommandReferenceCacheValue"),
    extractFunction("cachePythonCommandReferenceValue"),
    extractFunction("pythonCommandEntryReferences"),
    "this.api = { planCommandValues, pythonCommandEntryReferences };",
  ].join("\n"), sandbox);

  assert.deepEqual([...sandbox.api.planCommandValues([
    "runner:",
    "  train_command: \"python tools/train.py --config {config}\"",
    "  test_command: 'python tools/test.py --result-csv {result_csv}' # result",
    "cases:",
    "  - command: python scripts/fit.py --seed {seed}",
  ].join("\n"))], [
    "python tools/train.py --config {config}",
    "python tools/test.py --result-csv {result_csv}",
    "python scripts/fit.py --seed {seed}",
  ]);
  const mixed = [
    "runner:",
    "  train_command: python tools/train.py",
    "  test_command: python tools/test.py",
    "cases: [{case: extra, train_command: 'python scripts/fit.py', test_command: 'python scripts/eval.py'}]",
  ].join("\n");
  assert.deepEqual([...sandbox.api.planCommandValues(mixed, "train")], ["python tools/train.py", "python scripts/fit.py"]);
  assert.deepEqual([...sandbox.api.planCommandValues(mixed, "test")], ["python tools/test.py", "python scripts/eval.py"]);
  assert.match(source, /const PLAN_COMMAND_KEYS_BY_MODE = \{/);
  assert.match(source, /const acceptedKeys = PLAN_COMMAND_KEYS_BY_MODE\[normalizedMode\]/);

  assert.deepEqual([...sandbox.api.pythonCommandEntryReferences("python -u tools/train.py --config x")], ["tools/train.py"]);
  assert.deepEqual([...sandbox.api.pythonCommandEntryReferences("python3.11 'tools/test net.py' --config x")], ["tools/test net.py"]);
  assert.deepEqual([...sandbox.api.pythonCommandEntryReferences("torchrun --nproc-per-node=2 scripts/train.py")], ["scripts/train.py"]);
  assert.deepEqual([...sandbox.api.pythonCommandEntryReferences("python -m package.train --config x")], []);
  assert.deepEqual([...sandbox.api.pythonCommandEntryReferences("python /opt/project/train.py --config x")], []);
  assert.deepEqual([...sandbox.api.pythonCommandEntryReferences("python {entry_script} --config x")], []);
  assert.deepEqual([...sandbox.api.pythonCommandEntryReferences("bash scripts/train.sh")], []);

  assert.match(source, /commands\.flatMap\(pythonCommandEntryReferences\)/);
  assert.match(source, /当前 Plan 的 Python 入口文件不存在/);
  assert.ok(source.indexOf("assertPlanLocalConfigFiles(body)") < source.indexOf("ensureCodeReadyForRun(undefined, [body],"));
});
