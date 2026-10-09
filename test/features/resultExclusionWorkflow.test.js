const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource, readBuiltAgentRuntime } = require("../_helpers/sourceReader");

function extractAgent() { return readBuiltAgentRuntime(); }

test("current Plan revision can exclude results without deleting preview data or artifacts", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-exclude-"));
  const agentPath = path.join(tmp, "cluster_agent.py");
  fs.writeFileSync(agentPath, extractAgent(source), "utf8");
  const root = path.join(tmp, "project");
  fs.mkdirSync(path.join(root, "experiments", "plans"), { recursive: true });
  fs.mkdirSync(path.join(root, "work_dirs", "smoke"), { recursive: true });
  fs.writeFileSync(path.join(root, "experiments", "plans", "smoke.yaml"), "suite: smoke\nbase_config: configs/base.yaml\npaper:\n  result_csv: work_dirs/smoke/metrics.csv\n", "utf8");
  fs.writeFileSync(path.join(root, "work_dirs", "smoke", "metrics.csv"), "method,dataset,split,seed,metric,value\nbase,ds,test,1,AUC,0.80\nours,ds,test,1,AUC,0.90\n", "utf8");
  const script = path.join(tmp, "check.py");
  fs.writeFileSync(script, [
    "import importlib.util, json, os, csv",
    `spec = importlib.util.spec_from_file_location('agent', ${JSON.stringify(agentPath)})`,
    "agent = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(agent)",
    `root = ${JSON.stringify(root)}`,
    "plan = 'experiments/plans/smoke.yaml'",
    "revision = 'rev-current'",
    "initial = agent.parse_results_action(root, None, plan, revision)",
    "first, second = initial['results']",
    "agent.mark_archive_state(root, [first['resultId']], 'archive-artifacts', plan, revision)",
    "agent.mark_result_review_state(root, [second['resultId']], 'excluded', plan, revision)",
    "summary = agent.parse_results_action(root, None, plan, revision)",
    "preview = agent.safe_project_path(root, summary['previewCsvPath'])",
    "effective = agent.safe_project_path(root, summary['effectiveResultsCsvPath'])",
    "missing_revision = agent.handle_action(root, 'exclude-results', {'archiveKey': first['resultId'], 'planFile': plan}, 'op-missing', 'op-missing')",
    "agent.mark_result_review_state(root, [first['resultId']], 'excluded', plan, 'rev-old')",
    "current_entries = agent.read_archive_entries(root, plan, revision)",
    "print(json.dumps({",
    "  'states': sorted(row.get('finalEvidenceState') for row in summary['results']),",
    "  'previewRows': len(list(csv.DictReader(open(preview, encoding='utf-8')))),",
    "  'effectiveRows': len(list(csv.DictReader(open(effective, encoding='utf-8')))),",
    "  'archived': summary.get('effectiveArchivedResultCount'),",
    "  'excluded': summary.get('excludedResultCount'),",
    "  'pending': summary.get('pendingReviewCount'),",
    "  'artifactExists': os.path.isfile(os.path.join(root, 'work_dirs', 'smoke', 'metrics.csv')),",
    "  'missingRevisionStatus': missing_revision.get('status'),",
    "  'currentKeys': sorted(current_entries.keys()),",
    "}))",
  ].join("\n"), "utf8");
  const result = spawnSync("python", [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse((result.stdout || "").trim().split(/\r?\n/).pop());
  assert.deepEqual(payload.states, ["archived", "excluded"]);
  assert.equal(payload.previewRows, 2);
  assert.equal(payload.effectiveRows, 1);
  assert.equal(payload.archived, 1);
  assert.equal(payload.excluded, 1);
  assert.equal(payload.pending, 0);
  assert.equal(payload.artifactExists, true);
  assert.equal(payload.missingRevisionStatus, "failed");
  assert.equal(payload.currentKeys.length, 1);
});

test("result exclusion is wired through Hub action, debug gate, and current revision UI", () => {
  const extension = readSource("src/extension.ts");
  const panel = readSource("src/ui/PanelHtml.ts");
  const tunnel = readSource("src/tunnel/TunnelClient.ts");
  const agent = readSource("src/clusterAgentRuntime.ts");
  assert.match(extension, /excludeResults: "exclude-results"/);
  assert.match(extension, /const RESULT_REPARSE_ACTIONS = new Set\(\[[^\]]*"exclude-results"/);
  assert.match(extension, /function actionRequiresResultReparse\(action\) \{\s*return RESULT_REPARSE_ACTIONS\.has/);
  assert.match(panel, /excludeResults: \["actions\.exclude-results"\]/);
  assert.match(panel, /traceActionButton\("排除但保留预览", "excludeResults", row, true\)/);
  assert.match(panel, /data-plan-revision=/);
  assert.match(panel, /reviewStateLabel\(row\.reviewState\)/);
  assert.match(tunnel, /"exclude-results"/);
  assert.match(agent, /"exclude-results"[\s\S]{0,220}DEBUG_BLOCKED_ACTIONS|DEBUG_BLOCKED_ACTIONS[\s\S]{0,220}"exclude-results"/);
});
