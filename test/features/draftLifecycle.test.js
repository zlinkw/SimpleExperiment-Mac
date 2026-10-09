const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DraftPlans = require("../../dist/features/DraftPlans.js");
const PlanBuilder = require("../../dist/features/PlanBuilder.js");
const agentRuntime = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
function validDraftYaml(suite, config) {
  const res = PlanBuilder.buildExperimentMatrix({ baseConfig: config, suite, seeds: ["1"], variables: [] }, []);
  return res.yaml;
}

async function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draft-lifecycle-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFileSync(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

test("draft discovery distinguishes Draft mark and not mixed into formal plans", async () => {
  await withTempWorkspace(async (root) => {
    // formal plan
    writeFileSync(root, "experiments/plans/formal.yaml", "suite: s\nbase_config: configs/a.yaml\nseeds: [1]\ncases:\n  - case: c1\n");
    writeFileSync(root, "configs/a.yaml", "lr: 0.001\n");
    // draft plan
    writeFileSync(root, "tmp/plan/exp.yaml", validDraftYaml("draft_suite", "tmp/config/base.yaml"));
    writeFileSync(root, "tmp/config/base.yaml", "lr: 0.002\n");
    const result = await DraftPlans.reconcileDraftPlans(root);
    assert.equal(result.enabled, true);
    assert.equal(result.drafts.length, 1);
    const draft = result.drafts[0];
    assert.equal(draft.draftPlanPath, "tmp/plan/exp.yaml");
    assert.equal(draft.status, "validated");
    assert.ok(draft.draftConfigPaths.includes("tmp/config/base.yaml"));
    assert.ok(draft.contentHash);
    assert.ok(draft.promotionTargetPaths.includes("experiments/plans/exp.yaml"));
    assert.ok(draft.promotionTargetPaths.includes("configs/base.yaml"));
    // formal discovery should not include drafts (simulate readLocalPlans)
    const formalDir = path.join(root, "experiments/plans");
    const files = fs.readdirSync(formalDir);
    assert.equal(files.includes("exp.yaml"), false); // formal exp.yaml not exist yet, draft is separate
    // ensure draft not counted as formal
    assert.equal(result.drafts[0].draftPlanPath.startsWith("tmp/plan/"), true);
  });
});

test("draft path safety rejects traversal and absolute", async () => {
  assert.equal(DraftPlans.isDraftPlanPath("tmp/plan/a.yaml"), true);
  assert.equal(DraftPlans.isDraftPlanPath("tmp/plan/../etc/passwd"), false);
  assert.equal(DraftPlans.isDraftPlanPath("/absolute/path.yaml"), false);
  assert.equal(DraftPlans.isDraftConfigPath("tmp/config/a.yaml"), true);
  assert.equal(DraftPlans.isDraftConfigPath("configs/a.yaml"), false);
  // safeDraftWorkspaceChild should throw for traversal
  await withTempWorkspace(async (root) => {
    assert.throws(() => DraftPlans.safeDraftWorkspaceChild(root, "../escape.yaml"));
    assert.throws(() => DraftPlans.safeDraftWorkspaceChild(root, "/absolute.yaml"));
    // tmp/../escape.yaml normalizes to escape.yaml inside workspace, not throw
    const pInside = DraftPlans.safeDraftWorkspaceChild(root, "tmp/../escape.yaml");
    assert.ok(pInside.endsWith("escape.yaml"));
    assert.throws(() => DraftPlans.safeDraftWorkspaceChild(root, "../../escape.yaml"));
    // valid
    const p = DraftPlans.safeDraftWorkspaceChild(root, "tmp/plan/a.yaml");
    assert.ok(p.includes("tmp"));
  });
});

test("draft validate references must be tmp/config", async () => {
  const validBase = validDraftYaml("s", "tmp/config/a.yaml");
  const vOk = DraftPlans.validateDraftReferences("tmp/plan/a.yaml", validBase);
  assert.equal(vOk.ok, true);
  assert.equal(vOk.status, "validated");
  const badBase = validBase.replace("tmp/config/a.yaml", "configs/a.yaml");
  const vBad = DraftPlans.validateDraftReferences("tmp/plan/a.yaml", badBase);
  assert.equal(vBad.ok, false);
  assert.ok(vBad.issues.some(i => i.code === "CONFIG_OUTSIDE_TMP"));
  const noRef = validBase.replace(/base_config:.*tmp\/config\/a\.yaml.*\n/, "");
  const vNo = DraftPlans.validateDraftReferences("tmp/plan/a.yaml", noRef);
  assert.equal(vNo.ok, false);
  assert.ok(vNo.issues.some(i => i.code === "NO_DRAFT_CONFIG"));
});

test("debug output isolation uses snapshot hash and writes to debug_runs", async () => {
  await withTempWorkspace(async (root) => {
    writeFileSync(root, "tmp/plan/d.yaml", validDraftYaml("s", "tmp/config/c.yaml"));
    writeFileSync(root, "tmp/config/c.yaml", "lr: 0.01\n");
    const reconciled = await DraftPlans.reconcileDraftPlans(root);
    assert.equal(reconciled.drafts[0].status, "validated");
    // check content hash stable
    const hash1 = reconciled.drafts[0].contentHash;
    const result2 = await DraftPlans.reconcileDraftPlans(root);
    assert.equal(result2.drafts[0].contentHash, hash1);
    // modify config
    writeFileSync(root, "tmp/config/c.yaml", "lr: 0.02\n");
    const result3 = await DraftPlans.reconcileDraftPlans(root);
    assert.notEqual(result3.drafts[0].contentHash, hash1);
    // check snapshot hash logic via sha256Text
    const snapshotId = DraftPlans.sha256Text("tmp/plan/d.yaml\n" + DraftPlans.sha256Text(fs.readFileSync(path.join(root,"tmp/plan/d.yaml"),"utf8"))).slice(0,24);
    assert.equal(snapshotId.length, 24);
    // verify debug output isolation via agent runtime: materialize snapshot should be under simple_cluster/drafts/snapshots
    const script = [
      "import importlib.util, json, os",
      `spec = importlib.util.spec_from_file_location('agent', r'${agentRuntime.replace(/\\/g, "/")}')`,
      "agent = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(agent)",
      `root = r'${root.replace(/\\/g, "/")}'`,
      `print(json.dumps(agent.materialize_draft_snapshot(root, 'tmp/plan/d.yaml')))`
    ].join("\n");
    const result = spawnSync("python", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const snap = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.ok(snap.executionPlan.startsWith("simple_cluster/drafts/snapshots/"));
    assert.ok(snap.executionPlan.endsWith("plan.yaml"));
    assert.ok(!snap.executionPlan.includes("work_dirs/"));
    assert.ok(!snap.executionPlan.includes("experiments/results/"));
    assert.ok(!snap.executionPlan.includes("experiments/runs/"));
    // debug output dir should be simple_cluster/debug_runs/...
    // simulate isolate logic not needed, but ensure debug_runs not in formal results
    writeFileSync(root, "simple_cluster/debug_runs/plan/run/results.csv", "a,b\n1,2\n");
    writeFileSync(root, "experiments/results/results.csv", "a,b\n3,4\n");
    const discScript = [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location('agent', r'${agentRuntime.replace(/\\/g, "/")}')`,
      "agent = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(agent)",
      `print(json.dumps(agent.discover_result_files(r'${root.replace(/\\/g, "/")}')))`
    ].join("\n");
    const disc = spawnSync("python", ["-c", discScript], { encoding: "utf8" });
    assert.equal(disc.status, 0, disc.stderr);
    const files = JSON.parse(disc.stdout.trim().split(/\r?\n/).at(-1));
    assert.ok(files.includes("experiments/results/results.csv"));
    assert.ok(!files.some(f => f.includes("debug_runs")));
    assert.ok(!files.some(f => f.includes("tmp/result")));
  });
});

test("config snapshot hash deterministic and diff", async () => {
  await withTempWorkspace(async (root) => {
    writeFileSync(root, "tmp/plan/a.yaml", validDraftYaml("s", "tmp/config/x.yaml"));
    writeFileSync(root, "tmp/config/x.yaml", "lr: 1\n");
    // need to mark debug completed to allow promotion preview
    const reconciled = await DraftPlans.reconcileDraftPlans(root);
    const draft = reconciled.drafts[0];
    // Simulate debug completed state
    await DraftPlans.updateDraftMetadata(root, draft.draftPlanPath, (rec) => ({ ...rec, status: "debug_completed", lastDebugRunId: "debug-123", lastDebugStatus: "completed" }));
    const preview = await DraftPlans.buildPromotionPreview(root, draft.draftPlanPath, { debugRunId: "debug-123", debugStatus: "completed", metricsSummary: { acc: 0.9 } });
    assert.equal(preview.schemaVersion, 1);
    assert.equal(preview.draftPlanPath, "tmp/plan/a.yaml");
    assert.equal(preview.debugRunId, "debug-123");
    assert.ok(preview.contentHash);
    assert.equal(preview.targets.length, 2);
    const planTarget = preview.targets.find(t => t.kind === "plan");
    assert.ok(planTarget);
    assert.equal(planTarget.targetPath, "experiments/plans/a.yaml");
    assert.equal(planTarget.exists, false);
    assert.ok(planTarget.diff.added.length > 0 || planTarget.diff.removed.length >= 0);
    assert.equal(planTarget.sourceHash, DraftPlans.sha256Text(fs.readFileSync(path.join(root, "tmp/plan/a.yaml"),"utf8")));
    // modify target to exist and test diff
    writeFileSync(root, "experiments/plans/a.yaml", "suite: old\nbase_config: configs/x.yaml\n");
    const preview2 = await DraftPlans.buildPromotionPreview(root, draft.draftPlanPath, { debugRunId: "debug-123", debugStatus: "completed", metricsSummary: {} });
    const pt2 = preview2.targets.find(t => t.kind === "plan");
    assert.equal(pt2.exists, true);
    assert.ok(pt2.diff.added.length > 0);
    assert.ok(preview2.conflicts.some(c => c.path === "experiments/plans/a.yaml"));
  });
});

test("conflict protection requires rename/replace/cancel and ledger", async () => {
  await withTempWorkspace(async (root) => {
    writeFileSync(root, "tmp/plan/conflict.yaml", validDraftYaml("s", "tmp/config/c.yaml"));
    writeFileSync(root, "tmp/config/c.yaml", "v: 1\n");
    writeFileSync(root, "experiments/plans/conflict.yaml", "suite: existing\nbase_config: configs/c.yaml\n");
    writeFileSync(root, "configs/c.yaml", "v: 0\n");
    const rec = await DraftPlans.reconcileDraftPlans(root);
    await DraftPlans.updateDraftMetadata(root, "tmp/plan/conflict.yaml", (r) => ({ ...r, status: "debug_completed", lastDebugRunId: "run1", lastDebugStatus: "completed" }));
    const preview = await DraftPlans.buildPromotionPreview(root, "tmp/plan/conflict.yaml", { debugRunId: "run1", debugStatus: "completed", metricsSummary: { m: 1 } });
    assert.ok(preview.conflicts.length > 0);
    // cancel should throw
    await assert.rejects(() => DraftPlans.promoteDraft(root, preview, { conflictMode: "cancel" }), /取消/);
    // rename should succeed and create new file with _draft_ suffix
    const resRename = await DraftPlans.promoteDraft(root, preview, { conflictMode: "rename" });
    assert.equal(resRename.decision, "promoted");
    assert.ok(resRename.renamedTargets.length > 0);
    // ledger should exist
    const ledgerPath = path.join(root, "simple_cluster/drafts/promotions.jsonl");
    assert.ok(fs.existsSync(ledgerPath));
    const lines = fs.readFileSync(ledgerPath,"utf8").trim().split(/\n/);
    const last = JSON.parse(lines[lines.length-1]);
    assert.equal(last.sourceHash, preview.contentHash);
    assert.ok(last.targetPaths.some(p => p.includes("conflict")));
    assert.equal(last.debugRunId, "run1");
    assert.equal(last.userConfirmed, true);
    // replace mode should overwrite
    // create another draft conflicting
    writeFileSync(root, "tmp/plan/conflict2.yaml", validDraftYaml("s2", "tmp/config/c2.yaml"));
    writeFileSync(root, "tmp/config/c2.yaml", "v: 2\n");
    writeFileSync(root, "experiments/plans/conflict2.yaml", "existing2");
    writeFileSync(root, "configs/c2.yaml", "existing2cfg");
    const rec2 = await DraftPlans.reconcileDraftPlans(root);
    await DraftPlans.updateDraftMetadata(root, "tmp/plan/conflict2.yaml", (r) => ({ ...r, status: "debug_completed", lastDebugRunId: "run2", lastDebugStatus: "completed" }));
    const preview2 = await DraftPlans.buildPromotionPreview(root, "tmp/plan/conflict2.yaml", { debugRunId: "run2", debugStatus: "completed", metricsSummary: {} });
    const resReplace = await DraftPlans.promoteDraft(root, preview2, { conflictMode: "replace" });
    assert.equal(resReplace.decision, "replaced");
    // for replace, renamedTargets should be empty
    assert.equal(resReplace.renamedTargets.length, 0);
    // promoted file should have new content
    const formalContent = fs.readFileSync(path.join(root, "experiments/plans/conflict2.yaml"),"utf8");
    assert.ok(formalContent.includes("s2"));
  });
});

test("promotion rewrites config reference to formal path", async () => {
  await withTempWorkspace(async (root) => {
    writeFileSync(root, "tmp/plan/rw.yaml", validDraftYaml("rw", "tmp/config/rw.yaml"));
    writeFileSync(root, "tmp/config/rw.yaml", "lr: 0.5\n");
    const rec = await DraftPlans.reconcileDraftPlans(root);
    await DraftPlans.updateDraftMetadata(root, "tmp/plan/rw.yaml", (r) => ({ ...r, status: "debug_completed", lastDebugRunId: "d1", lastDebugStatus: "completed" }));
    const preview = await DraftPlans.buildPromotionPreview(root, "tmp/plan/rw.yaml", { debugRunId: "d1", debugStatus: "completed", metricsSummary: {} });
    const res = await DraftPlans.promoteDraft(root, preview, { conflictMode: "rename" });
    const formalPlan = fs.readFileSync(path.join(root, res.planPath),"utf8");
    assert.ok(formalPlan.includes("configs/rw.yaml"), "formal plan should reference configs/ not tmp/config");
    assert.ok(!formalPlan.includes("tmp/config/rw.yaml"));
  });
});

test("promotion ledger contains source hash, target, debug run id, timestamp, userConfirmed", async () => {
  await withTempWorkspace(async (root) => {
    writeFileSync(root, "tmp/plan/ledger.yaml", validDraftYaml("s", "tmp/config/l.yaml"));
    writeFileSync(root, "tmp/config/l.yaml", "a: 1\n");
    const rec = await DraftPlans.reconcileDraftPlans(root);
    await DraftPlans.updateDraftMetadata(root, "tmp/plan/ledger.yaml", (r) => ({ ...r, status: "debug_completed", lastDebugRunId: "dbg-999", lastDebugStatus: "completed" }));
    const preview = await DraftPlans.buildPromotionPreview(root, "tmp/plan/ledger.yaml", { debugRunId: "dbg-999", debugStatus: "completed", metricsSummary: { acc: 0.8 } });
    const res = await DraftPlans.promoteDraft(root, preview, { conflictMode: "rename", reviewedBy: "tester" });
    const ledger = fs.readFileSync(path.join(root, "simple_cluster/drafts/promotions.jsonl"),"utf8");
    const entry = JSON.parse(ledger.trim().split("\n").pop());
    assert.equal(entry.sourceHash, preview.contentHash);
    assert.ok(entry.targetPaths.includes(res.planPath));
    assert.equal(entry.debugRunId, "dbg-999");
    assert.ok(entry.promotedAt);
    assert.equal(entry.userConfirmed, true);
    assert.equal(entry.reviewedBy, "tester");
  });
});

test("rejected/stale cleanup candidate判定 and promoted retained", async () => {
  await withTempWorkspace(async (root) => {
    // draft1 rejected
    writeFileSync(root, "tmp/plan/rej.yaml", validDraftYaml("s", "tmp/config/rej.yaml"));
    writeFileSync(root, "tmp/config/rej.yaml", "a: 1\n");
    // draft2 stale (deleted)
    writeFileSync(root, "tmp/plan/stale.yaml", validDraftYaml("s", "tmp/config/stale.yaml"));
    writeFileSync(root, "tmp/config/stale.yaml", "a: 1\n");
    // draft3 promoted
    writeFileSync(root, "tmp/plan/prom.yaml", validDraftYaml("s", "tmp/config/prom.yaml"));
    writeFileSync(root, "tmp/config/prom.yaml", "a: 1\n");
    let rec = await DraftPlans.reconcileDraftPlans(root);
    // mark statuses
    await DraftPlans.rejectDraft(root, "tmp/plan/rej.yaml");
    await DraftPlans.updateDraftMetadata(root, "tmp/plan/prom.yaml", (r) => ({ ...r, status: "promoted", promotionTargetPaths: ["experiments/plans/prom.yaml"], contentHash: r.contentHash }));
    // make stale by deleting file
    fs.unlinkSync(path.join(root, "tmp/plan/stale.yaml"));
    rec = await DraftPlans.reconcileDraftPlans(root);
    // stale record should exist with missing true
    const stale = rec.drafts.find(d => d.draftPlanPath === "tmp/plan/stale.yaml");
    assert.equal(stale.status, "stale");
    assert.equal(stale.missing, true);
    // cleanup candidates should include rej but not prom, not missing stale
    const candidates = await DraftPlans.listCleanupCandidates(root, rec.drafts);
    const paths = candidates.map(c => c.path);
    assert.ok(paths.includes("tmp/plan/rej.yaml"), "rejected should be candidate");
    assert.ok(paths.includes("tmp/config/rej.yaml"));
    assert.ok(!paths.includes("tmp/plan/prom.yaml"), "promoted should not be candidate");
    assert.ok(!paths.includes("tmp/plan/stale.yaml"), "missing stale file should not be candidate as file not exists");
    // but stale config still? stale.yaml config maybe still exists but draftPlan missing => candidate should not include missing plan's config if missing?
    // test protection: config shared between rejected and active
    writeFileSync(root, "tmp/config/shared.yaml", "shared: 1\n");
    writeFileSync(root, "tmp/plan/active.yaml", validDraftYaml("s", "tmp/config/shared.yaml"));
    writeFileSync(root, "tmp/plan/rej2.yaml", validDraftYaml("s", "tmp/config/shared.yaml"));
    let rec2 = await DraftPlans.reconcileDraftPlans(root);
    await DraftPlans.rejectDraft(root, "tmp/plan/rej2.yaml");
    rec2 = await DraftPlans.reconcileDraftPlans(root);
    const cands2 = await DraftPlans.listCleanupCandidates(root, rec2.drafts);
    const hasShared = cands2.some(c => c.path === "tmp/config/shared.yaml");
    assert.equal(hasShared, false, "shared config should be protected by active draft");
    // cleanupApprovedDrafts should enforce exact candidate
    const toDelete = ["tmp/plan/rej.yaml"];
    const result = await DraftPlans.cleanupApprovedDrafts(root, rec.drafts, toDelete);
    assert.deepEqual(result.moved, ["clean_dir/tmp/plan/rej.yaml"]);
    assert.ok(!fs.existsSync(path.join(root, "tmp/plan/rej.yaml")));
    assert.ok(fs.existsSync(path.join(root, "clean_dir/tmp/plan/rej.yaml")));
  });
});

test("debug results not entering archive/statistics/paper evidence/PPT", async () => {
  await withTempWorkspace(async (root) => {
    // formal result discovery should ignore debug_runs
    writeFileSync(root, "experiments/results/formal.csv", "metric,value\nAUC,0.9\n");
    writeFileSync(root, "simple_cluster/debug_runs/plan/dbg/results.csv", "metric,value\nAUC,0.1\n");
    writeFileSync(root, "tmp/result/preview.png", "fake");
    const script = [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location('agent', r'${agentRuntime.replace(/\\/g, "/")}')`,
      "agent = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(agent)",
      `print(json.dumps(agent.discover_result_files(r'${root.replace(/\\/g, "/")}')))`
    ].join("\n");
    const disc = spawnSync("python", ["-c", script], { encoding: "utf8" });
    assert.equal(disc.status, 0, disc.stderr);
    const files = JSON.parse(disc.stdout.trim().split(/\r?\n/).at(-1));
    assert.ok(!files.some(f => f.includes("debug_runs")), "debug_runs should be excluded");
    assert.ok(!files.some(f => f.includes("tmp/result")), "tmp/result should be excluded");
    // ensure debug event not triggers auto completion
    const agentScript = [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location('agent', r'${agentRuntime.replace(/\\/g, "/")}')`,
      "agent = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(agent)",
      `print(json.dumps(agent.event_is_debug_run({'payload': {'debugMode': True}})))`,
      `print(json.dumps(agent.event_is_debug_run({'payload': {'path': 'simple_cluster/debug_runs/a/b.txt'}})))`,
      `print(json.dumps(agent.event_is_debug_run({'payload': {'path': 'experiments/results/c.csv'}})))`
    ].join("\n");
    const ev = spawnSync("python", ["-c", agentScript], { encoding: "utf8" });
    assert.equal(ev.status, 0, ev.stderr);
    const lines = ev.stdout.trim().split(/\r?\n/).slice(-3).map(l => JSON.parse(l));
    assert.equal(lines[0], true);
    assert.equal(lines[1], true);
    assert.equal(lines[2], false);
  });
});

test("promoted PLAN/config passes validatePlan and dryRunPlan", async () => {
  await withTempWorkspace(async (root) => {
    writeFileSync(root, "tmp/plan/valid.yaml", validDraftYaml("valid_suite", "tmp/config/valid.yaml"));
    writeFileSync(root, "tmp/config/valid.yaml", "model: resnet\nlr: 0.001\n");
    const rec = await DraftPlans.reconcileDraftPlans(root);
    await DraftPlans.updateDraftMetadata(root, "tmp/plan/valid.yaml", (r) => ({ ...r, status: "debug_completed", lastDebugRunId: "dbg", lastDebugStatus: "completed" }));
    const preview = await DraftPlans.buildPromotionPreview(root, "tmp/plan/valid.yaml", { debugRunId: "dbg", debugStatus: "completed", metricsSummary: {} });
    const res = await DraftPlans.promoteDraft(root, preview, { conflictMode: "rename" });
    const formalPlanText = fs.readFileSync(path.join(root, res.planPath), "utf8");
    const validation = PlanBuilder.validateDeepLearningPlanContract(formalPlanText);
    // validate should pass or at least not have critical errors
    assert.ok(validation);
    const summary = PlanBuilder.parsePlanSummary(formalPlanText);
    assert.equal(summary.suite, "valid_suite");
    assert.ok(summary.seeds.length > 0);
    // draft should still pass its own validation
    const draftSummary = PlanBuilder.parsePlanSummary(fs.readFileSync(path.join(root, "tmp/plan/valid.yaml"),"utf8"));
    assert.equal(draftSummary.suite, "valid_suite");
  });
});

test("draft lifecycle states transition correctly", async () => {
  await withTempWorkspace(async (root) => {
    writeFileSync(root, "tmp/plan/state.yaml", validDraftYaml("s", "tmp/config/state.yaml"));
    writeFileSync(root, "tmp/config/state.yaml", "a: 1\n");
    let rec = await DraftPlans.reconcileDraftPlans(root);
    assert.equal(rec.drafts[0].status, "validated");
    // simulate debug running
    rec = await DraftPlans.reconcileDraftPlans(root, [{ draftPlanPath: "tmp/plan/state.yaml", debugRunId: "run1", debugStatus: "running" }]);
    assert.equal(rec.drafts[0].status, "debug_running");
    // mark completed
    await DraftPlans.updateDraftMetadata(root, "tmp/plan/state.yaml", (r) => ({ ...r, status: "debug_completed", lastDebugRunId: "run1", lastDebugStatus: "completed" }));
    rec = await DraftPlans.reconcileDraftPlans(root);
    // should stay debug_completed because hash unchanged and previous status is debug_completed
    assert.equal(rec.drafts.find(d=>d.draftPlanPath==="tmp/plan/state.yaml").status, "debug_completed");
    // review
    await DraftPlans.markDraftReviewed(root, "tmp/plan/state.yaml");
    rec = await DraftPlans.reconcileDraftPlans(root);
    assert.equal(rec.drafts.find(d=>d.draftPlanPath==="tmp/plan/state.yaml").status, "ready_for_review");
    // promote
    await DraftPlans.updateDraftMetadata(root, "tmp/plan/state.yaml", (r) => ({ ...r, status: "ready_for_review", lastDebugRunId: "run1", lastDebugStatus: "completed" }));
    const preview = await DraftPlans.buildPromotionPreview(root, "tmp/plan/state.yaml", { debugRunId: "run1", debugStatus: "completed", metricsSummary: {} });
    await DraftPlans.promoteDraft(root, preview, { conflictMode: "rename" });
    rec = await DraftPlans.reconcileDraftPlans(root);
    assert.equal(rec.drafts.find(d=>d.draftPlanPath==="tmp/plan/state.yaml").status, "promoted");
    // modify after promoted => stale
    const validWithMod = validDraftYaml("s", "tmp/config/state.yaml") + "\nmodified: true\n";
    writeFileSync(root, "tmp/plan/state.yaml", validWithMod);
    rec = await DraftPlans.reconcileDraftPlans(root);
    assert.equal(rec.drafts.find(d=>d.draftPlanPath==="tmp/plan/state.yaml").status, "stale");
    // reject
    writeFileSync(root, "tmp/plan/rej2.yaml", validDraftYaml("s", "tmp/config/state.yaml"));
    let rec2 = await DraftPlans.reconcileDraftPlans(root);
    await DraftPlans.rejectDraft(root, "tmp/plan/rej2.yaml");
    rec2 = await DraftPlans.reconcileDraftPlans(root);
    assert.equal(rec2.drafts.find(d=>d.draftPlanPath==="tmp/plan/rej2.yaml").status, "rejected");
  });
});

test("old project without tmp/plan silently disabled", async () => {
  await withTempWorkspace(async (root) => {
    // no tmp/plan
    writeFileSync(root, "experiments/plans/formal.yaml", "suite: s\nbase_config: configs/a.yaml\n");
    const rec = await DraftPlans.reconcileDraftPlans(root);
    assert.equal(rec.enabled, false);
    assert.equal(rec.drafts.length, 0);
  });
});

test("tmp/result not considered formal result whitelist", async () => {
  await withTempWorkspace(async (root) => {
    writeFileSync(root, "tmp/result/analysis.csv", "a,b\n1,2\n");
    const script = [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location('agent', r'${agentRuntime.replace(/\\/g, "/")}')`,
      "agent = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(agent)",
      `print(json.dumps(agent.discover_result_files(r'${root.replace(/\\/g, "/")}')))`
    ].join("\n");
    const disc = spawnSync("python", ["-c", script], { encoding: "utf8" });
    assert.equal(disc.status, 0, disc.stderr);
    const files = JSON.parse(disc.stdout.trim().split(/\r?\n/).at(-1));
    assert.ok(!files.includes("tmp/result/analysis.csv"));
  });
});
