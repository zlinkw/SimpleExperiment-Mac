// r10（错误3）：completedJob 当前来源与他端历史副本分类——真实 CompletedJobHost→merge 夹具。
// 已证事实（宿主 2026-10-24 14:19Z 只读 metadata 快照，request SHA 9d4c8d68…，
// /host/d/OpenChamber-AgentConfig/Pi/host-sandbox/diagnostics/artifact-metadata-cde58e21-4e10-4455-b02f-a7290136032e/）：
// 3 个 summation job 各 9 条报错路径在真实 source nwpu3 全部 present=0，nwpu2/nwpu5 各 8、jqg_zlk 各 9，
// 他端 sha 跨端点一致、无 unverified。分类只按 scoped 真实状态，不靠文件名/备份目录规则。
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { OUT, H, V1, completedJobEntry, jobArtifactRunGeneration } = require("./jobArtifactStagedSlot.support.cjs");

const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const FH = { one: sha("foreign-one"), two: sha("foreign-two"), three: sha("foreign-three") };
const row = sha256 => ({ sha256, size: 4, modifiedAtMs: 9 });

// 正例：他端独有路径用任意普通文件名（不含备份命名模式），同样只按来源归属分类。
test("r10: foreign-only paths stay untouched, current artifacts sync, and the identity input excludes them", async () => {
  const F1 = `${OUT}/old_metrics_archive/metrics_case.csv`;
  const F2 = `${OUT}/run1_eval.README.md`;
  const entry = completedJobEntry(V1, { foreign: { b: { [F1]: row(FH.one), [F2]: row(FH.two) } } });
  const { report, transfers, jobs, inventory } = await entry.runWithReport();
  assert.deepEqual([...report.errors], []); assert.equal(report.synced, 1);
  const moved = [...new Set(transfers.flatMap(t => t.relativePaths))].sort();
  assert.deepEqual(moved, Object.keys(V1).sort(), "只有当前来源产物进入传输");
  assert.ok(!moved.includes(F1) && !moved.includes(F2), "foreign-only 路径不得进入 fpsync");
  // 两链身份摘要只含本次真正当前 source 完整已校验清单（不含 foreign-only）。
  assert.equal(transfers[0].generation, jobArtifactRunGeneration("plan", "command0",
    { [`${OUT}/model.pth`]: H.alpha, [`${OUT}/run.log`]: H.beta, [`${OUT}/artifact_manifest.json`]: H.beta }));
  assert.deepEqual(Object.keys(jobs[0].artifacts || {}).sort(), Object.keys(V1).sort(), "queue.artifacts 不含 foreign-only");
  const skipped = [...(jobs[0].latestArtifactSync.skipped || [])].sort();
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every(t => /：仅存在于其它端点的历史副本（来源 a 没有该版本），未同步、未修改、未删除。$/.test(t)), JSON.stringify(skipped));
  assert.ok(skipped.some(t => t.startsWith(F1)) && skipped.some(t => t.startsWith(F2)));
  // 旧路径留存：b 上原样、不拉回 a、不删除；成功含义=当前来源域全镜像。
  assert.equal(inventory.b[F1].sha256, FH.one); assert.equal(inventory.b[F2].sha256, FH.two);
  assert.ok(!inventory.a[F1] && !inventory.a[F2]);
  assert.deepEqual([...jobs[0].mirroredWorkerIds], ["a", "b"]);
  assert.equal(jobs[0].latestArtifactSync.state, "synced");
});

