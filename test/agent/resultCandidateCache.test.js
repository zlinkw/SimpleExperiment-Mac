const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

test("result candidate normalization is memoized without changing its verdicts", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const script = String.raw`
import importlib.util, json

spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

samples = [
    "experiments/results.csv",
    "experiments\\results.csv",
    "  'experiments/results.csv'  ",
    "simple_cluster/results/{plan}/metrics_summary.csv",
    "experiments/results/**/results.csv",
    "../escape/results.csv",
    "/absolute/results.csv",
    "C:/windows/results.csv",
    "https://example.com/results.csv",
    "none",
    "",
    "src/extension.ts",
    "experiments/plan.yaml",
]

computes = {"count": 0}
real_compute = agent.compute_result_candidate
def counted(value):
    computes["count"] += 1
    return real_compute(value)

expected = {sample: real_compute(sample) for sample in samples}
agent.RESULT_CANDIDATE_CACHE.clear()
agent.compute_result_candidate = counted

first = [agent.normalize_result_candidate(sample) for sample in samples]
after_first = computes["count"]
second = [agent.normalize_result_candidate(sample) for sample in samples]
after_second = computes["count"]

non_string = [agent.normalize_result_candidate(None), agent.normalize_result_candidate(0), agent.normalize_result_candidate(["x"])]
after_non_string = computes["count"]

for index in range(agent.MAX_RESULT_CANDIDATE_CACHE_RECORDS + 32):
    agent.normalize_result_candidate("experiments/results/run-%d/results.csv" % index)
bounded = len(agent.RESULT_CANDIDATE_CACHE)

print(json.dumps({
    "matchesDirect": first == [expected[sample] for sample in samples],
    "stable": first == second,
    "firstComputes": after_first,
    "secondComputes": after_second - after_first,
    "nonStringComputes": after_non_string - after_second,
    "sampleCount": len(samples),
    "bounded": bounded,
    "maxRecords": agent.MAX_RESULT_CANDIDATE_CACHE_RECORDS,
    "normalizedBackslash": agent.normalize_result_candidate("experiments\\results.csv"),
    "rejectedEscape": agent.normalize_result_candidate("../escape/results.csv"),
    "rejectedAbsolute": agent.normalize_result_candidate("/absolute/results.csv"),
    "nonResultSuffix": agent.normalize_result_candidate("src/extension.ts"),
    "rejectedSourceCsv": agent.normalize_result_candidate("src/extension.csv"),
    "placeholderWildcard": agent.normalize_result_candidate("simple_cluster/results/{plan}/metrics_summary.csv"),
    "nonStringValues": non_string,
}))
`;

  const run = spawnSync("python", ["-c", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.matchesDirect, true);
  assert.equal(result.stable, true);
  assert.equal(result.firstComputes, result.sampleCount);
  assert.equal(result.secondComputes, 0);
  assert.equal(result.nonStringComputes, 3);
  assert.ok(result.bounded <= result.maxRecords, `cache grew to ${result.bounded}`);
  assert.equal(result.normalizedBackslash, "experiments/results.csv");
  assert.equal(result.rejectedEscape, "");
  assert.equal(result.rejectedAbsolute, "");
  assert.equal(result.nonResultSuffix, "src/extension.ts");
  assert.equal(result.rejectedSourceCsv, "");
  assert.equal(result.placeholderWildcard, "simple_cluster/results/*/metrics_summary.csv");
  assert.equal(result.nonStringValues.join("|"), "||['x']");
});

test("result candidate cache keeps the pure derivation reachable", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  assert.match(source, /MAX_RESULT_CANDIDATE_CACHE_RECORDS = 512/);
  assert.match(source, /def compute_result_candidate\(value\)/);
  assert.match(source, /key = value if isinstance\(value, str\) else None/);
});
