const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const extension = readSource("src/extension.ts");

function extractFunction(name) {
  let start = extension.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  if (extension.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  const params = extension.indexOf("(", start);
  let paramDepth = 0;
  let paramsEnd = -1;
  for (let index = params; index < extension.length; index += 1) {
    if (extension[index] === "(") paramDepth += 1;
    if (extension[index] === ")") paramDepth -= 1;
    if (paramDepth === 0) {
      paramsEnd = index;
      break;
    }
  }
  const body = extension.indexOf("{", paramsEnd);
  let depth = 0;
  for (let index = body; index < extension.length; index += 1) {
    if (extension[index] === "{") depth += 1;
    if (extension[index] === "}") depth -= 1;
    if (depth === 0) return extension.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function extractConst(name) {
  const start = extension.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = extension.indexOf(";", start);
  assert.ok(end > start, `unterminated ${name}`);
  return extension.slice(start, end + 1);
}

function loadRulePatterns() {
  const sandbox = {
    EMPTY_OUTPUT_DERIVATION_VALUES: Object.freeze([]),
    adapterRuleCandidatePatternsCache: new WeakMap(),
    adapterRuleExactFilesCache: new WeakMap(),
    uniqueCalls: 0,
    parseCalls: 0,
    uniqueStrings(values) {
      sandbox.uniqueCalls += 1;
      const seen = new Set();
      return values.filter((item) => {
        const key = String(item || "").toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    isParseableResultCandidate(value) {
      sandbox.parseCalls += 1;
      return /\.(csv|json|txt|log|out)$/i.test(String(value || ""));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("adapterRuleCandidatePatterns"),
    extractFunction("adapterRuleExactFiles"),
    "this.patterns = adapterRuleCandidatePatterns;",
    "this.exact = adapterRuleExactFiles;",
  ].join("\n"), sandbox);
  return sandbox;
}

function loadDirectoryScanner() {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const sandbox = {
    path,
    projectResultScanConcurrency: 3,
    resultCandidateFile: () => true,
    calls,
    get maxActive() { return maxActive; },
    async walkProjectFiles(dir, root, accept, limit, maxDepth, depth, scanRoot, budget) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const relative = path.relative(root, dir).replace(/\\/g, "/");
      calls.push({ relative, accept, limit, maxDepth, depth, scanRoot, maxDirs: budget && budget.maxDirs });
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, 12 - calls.length)));
      active -= 1;
      return [`${relative}/result.csv`];
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("mapLimited"),
    extractFunction("scanProjectResultCandidateDirs"),
    "this.scan = scanProjectResultCandidateDirs;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("adapter result patterns and exact paths reuse one immutable rules object", () => {
  const sandbox = loadRulePatterns();
  const rules = {
    candidateCsv: ["./runs/{seed}/metrics.csv", "results.csv", "RESULTS.CSV"],
    candidateJson: ["outputs/*.json"],
    consoleLogs: ["logs/stdout.log"],
    inferredPlanTextLogs: ["runs/{case}/summary.txt"],
  };

  const patterns = sandbox.patterns(rules);
  const counts = { unique: sandbox.uniqueCalls, parse: sandbox.parseCalls };
  assert.deepEqual(Array.from(patterns), ["runs/*/metrics.csv", "results.csv", "outputs/*.json", "logs/stdout.log", "runs/*/summary.txt"]);
  assert.equal(sandbox.patterns(rules), patterns);
  assert.deepEqual({ unique: sandbox.uniqueCalls, parse: sandbox.parseCalls }, counts);

  const exact = sandbox.exact(rules);
  assert.deepEqual(Array.from(exact), ["results.csv", "logs/stdout.log"]);
  assert.equal(sandbox.exact(rules), exact);
  assert.deepEqual({ unique: sandbox.uniqueCalls, parse: sandbox.parseCalls }, counts);
});

test("rule source replacement invalidates both project detection derivations", () => {
  const sandbox = loadRulePatterns();
  const rules = { candidateCsv: ["results.csv"] };
  const patterns = sandbox.patterns(rules);
  const exact = sandbox.exact(rules);
  const replacement = { candidateCsv: ["results.csv"] };

  assert.notEqual(sandbox.patterns(replacement), patterns);
  assert.notEqual(sandbox.exact(replacement), exact);
  assert.ok(sandbox.uniqueCalls >= 2);
  assert.equal(sandbox.patterns(null), sandbox.EMPTY_OUTPUT_DERIVATION_VALUES);
  assert.equal(sandbox.exact([]), sandbox.EMPTY_OUTPUT_DERIVATION_VALUES);
});

test("project result directory scans keep input order and bounded concurrency", async () => {
  const sandbox = loadDirectoryScanner();
  const specs = [
    { relative: "experiments/results", limit: 30, maxDepth: 2, maxDirs: 60 },
    { relative: "work_dirs", limit: 24, maxDepth: 2, maxDirs: 80 },
    { relative: "results", limit: 16, maxDepth: 1 },
    { relative: "logs", limit: 8, maxDepth: 3, maxDirs: 40 },
  ];
  const rows = await sandbox.scan("D:/project", specs, 2);

  assert.equal(sandbox.maxActive, 2);
  assert.deepEqual(Array.from(rows), [
    "experiments/results/result.csv",
    "work_dirs/result.csv",
    "results/result.csv",
    "logs/result.csv",
  ]);
  assert.deepEqual(sandbox.calls.map(({ relative, limit, maxDepth, maxDirs }) => ({ relative, limit, maxDepth, maxDirs })), [
    { relative: "experiments/results", limit: 30, maxDepth: 2, maxDirs: 60 },
    { relative: "work_dirs", limit: 24, maxDepth: 2, maxDirs: 80 },
    { relative: "results", limit: 16, maxDepth: 1, maxDirs: undefined },
    { relative: "logs", limit: 8, maxDepth: 3, maxDirs: 40 },
  ]);
});

test("project result scans stay fresh and both detection paths use the shared bounded scanner", async () => {
  const sandbox = loadDirectoryScanner();
  const specs = [{ relative: "results", limit: 10, maxDepth: 2 }];
  await sandbox.scan("D:/project", specs, 1);
  await sandbox.scan("D:/project", specs, 1);
  assert.equal(sandbox.calls.length, 2);

  const actionGate = extractFunction("detectLocalProjectForActionGate");
  const fullDetection = extractFunction("detectResultOutputs");
  assert.match(actionGate, /Promise\.all/);
  assert.match(actionGate, /scanProjectResultCandidateDirs\(root, actionGateResultScanSpecs\)/);
  assert.match(fullDetection, /Promise\.all/);
  assert.match(fullDetection, /scanProjectResultCandidateDirs\(root, fullProjectResultScanSpecs\)/);
  assert.doesNotMatch(actionGate, /await walkProjectFiles/);
  assert.doesNotMatch(fullDetection, /await walkProjectFiles/);
  assert.match(extension, /const projectResultExactCandidates = Object\.freeze\(\[/);
  assert.match(extension, /const adapterRuleCandidatePatternsCache = new WeakMap\(\)/);
  assert.match(extension, /const adapterRuleExactFilesCache = new WeakMap\(\)/);
});

test("heavy project directory checks reuse one fixed exact-name set", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext([
    extractConst("heavyProjectDirNames"),
    extractFunction("isHeavyProjectDir"),
    "this.isHeavy = isHeavyProjectDir;",
  ].join("\n"), sandbox);

  for (const relative of [".git/objects", "src/node_modules/pkg", "Research/Data/raw", "work_dirs/run-1", "build/output"]) {
    assert.equal(sandbox.isHeavy(relative), true, relative);
  }
  for (const relative of ["src/datasets_loader", "src/builders", "experiments/output_logs", "research/runsets"]) {
    assert.equal(sandbox.isHeavy(relative), false, relative);
  }
  assert.match(extension, /const heavyProjectDirNames = new Set\(\[/);
  assert.doesNotMatch(extractFunction("isHeavyProjectDir"), /new Set/);
});