// 27 条真实快照事实参数化：逐 job 固定分类断言（present 矩阵与真实 sha 来自宿主只读快照）。
const SNAP_BASE = "work_dirs/quality_composition/all_low_quality_min_integer_gap/final/summation";
const SNAPSHOTS = {
  2: { dir: "2_summation_bus_p100_seed44", rows: [
    [".training_outputs_before_quality_f2617f29643a460194de972d9a3c1269/artifact_manifest.json", "b926b5371090c9fbbb5e32ba4a55e421c1b1893b26edec9fa6d197426a1b4dcc", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_f2617f29643a460194de972d9a3c1269/config_snapshot.yaml", "ebb8a4b78cd59c7ee53ff815ad0e77f1ccff20bec8c8dae7ffd55f2d7688cb4a", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_f2617f29643a460194de972d9a3c1269/env_snapshot.json", "81e2297322f3a0db25619bb739c580b895f0fd3d165505eba22b2c1964ce8711", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_f2617f29643a460194de972d9a3c1269/metrics_case.csv", "3c6c918c6d71ba47c1e5f195aa10e126de05fee2a40fd70b5234b89fcf44340d", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_f2617f29643a460194de972d9a3c1269/metrics_case.README.md", "3892f15595141fc77254e96d2721492268f0b535980e28101eb95fd6aaf4558a", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_f2617f29643a460194de972d9a3c1269/metrics_summary.csv", "59b9d36f4d567ea77917f878aff12390721ab7e29e8819326f32dce9134075e9", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_f2617f29643a460194de972d9a3c1269/metrics_summary.README.md", "bd5aab525e24acd6ca2445e6f4456431061a333e2c6d9a3770ffe50218da74ed", ["nwpu2", "nwpu5", "jqg_zlk"]],
    ["tb_logs/events.out.tfevents.1792350356.pytorch-a24664d6-l7vfx.1335289.0", "14f5902403ab0dd3a259cb85b0b67da0b6fa2cf2d5852ed4fb53619b9bfc4adb", ["nwpu2", "nwpu5", "jqg_zlk"]],
    ["test_results/.job_metrics.csv.484d68081e144207834899e07d7be74a.pending", "7c0add189401dbb8d366b8324a6c7349da2b9264a347c3d64fec794cdd85ba4e", ["jqg_zlk"]],
  ] },
  3: { dir: "3_summation_pad_p100_seed42", rows: [
    [".training_outputs_before_quality_658117e67ca04771bcd2f6be069417d8/artifact_manifest.json", "57b8b3ff74bac94c72e27c86a9c66716f071332ddd3d92d056ced73afc4af8f5", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_658117e67ca04771bcd2f6be069417d8/config_snapshot.yaml", "dcd2fce71e59f86777b905d5874e30c8a5c7ba3e36dda5b61b385fd1ea71d73b", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_658117e67ca04771bcd2f6be069417d8/env_snapshot.json", "4d254743458c101dc193517e9b1a6b9d90b9f919a2021c024f242d17ffbd28af", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_658117e67ca04771bcd2f6be069417d8/metrics_case.csv", "3c6c918c6d71ba47c1e5f195aa10e126de05fee2a40fd70b5234b89fcf44340d", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_658117e67ca04771bcd2f6be069417d8/metrics_case.README.md", "3892f15595141fc77254e96d2721492268f0b535980e28101eb95fd6aaf4558a", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_658117e67ca04771bcd2f6be069417d8/metrics_summary.csv", "c741e2a61fea6a64694dc211af75fafdaffecfae44c22028fb35726785adc3ac", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_658117e67ca04771bcd2f6be069417d8/metrics_summary.README.md", "bd5aab525e24acd6ca2445e6f4456431061a333e2c6d9a3770ffe50218da74ed", ["nwpu2", "nwpu5", "jqg_zlk"]],
    ["tb_logs/events.out.tfevents.1792350358.pytorch-a24664d6-l7vfx.1335456.0", "806b82a007d68ffb83121e5c5b4ebe76563e6c773b3b269e47cbc3f03e404fa8", ["nwpu2", "nwpu5", "jqg_zlk"]],
    ["test_results/.job_metrics.csv.63dd4b3401c448ccbd14bc1bc1466ad4.pending", "10cc3ec4198be7d6598f369cbf51a354214958ec214f886323c1efd93dd92719", ["jqg_zlk"]],
  ] },
  5: { dir: "5_summation_pad_p100_seed44", rows: [
    [".training_outputs_before_quality_0670df9cf1e344ec99eb1f9dcb19c113/artifact_manifest.json", "e75dae7bae528238bbc1ad96f2aaa618068d6425f19e9426a5b136e2b82f6671", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_0670df9cf1e344ec99eb1f9dcb19c113/config_snapshot.yaml", "85846c6f0debc8559d73b186a252ce213a2b52e5d64501fa452938c589b0a983", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_0670df9cf1e344ec99eb1f9dcb19c113/env_snapshot.json", "3d1872364ff94cf5bac9d8dbcbd42a4cc7471f7effdb58b368b1ebf4e27cf05e", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_0670df9cf1e344ec99eb1f9dcb19c113/metrics_case.csv", "3c6c918c6d71ba47c1e5f195aa10e126de05fee2a40fd70b5234b89fcf44340d", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_0670df9cf1e344ec99eb1f9dcb19c113/metrics_case.README.md", "3892f15595141fc77254e96d2721492268f0b535980e28101eb95fd6aaf4558a", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_0670df9cf1e344ec99eb1f9dcb19c113/metrics_summary.csv", "ff0dd28a45661ffc018ef26b90f7b2db9a499cacc9b53e71b1e47612b907ccaf", ["nwpu2", "nwpu5", "jqg_zlk"]],
    [".training_outputs_before_quality_0670df9cf1e344ec99eb1f9dcb19c113/metrics_summary.README.md", "bd5aab525e24acd6ca2445e6f4456431061a333e2c6d9a3770ffe50218da74ed", ["nwpu2", "nwpu5", "jqg_zlk"]],
    ["tb_logs/events.out.tfevents.1792350564.pytorch-a24664d6-l7vfx.1344176.0", "977d0223711f606d18e19917b8eaab866110ad20f24a029f1b7323f3a37e19f0", ["nwpu2", "nwpu5", "jqg_zlk"]],
    ["test_results/.job_metrics.csv.29c84c6194d84310a9f2a43ddb323f70.pending", "a898bfa0e54f74cb6f5ad00e714b586d76f8b54c0431fd866c5e6da23b4e293d", ["jqg_zlk"]],
  ] },
};

test("r10: the 27 real error paths classify exactly as foreign-only against the snapshot presence matrix", async () => {
  for (const [jobIndex, fact] of Object.entries(SNAPSHOTS)) {
    const dir = `${SNAP_BASE}/${fact.dir}`;
    const ids = ["nwpu3", "nwpu2", "nwpu5", "jqg_zlk"];
    const current = {
      [`${dir}/test_results/metrics.csv`]: { sha256: sha(`cur-${jobIndex}`), content: "cur" },
      [`${dir}/artifact_manifest.json`]: { sha256: sha(`man-${jobIndex}`), content: "man" },
    };
    const foreign = {};
    for (const [rel, digest, eps] of fact.rows) for (const ep of eps)
      (foreign[ep] ||= {})[`${dir}/${rel}`] = { sha256: digest, size: 8, modifiedAtMs: 5 };
    const entry = completedJobEntry(current, { ids, foreign, job: { workerId: "nwpu3", outputDir: dir } });
    const { report, transfers, jobs, inventory } = await entry.runWithReport();
    assert.deepEqual([...report.errors], [], `job ${jobIndex}`); assert.equal(report.synced, 1, `job ${jobIndex}`);
    const moved = [...new Set(transfers.flatMap(t => t.relativePaths))].sort();
    assert.deepEqual(moved, Object.keys(current).sort(), `job ${jobIndex}：只传当前来源产物`);
    const expectedSkipped = fact.rows.map(([rel]) => `${dir}/${rel}`).sort();
    const skipped = [...(jobs[0].latestArtifactSync.skipped || [])];
    assert.equal(skipped.length, 9, `job ${jobIndex}：每条报错路径恰好分类一次`);
    assert.deepEqual([...skipped].map(t => t.split("：")[0]).sort(), expectedSkipped, `job ${jobIndex}`);
    assert.deepEqual(Object.keys(jobs[0].artifacts || {}).sort(), Object.keys(current).sort(), `job ${jobIndex}：摘要/队列产物不含 foreign-only`);
    assert.equal(transfers[0].generation, jobArtifactRunGeneration("plan", "command0",
      Object.fromEntries(Object.entries(current).map(([f, i]) => [f, i.sha256]))), `job ${jobIndex}：身份输入=当前源清单`);
    for (const [rel, digest, eps] of fact.rows) for (const ep of eps)
      assert.equal(inventory[ep][`${dir}/${rel}`].sha256, digest, "他端历史副本原样留存");
    assert.ok(!inventory.a && !jobs[0].artifacts[`${dir}/${fact.rows[0][0]}`], "不拉回、不记录 foreign-only");
    assert.deepEqual([...jobs[0].mirroredWorkerIds], ids);
  }
});

test("r10 counter: required job.artifacts entries stay blocking; out-of-scope entries are not imposed", async () => {
  const F = `${OUT}/old/archive_eval.jsonl`;
  const e1 = completedJobEntry(V1, { foreign: { b: { [F]: row(FH.one) } }, job: { artifacts: { [F]: FH.one } } });
  const r1 = await e1.runWithReport();
  assert.equal(r1.transfers.length, 0); assert.equal(r1.report.synced, 0);
  assert.match(r1.report.errors[0], /本次已记录必要产物在当前来源没有已校验版本/);
  assert.equal(r1.jobs[0].latestArtifactSync.state, "partial");
  assert.ok(!r1.jobs[0].mirroredWorkerIds && !r1.jobs[0].latestArtifactSync.skipped);
  // 必要项在当前来源有已校验版本、内容较旧记录更新 → 维持 r5 源漂移重同步语义：开新代、
  // 真实重传、patch 合并更新记录；本轮仍受本次冻结清单+复制后 SHA 复核约束（见 latestSync 既有套件）。
  const e2 = completedJobEntry(V1, { foreign: { b: { [F]: row(FH.one) } }, job: { artifacts: { [`${OUT}/model.pth`]: H.gamma } } });
  const r2 = await e2.runWithReport();
  assert.equal(r2.report.synced, 1, JSON.stringify(r2.report.errors));
  assert.equal(r2.jobs[0].artifacts[`${OUT}/model.pth`], H.alpha, "重同步后记录更新为当前来源已校验版本");
  assert.equal(r2.transfers[0].generation, jobArtifactRunGeneration("plan", "command0",
    { [`${OUT}/model.pth`]: H.alpha, [`${OUT}/run.log`]: H.beta, [`${OUT}/artifact_manifest.json`]: H.beta }));
  assert.ok(!r2.jobs[0].artifacts[F]);
  // 落在选定 scope 之外的已记录条目不强加到本 job。
  const e3 = completedJobEntry(V1, { foreign: { b: { [F]: row(FH.one) } }, job: { artifacts: { "other_plan/job9/model.pth": FH.two } } });
  const r3 = await e3.runWithReport();
  assert.equal(r3.report.synced, 1, JSON.stringify(r3.report.errors));
  assert.equal(r3.jobs[0].artifacts["other_plan/job9/model.pth"], FH.two, "既有队列记录原样保留（host 合并语义不变）");
});

test("r10 counter: empty source domain or a selected CSV present only elsewhere stays partial, never synced/mirrored", async () => {
  // 选定目录没有任何当前来源可同步文件（只有 foreign-only 行）→ partial。
  const F = `${OUT}/old/legacy.csv`;
  const r1 = await completedJobEntry({}, { foreign: { b: { [F]: row(FH.one) } } }).runWithReport();
  assert.equal(r1.report.synced, 0); assert.equal(r1.transfers.length, 0);
  assert.match(r1.report.errors[0], /当前来源在该选定范围内没有已校验产物文件/);
  assert.equal(r1.jobs[0].latestArtifactSync.state, "partial"); assert.ok(!r1.jobs[0].mirroredWorkerIds);
  // 明确选定的文件/CSV 只存在于他端：不得用同目录其它文件冒充——仍 partial。
  const CSV = `${OUT}/results/res.csv`;
  const e2 = completedJobEntry(V1, { foreign: { b: { [CSV]: row(FH.one) } } });
  const r2 = await e2.runWithReport([CSV]);
  assert.equal(r2.report.synced, 0); assert.equal(r2.transfers.length, 0);
  assert.match(r2.report.errors[0], /当前来源在该选定范围内没有已校验产物文件/);
  assert.equal(r2.jobs[0].latestArtifactSync.state, "partial"); assert.ok(!r2.jobs[0].mirroredWorkerIds);
  // 无 scope 仍原 excluded（不进分类）。
  const r3 = await completedJobEntry(V1, {}).runWithReport(["unrelated_dir"]);
  assert.equal(r3.report.excluded, 1); assert.equal(r3.jobs[0].latestArtifactSync.state, "excluded");
});

test("r10 preserved blocks: unverified rows, inventory failure, codeOwned, foreign conflict and frozen source protection still block", async () => {
  const F1 = `${OUT}/old/unverified.jsonl`;
  const e1 = completedJobEntry(V1, { foreign: { b: { [F1]: row(FH.one) } }, unverified: { b: { [F1]: "清单读取中断" } } });
  const r1 = await e1.runWithReport();
  assert.equal(r1.report.synced, 0); assert.match(r1.report.errors[0], /版本未校验/);
  assert.equal(r1.jobs[0].latestArtifactSync.state, "partial");
  // 清单失败（端点报错）仍整体 fail-closed。
  const r2 = await completedJobEntry(V1, { inventoryError: "nwpu2: 连接中断" }).runWithReport();
  assert.equal(r2.report.synced, 0); assert.match(r2.report.errors[0], /连接中断/);
  assert.equal(r2.jobs[0].latestArtifactSync.state, "partial");
  // 本机代码归属冲突不被分类放行。
  const F2 = `${OUT}/old/code_owned.jsonl`;
  const r3 = await completedJobEntry(V1, { foreign: { b: { [F2]: row(FH.one) } }, codeOwned: [F2] }).runWithReport();
  assert.equal(r3.report.synced, 0); assert.match(r3.report.errors[0], /没有可靠的最新版/);
  // 他端内容冲突（无法判定版本）不凭空放行。
  const F3 = `${OUT}/old/conflict.jsonl`;
  const r4 = await completedJobEntry(V1, { ids: ["a", "b", "c"], foreign: { b: { [F3]: row(FH.one) }, c: { [F3]: row(FH.two) } } }).runWithReport();
  assert.equal(r4.report.synced, 0); assert.match(r4.report.errors[0], /没有可靠的最新版/);
  assert.equal(r4.jobs[0].latestArtifactSync.state, "partial");
  // 本操作冻结机器状态映射（来源）∩ foreign-only → 仍显式阻断，不放行。
  const F4 = `${OUT}/old/protected.jsonl`;
  const e5 = completedJobEntry(V1, { foreign: { b: { [F4]: row(FH.one) } },
    freezeGuard: t => (t.id === "a" ? { prefixes: [`${OUT}/old`], unknown: false } : { prefixes: [], unknown: false }) });
  const r5 = await e5.runWithReport();
  assert.equal(r5.report.synced, 0); assert.equal(r5.transfers.length, 0);
  assert.match(r5.report.errors[0], /没有可靠的最新版/);
  assert.equal(r5.jobs[0].latestArtifactSync.state, "partial"); assert.ok(!r5.jobs[0].mirroredWorkerIds);
});

test("r10: all-targets-already-consistent succeeds via the source file set, and the generic manual merge keeps blocking foreign rows", async () => {
  const F = `${OUT}/old/keep.csv`;
  const entry = completedJobEntry(V1, { foreign: { b: { [F]: row(FH.one) } }, mirrorFiles: Object.keys(V1) });
  const r = await entry.runWithReport();
  assert.deepEqual([...r.report.errors], []); assert.equal(r.report.synced, 1);
  assert.equal(r.transfers.length, 0, "已有全部目标一致（无 work delta）必须能成功，不算无文件失败");
  assert.match(r.jobs[0].latestArtifactSync.skipped[0], /仅存在于其它端点的历史副本/);
  // 通用手动合并（非 completedJob）语义原样——分类与放行只作用于 completedJob 分支：他端内容冲突的
  // 路径在手动链仍进 skipped→errors（本次改动不外溢；无 delta 时不会进入确认/传输步骤）。
  const conflicting = completedJobEntry(V1, { ids: ["a", "b", "c"], mirrorFiles: Object.keys(V1),
    foreign: { b: { [F]: row(FH.one) }, c: { [F]: row(FH.two) } } });
  const manual = await conflicting.h.mergeLatestWorkerVersions(conflicting.root, conflicting.h.workerCodeSyncTargets(), [OUT], ".", () => {}, {});
  assert.equal(manual.completed.length, 0);
  assert.ok(manual.errors.some(t => t.includes(F) && t.includes("没有可靠的最新版")), JSON.stringify(manual.errors));
});


test("r38: source temporary publication files do not become machine-state failures or artifact receipts", async () => {
  const temporary = [
    `${OUT}/test_results/.job_metrics.csv.0ac809074e1a49a0829d79136a5146a9.pending`,
    `${OUT}/test_results/metrics.csv.writing`,
    `${OUT}/test_results/metrics.tmp.123`,
    `${OUT}/test_results/metrics.upload.123`,
  ];
  const files = { ...V1, ...Object.fromEntries(temporary.map(file => [file, { sha256: H.alpha, content: "alpha" }])) };
  for (const verifyOnly of [false, true]) {
    const entry = completedJobEntry(files, verifyOnly ? { mirrorFiles: Object.keys(V1) } : {});
    const { report, transfers, jobs, inventory } = await entry.runWithReport([OUT], { force: true, verifyOnly });
    assert.deepEqual([...report.errors], [], `verifyOnly=${verifyOnly}: temporary exclusions are not machine-state protection`);
    assert.equal(report.synced, 1);
    assert.equal(jobs[0].status, "completed", "artifact filtering cannot reinterpret job execution state");
    assert.equal(jobs[0].latestArtifactSync.state, "synced");
    assert.deepEqual(Object.keys(jobs[0].artifacts || {}).sort(), Object.keys(V1).sort());
    assert.ok(!Object.values(jobs[0].latestArtifactSync).some(value => String(value).includes("机器状态映射均保护")));
    for (const file of temporary) {
      assert.equal(inventory.a[file].sha256, H.alpha, "source temporary files remain untouched");
      assert.equal(inventory.b[file], undefined, "temporary files are never transmitted");
    }
    if (verifyOnly) assert.equal(transfers.length, 0, "refresh-only does not transfer");
    else {
      assert.deepEqual([...new Set(transfers.flatMap(t => t.relativePaths))].sort(), Object.keys(V1).sort());
      assert.equal(transfers[0].generation, jobArtifactRunGeneration("plan", "command0",
        Object.fromEntries(Object.entries(V1).map(([file, item]) => [file, item.sha256]))));
    }
  }
});
