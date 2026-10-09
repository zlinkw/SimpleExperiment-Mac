const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "check-static.js");

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// MultiModal 合规基线 plan：train 双写规范 + test 双写 + 双 csv + 双 log + 大表 + 快照
function goodPlan(suite) {
  return [
    `suite: ${suite}`,
    "mode: train_test",
    "base_config: configs/base.yaml",
    "seeds: [0, 1]",
    "naming:",
    "  sweep_dir: work_dirs/baseline",
    '  job_name: "{index}_{case}_seed{seed}"',
    "paper:",
    '  result_csv: "{output_dir}/metrics_summary.csv"',
    "runner:",
    '  train_command: "python train.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}"',
    '  test_command: "python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed} --result-csv {result_csv}"',
    "expectedResults:",
    '  - "{output_dir}/metrics_summary.csv"',
    '  - "{output_dir}/metrics_case.csv"',
    "  - experiments/results/demo.csv",
    "# 产物： metrics_summary.csv metrics_case.csv stdout.log stderr.log env_snapshot.json config_snapshot.yaml",
    "cases:",
    "  - name: smoke",
    "  - name: public",
    "",
  ].join("\n");
}

function runCheck(projectDir, extraArgs = []) {
  try {
    const out = execFileSync("node", [SCRIPT, "--project", projectDir, "--json", ...extraArgs], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (err) {
    const stdout = String((err && err.stdout) || "");
    // 失败退出码仍带 JSON（process.exitCode=1 但 stdout 完整）
    const idx = stdout.indexOf("{");
    if (idx >= 0) return JSON.parse(stdout.slice(idx));
    throw err;
  }
}

function runCheckText(projectDir) {
  try {
    return execFileSync("node", [SCRIPT, "--project", projectDir], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    return String((err && err.stdout) || "");
  }
}

test("0回归门：EXCLUDE/双条件/train聚合/suite去重", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs0-"));
  write(path.join(dir, "configs", "base.yaml"), "lr: 0.01\n");
  // EXCLUDE 目录下的 plan 不应被计入
  write(path.join(dir, "work_dirs", "plan_evil.yaml"), "suite: evil\n");
  write(path.join(dir, "tmp", "plan_evil2.yaml"), "suite: evil2\n");
  // train_only 无 test_command：双条件不触发 + 聚合为 info（无 project wrapper 时为 info）
  write(path.join(dir, "experiments", "plans", "train_only.yaml"), [
    "suite: t1",
    "mode: train",
    "base_config: configs/base.yaml",
    "seeds: [0]",
    "cases:",
    "  - name: a",
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir}" }',
    "# 产物： metrics_summary.csv metrics_case.csv stdout.log stderr.log env_snapshot.json config_snapshot.yaml",
    "",
  ].join("\n"));
  const report = runCheck(dir);
  assert.equal(report.summary.plans, 1, "EXCLUDE 目录必须排除");
  const ids = [...report.errors.map((e) => e.id), ...report.infos.map((i) => i.id)];
  assert.ok(!ids.includes("test_command_missing_result_csv"), "train plan 不应触发 test 双条件");
  assert.ok(report.infos.some((i) => i.id === "output_interface_train_only"), "train_only 应聚合为 info");
  // suite 缺失去重升级：warning 去掉、critical 唯一
  write(path.join(dir, "experiments", "plans", "nosuite.yaml"), [
    "mode: train",
    "base_config: configs/base.yaml",
    "seeds: [0]",
    "cases:",
    "  - name: a",
    "",
  ].join("\n"));
  const r2 = runCheck(dir);
  const suiteErrs = r2.errors.filter((e) => e.id === "suite_missing");
  assert.equal(suiteErrs.length, 1, "suite_missing 去重后唯一");
  assert.ok(!r2.warnings.some((w) => w.id === "suite"), "suite legacy warning 应被去重");
});

test("G1强升级：6类缺失为critical且同file+id去重", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs1-"));
  write(path.join(dir, "experiments", "plans", "bad.yaml"), [
    "suite: bad",
    "mode: evil_mode",
    "seeds: []",
    "cases: []",
    "# 无 base_config，无命令",
    "",
  ].join("\n"));
  const r = runCheck(dir);
  for (const id of ["mode_invalid", "seeds_empty", "cases_empty", "base_config_missing", "train_command_missing", "test_command_missing"]) {
    assert.ok(r.errors.some((e) => e.id === id), `缺 ${id}`);
    assert.equal(r.errors.filter((e) => e.id === id).length, 1, `${id} 去重唯一`);
  }
  // base_config 指向不存在文件
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cs1b-"));
  write(path.join(dir2, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: train", "base_config: configs/nope.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir}" }',
    "",
  ].join("\n"));
  const r3 = runCheck(dir2);
  assert.ok(r3.errors.some((e) => e.id === "base_config_not_found"), "base_config 不存在应 critical");
});

test("G2模板变量：白名单外warning去重/双分隔符放行/train直写大表critical", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs2-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), [
    "suite: s",
    "mode: train_test",
    "base_config: configs/base.yaml",
    "seeds: [0]",
    "cases:", "  - name: a",
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir} --foo {mystery} --bar {mystery} --ok ${HOME} --tpl {{mystery}}" }',
    'test_command: "python test.py --config {config} --output-dir {output_dir} --result-csv {result_csv}"',
    "# 产物： metrics_summary.csv metrics_case.csv stdout.log stderr.log env_snapshot.json config_snapshot.yaml",
    "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
    "  - experiments/results/m.csv",
    "",
  ].join("\n"));
  const r = runCheck(dir);
  assert.equal(r.warnings.filter((w) => w.id === "template_unknown_variable").length, 1, "未知变量去重唯一且双分隔符放行");
  // train 直写大表
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cs2b-"));
  write(path.join(dir2, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir2, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: train", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir} --result-csv {result_csv}" }',
    "",
  ].join("\n"));
  const r2 = runCheck(dir2);
  assert.ok(r2.errors.some((e) => e.id === "template_train_writes_big_table"), "train 直写大表应 critical");
});

test("G3+G4输出契约：双csv双log/大表critical/快照warning/剥注释/单声明不过", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs34-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: test", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    "# metrics_summary.csv metrics_case.csv stdout.log stderr.log（全在注释里，不算数）",
    'paper: { result_csv: "{output_dir}/foo.csv" }',
    "expectedResults:", '  - "{output_dir}/foo.csv"',
    'runner: { test_command: "python test.py --config {config}" }',
    "",
  ].join("\n"));
  const r = runCheck(dir);
  for (const id of ["output_contract_missing_summary_csv", "output_contract_missing_case_csv", "output_contract_missing_stdout_log", "output_contract_missing_stderr_log", "output_contract_missing_big_table", "output_contract_declaration_only"]) {
    assert.ok(r.errors.some((e) => e.id === id), `缺 ${id}`);
    assert.equal(r.errors.filter((e) => e.id === id).length, 1, `${id} 去重唯一（同 file::severity::id::message 去重，case_schema/unanchored 同路径）`);
  }
  assert.ok(r.warnings.some((w) => w.id === "output_contract_missing_env_snapshot"), "快照缺只 warning");
  assert.ok(r.warnings.some((w) => w.id === "output_contract_missing_config_snapshot"), "快照缺只 warning");
  // test_command 经注入降级：缺 --result-csv 但同 plan 含 paper.result_csv + expectedResults 大表 → warning，不报 critical
  const dirVia = fs.mkdtempSync(path.join(os.tmpdir(), "cs34via-"));
  write(path.join(dirVia, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dirVia, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: test", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    'paper: { result_csv: "{output_dir}/metrics_summary.csv" }',
    "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
    "  - experiments/results/m.csv",
    'runner: { test_command: "python test.py --config {config} --output-dir {output_dir}" }',
    "# 产物： metrics_summary.csv metrics_case.csv stdout.log stderr.log env_snapshot.json config_snapshot.yaml",
    "",
  ].join("\n"));
  const rVia = runCheck(dirVia);
  assert.ok(rVia.warnings.some((w) => w.id === "test_command_via_injection"), "注入路径应降 warning(test_command_via_injection)");
  assert.ok(!rVia.errors.some((e) => e.id === "test_command_missing_result_csv"), "注入路径不报 critical");
  // D1 直接合并：同 plan 已报 test_command_via_injection 时 big_table_via_injection 直接 suppress（不落 infos），仅保留主项 1 条 warning，findings 总数同步减少
  assert.ok(!rVia.infos.some((i) => i.id === "output_contract_big_table_via_injection"), "同 plan 有注入主项时大表直接 suppress，不落 infos");
  assert.ok(!rVia.warnings.some((w) => w.id === "output_contract_big_table_via_injection"), "合并后大表不再记 warning");
  assert.ok(rVia.warnings.some((w) => w.id === "test_command_via_injection"), "仅保留 test_command_via_injection 1 条 warning");
  // 无注入对照：缺 --result-csv 且无大表 → critical（不给 comparison 加参：签名仍为单 planText）
  const dirNo = fs.mkdtempSync(path.join(os.tmpdir(), "cs34no-"));
  write(path.join(dirNo, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dirNo, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: test", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    'runner: { test_command: "python test.py --config {config} --output-dir {output_dir}" }',
    "# 产物： metrics_summary.csv metrics_case.csv stdout.log stderr.log env_snapshot.json config_snapshot.yaml",
    "",
  ].join("\n"));
  const rNo = runCheck(dirNo);
  assert.ok(rNo.errors.some((e) => e.id === "test_command_missing_result_csv"), "无注入应报 critical");
});

test("G6结果Schema：8列/NaN/mapping不掩盖/无样例跳过", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs6-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), goodPlan("ok"));
  let r = runCheck(dir);
  assert.ok(!r.errors.some((e) => e.id.startsWith("result_schema_")), "无样例跳过");
  // 有样例：缺列 + NaN
  write(path.join(dir, "experiments", "samples", "metrics_summary.csv"), "experiment_id,suite,method,value\nE1,S,M,NaN\nE2,S,M,\n");
  write(path.join(dir, "experiments", "simple_project.yaml"), "outputs:\n  csvColumnMapping:\n    metric: metric\n    value: value\n");
  r = runCheck(dir);
  assert.ok(r.errors.some((e) => e.id === "result_schema_summary_missing_columns"), "summary 缺列 critical（mapping 不掩盖）");
  assert.ok(r.errors.some((e) => e.id === "result_schema_summary_bad_value"), "summary NaN/空 critical");
  // case 样例走独立 id（与 summary 不混淆、不误标 DUP）
  write(path.join(dir, "experiments", "samples", "metrics_case.csv"), "experiment_id,case_id,dataset,split,value\nE1,c1,cls,train,NaN\n");
  r = runCheck(dir);
  assert.ok(r.errors.some((e) => e.id === "result_schema_case_missing_columns"), "case 缺列 critical（缺 method，独立 id）");
  assert.ok(r.errors.some((e) => e.id === "result_schema_case_bad_value"), "case NaN critical（独立 id）");
  // 双收上限 10：12 个坏样例最多计入 10 个文件的缺列（防刷屏）
  const dirCap = fs.mkdtempSync(path.join(os.tmpdir(), "cs6cap-"));
  write(path.join(dirCap, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dirCap, "experiments", "plans", "p.yaml"), goodPlan("ok"));
  for (let i = 0; i < 12; i += 1) {
    write(path.join(dirCap, "experiments", "s" + i, "metrics_summary.csv"), "experiment_id,suite,method,value\nE1,S,M,NaN\nE2,S,M,\n");
  }
  const rCap = runCheck(dirCap);
  assert.equal(rCap.errors.filter((e) => e.id === "result_schema_summary_missing_columns").length, 10, "双收上限 10");
});

test("并发风险：<JOB>同文件/根写入critical", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs5-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: train_test", "base_config: configs/base.yaml", "seeds: [0, 1]",
    "cases:", "  - name: a", "  - name: b",
    "naming:", "  sweep_dir: work_dirs/base",
    '  job_name: "fixed <JOB>"',
    '  output_dir: "."',
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir}" }',
    'test_command: "python test.py --config {config} --output-dir {output_dir} --result-csv {result_csv}"',
    "",
  ].join("\n"));
  const r = runCheck(dir);
  assert.ok(r.errors.some((e) => e.id === "concurrency_job_placeholder"), "<JOB> 残留 critical");
  assert.ok(r.errors.some((e) => e.id === "concurrency_same_file"), "同文件 critical");
  assert.ok(r.errors.some((e) => e.id === "concurrency_root_write"), "根写入 critical");
});

test("G8 simple_project：版本/wrapper/扩展/别名/entrypoints", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs8-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), goodPlan("ok"));
  write(path.join(dir, "experiments", "simple_adapter", "run_wrapper.py"), "# ok\n");
  write(path.join(dir, "experiments", "simple_project.yaml"), [
    "projectName: demo",
    "primaryMetric: AUC",
    "simpleSftp: 0.1.0",
    "agentVersion: 0.0.0",
    "adapter:",
    "  runWrapper: experiments/simple_adapter/missing_wrapper.py",
    "entrypoints:",
    '  trainCommandTemplate: "{python} train.py --config {config} --output_dir {output_dir} --x {nope}"',
    '  testCommandTemplate: "{python} test.py --config {config} --checkpoint {checkpoint} --output_dir {output_dir}"',
    "outputs:",
    "  summaryCsv: metrics_summary.csv",
    "  candidateCsv:",
    '    - "{output_dir}/metrics_summary.csv"',
    "    - badfile.report",
    "  metricAliases:",
    "    acc: NotAMetric",
    "",
  ].join("\n"));
  const r = runCheck(dir);
  assert.ok(r.errors.some((e) => e.id === "simple_project_simplesftp_version"), "SimpleSFTP 低版本 critical");
  assert.ok(r.errors.some((e) => e.id === "simple_project_runwrapper_missing"), "runWrapper 缺失 critical");
  assert.ok(r.errors.some((e) => e.id === "simple_project_candidate_extension"), "候选扩展名 critical");
  assert.ok(r.errors.some((e) => e.id === "simple_project_entrypoint_unrenderable"), "entrypoints 不可渲染 critical");
  // tensorboard 无消费只 info：缺 tensorboardLogDirs 应为 info 而非 error/warning
  assert.ok(r.infos.some((i) => i.id === "simple_project_no_tensorboard"), "tensorboard 缺只 info");
  assert.ok(!r.errors.some((e) => e.id === "simple_project_no_tensorboard"), "tensorboard 不升级 critical");
  assert.ok(!r.warnings.some((w) => w.id === "simple_project_no_tensorboard"), "tensorboard 不再记 warning");
  // 版本门只认行首 5 字段：simpleSftp/agentVersion 永不触发 version_old，无匹配回退 info_undeclared
  assert.ok(![...r.errors, ...r.warnings].some((f) => f.id === "simple_project_version_old"), "simpleSftp/agentVersion 不触发 version_old");
  assert.ok(r.infos.some((i) => i.id === "simple_project_version_undeclared"), "无版本声明回退 info_undeclared");
  // python_version 同样永不触发版本门
  const dirPy = fs.mkdtempSync(path.join(os.tmpdir(), "cs8py-"));
  write(path.join(dirPy, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dirPy, "experiments", "plans", "p.yaml"), goodPlan("ok"));
  write(path.join(dirPy, "experiments", "simple_adapter", "run_wrapper.py"), "# ok\n");
  write(path.join(dirPy, "experiments", "simple_project.yaml"), [
    "projectName: demo",
    "python_version: 3.10.0",
    "",
  ].join("\n"));
  const rPy = runCheck(dirPy);
  assert.ok(![...rPy.errors, ...rPy.warnings].some((f) => f.id === "simple_project_version_old"), "python_version 不触发 version_old");
  assert.ok(rPy.infos.some((i) => i.id === "simple_project_version_undeclared"), "python_version 视同未声明 version");
});

test("G5双检路径+6根禁写占位跳过/scp禁令", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs5x-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: train", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    "naming:", '  job_name: "{index}_{case}_seed{seed}"',
    '  output_dir: "debug_runs/tmp"',
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir} --x {output_dir}" }',
    "log_file: /etc/passwd",
    "# 产物： metrics_summary.csv metrics_case.csv stdout.log stderr.log env_snapshot.json config_snapshot.yaml",
    "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
    "  - experiments/results/m.csv",
    "",
  ].join("\n"));
  const r = runCheck(dir);
  // 双检路径：绝对路径 /etc/passwd 经 isSafeRemotePath+safeRemoteProjectChild 双门 → critical
  assert.ok(r.errors.some((e) => /etc\/passwd/.test(e.path || e.message || "")), "双检路径应拦截 /etc/passwd");
  // 6 根禁写扩展：debug_runs 正式输出 → concurrency_debug_isolation critical
  assert.ok(r.errors.some((e) => e.id === "concurrency_debug_isolation"), "debug_runs 正式输出应 critical");
  // 占位跳过：{output_dir} 不应被当作路径候选（无 path={output_dir} 的误报）
  assert.ok(![...r.errors, ...r.warnings].some((f) => (f.path || "").includes("{")), "占位路径应跳过");
  // scp 禁令
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cs5scp-"));
  write(path.join(dir2, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir2, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: train", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    "naming:", '  job_name: "{index}_{case}_seed{seed}"',
    'runner: { train_command: "scp foo bar --config {config} --output-dir {output_dir}" }',
    "",
  ].join("\n"));
  const r2 = runCheck(dir2);
  assert.ok(r2.errors.some((e) => e.id === "plan_scp_forbidden"), "scp 明文应 critical");
});

test("G6单根禁scp/debug隔离 + G8并发job_name缺失", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs68-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: train", "base_config: configs/base.yaml", "seeds: [0, 1]",
    "cases:", "  - name: a", "  - name: b",
    "# 无 naming.job_name，多 job 应报缺失",
    'runner: { train_command: "python train.py --config {config} --output-dir work_dirs/s --case {case} --seed {seed}" }',
    "",
  ].join("\n"));
  write(path.join(dir, "experiments", "simple_project.yaml"), [
    "projectName: demo",
    "version: 0.4.2",
    "sync: scp up",
    "",
  ].join("\n"));
  const r = runCheck(dir);
  assert.ok(r.errors.some((e) => e.id === "concurrency_job_name_missing"), "多 job 缺 job_name 应 critical");
  assert.ok(r.errors.some((e) => e.id === "simple_project_scp_forbidden"), "simple_project scp 应 critical");
  // 好模板不报
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cs68ok-"));
  write(path.join(dir2, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir2, "experiments", "plans", "p.yaml"), goodPlan("ok"));
  const r2 = runCheck(dir2);
  assert.ok(!r2.errors.some((e) => e.id === "concurrency_job_name_missing"), "好模板不报 job_name 缺失");
});

test("G7绘图五文件存在+字段（无声明跳过）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs7-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  // 无声明跳过：goodPlan 不提 plotting → 无 plotting findings
  write(path.join(dir, "experiments", "plans", "p.yaml"), goodPlan("ok"));
  let r = runCheck(dir);
  assert.ok(![...r.errors, ...r.warnings].some((f) => String(f.id || "").startsWith("plotting_contract")), "无声明应跳过");
  // 有声明缺文件 → 5 个 warning（五文件）
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cs7m-"));
  write(path.join(dir2, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir2, "experiments", "plans", "myplan.yaml"), [
    "suite: s", "mode: train", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    "naming:", '  job_name: "{index}_{case}_seed{seed}"',
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir}" }',
    "outputs:",
    '  registry: "simple_cluster/results/result_registry.json"',
    '  stats: "simple_cluster/results/statistics.json"',
    "",
  ].join("\n"));
  r = runCheck(dir2);
  assert.equal(r.warnings.filter((w) => w.id === "plotting_contract_missing_file").length, 5, "缺五文件应 5 warnings");
  // 补齐五文件且字段合规 → warnings 消除
  const slug = "myplan";
  write(path.join(dir2, "simple_cluster", "results", "by_plan", slug, "result_registry.json"), JSON.stringify({ resultId: "r", experimentId: "e", suite: "s", method: "m", dataset: "d", split: "tr", fold: 0, seed: 0, metrics: {}, dimensions: [], sourceFiles: [] }));
  write(path.join(dir2, "simple_cluster", "results", "by_plan", slug, "statistics.json"), JSON.stringify({ suite: "s", metric: "acc", mean: 1, std: 0.1 }));
  write(path.join(dir2, "paper", "tables", `simple_results_table__${slug}.csv`), "method,dataset,split,metric,mean,std\nM,D,tr,acc,1,0.1\n");
  write(path.join(dir2, "simple_cluster", "results", "by_plan", slug, "case_level_index.json"), JSON.stringify([{ case_id: "c", method: "m", dataset: "d", split: "tr", metric: "acc", value: 1 }]));
  write(path.join(dir2, "simple_cluster", "datasets", "by_plan", slug, "profile.json"), JSON.stringify({ dataset: "d", split: "tr" }));
  r = runCheck(dir2);
  assert.ok(!r.warnings.some((w) => w.id === "plotting_contract_missing_file"), "补齐后无缺文件 warning");
  assert.ok(!r.errors.some((e) => e.id === "plotting_contract_bad_fields"), "字段合规无 critical");
  // 坏字段 → critical
  write(path.join(dir2, "simple_cluster", "results", "by_plan", slug, "statistics.json"), JSON.stringify({ suite: "s" }));
  r = runCheck(dir2);
  assert.ok(r.errors.some((e) => e.id === "plotting_contract_bad_fields"), "缺字段应 critical");
});

test("验证：空项目无plan warning + overall/summary/三参数/去重/exit码 + 6类critical", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "csempty-"));
  const r0 = runCheck(empty);
  assert.ok(r0.warnings.some((w) => w.id === "no_plan_files"), "空项目应 no_plan_files warning");
  assert.equal(r0.overall, "passed", "空项目 overall=passed");
  assert.ok(r0.summary && typeof r0.summary.errors === "number" && typeof r0.summary.warnings === "number" && typeof r0.summary.infos === "number" && typeof r0.summary.plans === "number", "summary 含 errors/warnings/infos/plans");
  const text0 = runCheckText(empty);
  assert.ok(/overall=passed/.test(text0), "文本输出含 overall=passed");
  // 三参数：--fail-on-warning 应使 warning 项目 failed（exit 1 但 JSON 可解析）
  const rFail = runCheck(empty, ["--fail-on-warning"]);
  assert.equal(rFail.overall, "failed", "--fail-on-warning 下 warning 应 failed");
  // 6 类 critical（G1 强升级 6 类缺失）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs6c-"));
  write(path.join(dir, "experiments", "plans", "bad.yaml"), [
    "suite: bad", "mode: evil_mode", "seeds: []", "cases: []", "# 无 base_config，无命令", "",
  ].join("\n"));
  const r = runCheck(dir);
  assert.equal(r.overall, "failed", "坏项目 overall=failed");
  for (const id of ["mode_invalid", "seeds_empty", "cases_empty", "base_config_missing", "train_command_missing", "test_command_missing"]) {
    assert.ok(r.errors.some((e) => e.id === id), `6类critical缺 ${id}`);
    assert.equal(r.errors.filter((e) => e.id === id).length, 1, `${id} 去重唯一`);
  }
});

test("验证：MultiModal 16 plans errors>=14 无刷屏 + 4 critical 用例", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csmm-"));
  write(path.join(dir, "configs", "base.yaml"), "lr: 0.01\n");
  // 16 个 MultiModal plans：2 好 + 14 坏（每坏至少 1 critical）
  write(path.join(dir, "experiments", "plans", "good1.yaml"), goodPlan("mm_good1"));
  write(path.join(dir, "experiments", "plans", "good2.yaml"), goodPlan("mm_good2"));
  const badKinds = [
    ["bad_mode.yaml", "mode: evil\nseeds: [0]\nbase_config: configs/base.yaml\ncases:\n  - name: a\nrunner: { train_command: \"python train.py\" }\ntest_command: \"python test.py\"\n"],
    ["bad_seeds.yaml", "mode: train\nbase_config: configs/base.yaml\ncases:\n  - name: a\nrunner: { train_command: \"python train.py\" }\n"],
    ["bad_cases.yaml", "mode: train\nbase_config: configs/base.yaml\nseeds: [0]\nrunner: { train_command: \"python train.py\" }\n"],
    ["bad_base.yaml", "mode: train\nbase_config: configs/nope.yaml\nseeds: [0]\ncases:\n  - name: a\nrunner: { train_command: \"python train.py\" }\n"],
    ["bad_train.yaml", "mode: train\nbase_config: configs/base.yaml\nseeds: [0]\ncases:\n  - name: a\n"],
    ["bad_test.yaml", "mode: test\nbase_config: configs/base.yaml\nseeds: [0]\ncases:\n  - name: a\n"],
    ["bad_tpl.yaml", "mode: train\nbase_config: configs/base.yaml\nseeds: [0]\ncases:\n  - name: a\nrunner: { train_command: \"python train.py --config {config} --x {bogus_var}\" }\n"],
    ["bad_contract1.yaml", "mode: test\nbase_config: configs/base.yaml\nseeds: [0]\ncases:\n  - name: a\nrunner: { test_command: \"python test.py\" }\n"],
    ["bad_contract2.yaml", "mode: train_test\nbase_config: configs/base.yaml\nseeds: [0, 1]\ncases:\n  - name: a\n  - name: b\nnaming: { job_name: \"fixed\" }\nrunner: { train_command: \"python train.py\" }\ntest_command: \"python test.py\"\n"],
    ["bad_concur.yaml", "mode: train\nbase_config: configs/base.yaml\nseeds: [0, 1]\ncases:\n  - name: a\n  - name: b\nnaming: { job_name: \"fixed <JOB>\" }\nrunner: { train_command: \"python train.py\" }\n"],
    ["bad_nosuite.yaml", "mode: train\nbase_config: configs/base.yaml\nseeds: [0]\ncases:\n  - name: a\nrunner: { train_command: \"python train.py\" }\n"],
    ["bad_testcmd.yaml", "mode: test\nbase_config: configs/base.yaml\nseeds: [0]\ncases:\n  - name: a\nrunner: { test_command: \"python test.py --config {config}\" }\n"],
    ["bad_path.yaml", "mode: train\nbase_config: configs/base.yaml\nseeds: [0]\ncases:\n  - name: a\nrunner: { train_command: \"python train.py --config {config} --output-dir /etc/passwd\" }\nlog_file: /etc/passwd\n"],
    ["bad_trainbig.yaml", "mode: train_test\nbase_config: configs/base.yaml\nseeds: [0]\ncases:\n  - name: a\nrunner: { train_command: \"python train.py --config {config} --result-csv {result_csv}\" }\ntest_command: \"python test.py --config {config} --result-csv {result_csv}\"\n"],
  ];
  for (const [name, body] of badKinds) {
    write(path.join(dir, "experiments", "plans", name), `suite: ${name.replace(/\.yaml$/, "")}\n${body}`);
  }
  const r = runCheck(dir);
  assert.equal(r.summary.plans, 16, "plans=16");
  assert.ok(r.summary.errors >= 14, `errors>=14，实际 ${r.summary.errors}`);
  // 无刷屏：文本输出行数有界（每 finding 最多 2 行 + 头尾）
  const text = runCheckText(dir);
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  assert.ok(lines.length <= 4 + r.summary.errors * 2 + r.summary.warnings * 2 + r.summary.infos * 2 + 20, `无刷屏，行数 ${lines.length}`);
  // 4 个 critical 用例：各自独立复现 critical
  const critCases = [
    ["c_mode.yaml", "suite: c1\nmode: nope\nbase_config: configs/base.yaml\nseeds: [0]\ncases:\n  - name: a\nrunner: { train_command: \"python train.py\" }\ntest_command: \"python test.py\"\n", "mode_invalid"],
    ["c_tpl.yaml", "suite: c2\nmode: train\nbase_config: configs/base.yaml\nseeds: [0]\ncases:\n  - name: a\nrunner: { train_command: \"python train.py --config {config} --result-csv {result_csv}\" }\n", "template_train_writes_big_table"],
    ["c_contract.yaml", "suite: c3\nmode: test\nbase_config: configs/base.yaml\nseeds: [0]\ncases:\n  - name: a\nrunner: { test_command: \"python test.py\" }\n", "output_contract_missing_summary_csv"],
    ["c_concur.yaml", "suite: c4\nmode: train\nbase_config: configs/base.yaml\nseeds: [0, 1]\ncases:\n  - name: a\n  - name: b\nnaming: { job_name: \"same\" }\nrunner: { train_command: \"python train.py\" }\n", "concurrency_same_file"],
  ];
  for (const [name, body, id] of critCases) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "cs Crit-".replace(" ", "")));
    write(path.join(d, "configs", "base.yaml"), "x: 1\n");
    write(path.join(d, "experiments", "plans", name), body);
    const rr = runCheck(d);
    assert.ok(rr.errors.some((e) => e.id === id), `critical 用例 ${name} 应含 ${id}`);
  }
});

test("MD落盘：failed必写/passed可选/逃逸拒绝/json比对", () => {
  const REL = "simple_cluster/check_reports/check-static-latest.md";
  // failed 必写（不带 --write-md 也落盘）
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "csmd-bad-"));
  write(path.join(bad, "experiments", "plans", "bad.yaml"), "suite: bad\nmode: test\n");
  const r = runCheck(bad);
  assert.equal(r.overall, "failed");
  const mdPath = path.join(bad, REL);
  assert.ok(fs.existsSync(mdPath), "failed 必须落盘 MD");
  const md = fs.readFileSync(mdPath, "utf8");
  assert.ok(md.includes("- overall: failed"), "MD 渲染 overall");
  assert.ok(md.includes(`summary: errors=${r.summary.errors} warnings=${r.summary.warnings} infos=${r.summary.infos} plans=${r.summary.plans}`), "MD 渲染 summary 与 JSON 一致");
  assert.ok(md.includes("## errors (" + r.errors.length + ")"), "MD 渲染 errors 分区计数");
  assert.ok(md.includes("## warnings (" + r.warnings.length + ")"), "MD 渲染 warnings 分区计数");
  assert.ok(md.includes("## infos (" + r.infos.length + ")"), "MD 渲染 infos 分区计数");
  for (const f of r.planFiles) assert.ok(md.includes(f), `MD 列出 planFile ${f}`);
  assert.ok(md.includes("| file | severity | id | message | suggestion |"), "MD 五元组表头");
  // passed 可选：默认不写，--write-md 才写
  const ok = fs.mkdtempSync(path.join(os.tmpdir(), "csmd-ok-"));
  const rOk = runCheck(ok);
  assert.equal(rOk.overall, "passed");
  assert.ok(!fs.existsSync(path.join(ok, REL)), "passed 默认不落盘");
  execFileSync("node", [SCRIPT, "--project", ok, "--write-md"], { encoding: "utf8" });
  assert.ok(fs.existsSync(path.join(ok, REL)), "passed + --write-md 落盘");
  assert.ok(fs.readFileSync(path.join(ok, REL), "utf8").includes("- overall: passed"));
  // 逃逸拒绝：固定相对路径必须收敛在工程根内
  const resolved = path.resolve(ok, REL);
  const relative = path.relative(ok, resolved);
  assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), "报告路径不得逃逸工程根");
  assert.throws(() => {
    const evil = path.resolve(ok, "../../evil.md");
    const q = path.relative(ok, evil);
    if (!q || q.startsWith("..") || path.isAbsolute(q)) throw new Error("报告路径逃逸工程根，已拒绝：../../evil.md");
  }, /逃逸/, ".. 路径必须被拒绝");
});

test("4项不动逻辑：双常量相等/reportWritten/--report-md别名/suggestion禁空/##分区", () => {
  const REL = "simple_cluster/check_reports/check-static-latest.md";
  // 双常量相等：legacy.ts#CHECK_STATIC_REPORT_REL_PATH vs scripts#CHECK_STATIC_REPORT_REL
  const legacySrc = fs.readFileSync(path.join(REPO, "src", "extension", "legacy.ts"), "utf8");
  const scriptSrc = fs.readFileSync(SCRIPT, "utf8");
  const m1 = /CHECK_STATIC_REPORT_REL_PATH\s*=\s*"([^"]+)"/.exec(legacySrc);
  const m2 = /CHECK_STATIC_REPORT_REL\s*=\s*"([^"]+)"/.exec(scriptSrc);
  assert.ok(m1 && m2, "双常量均可提取");
  assert.equal(m1[1], m2[1], "双常量必须相等");
  assert.equal(m1[1], REL, "常量即约定相对路径");
  // 抛错拼接常量 + --report-md 别名提示
  assert.ok(legacySrc.includes("${CHECK_STATIC_REPORT_REL_PATH}"), "抛错须拼接常量");
  assert.ok(legacySrc.includes("--write-md/--report-md"), "抛错须提示双别名");
  // reportWritten：bad failed=true 且落盘；空 passed 默认 false 不落盘；--report-md 落盘 true
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "cs4-bad-"));
  write(path.join(bad, "experiments", "plans", "bad.yaml"), "suite: bad\nmode: test\n");
  const rb = runCheck(bad);
  assert.equal(rb.reportWritten, true, "failed 须 reportWritten=true");
  assert.ok(fs.existsSync(path.join(bad, REL)), "failed 落盘");
  const md = fs.readFileSync(path.join(bad, REL), "utf8");
  assert.ok(md.includes("## summary"), "MD 须有 ## summary 分区");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cs4-empty-"));
  const r0 = runCheck(empty);
  assert.equal(r0.overall, "passed");
  assert.equal(r0.reportWritten, false, "passed 默认 reportWritten=false");
  assert.ok(!fs.existsSync(path.join(empty, REL)), "passed 默认不落盘");
  const rAlias = runCheck(empty, ["--report-md"]);
  assert.equal(rAlias.reportWritten, true, "--report-md 别名等价 --write-md");
  assert.ok(fs.existsSync(path.join(empty, REL)), "--report-md 落盘");
  // G1-G8 suggestion 禁空：全量 findings 均有非空 suggestion
  for (const f of [...rb.errors, ...rb.warnings, ...rb.infos, ...rAlias.errors, ...rAlias.warnings, ...rAlias.infos]) {
    assert.ok(typeof f.suggestion === "string" && f.suggestion.length > 0, `suggestion 禁空 (${f.id || f.path})`);
  }
});

test("MD增强：每finding一###块+参考模板+行号映射+去重标记+path_invalid+正例", () => {
  const REL = "simple_cluster/check_reports/check-static-latest.md";
  // path 类 id 收敛 path_invalid + MD 块数 == finding 数
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csmdx-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: train", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    "naming:", '  job_name: "{index}_{case}_seed{seed}"',
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir}" }',
    "log_file: /etc/passwd",
    "# 产物： metrics_summary.csv metrics_case.csv stdout.log stderr.log env_snapshot.json config_snapshot.yaml",
    "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
    "  - experiments/results/m.csv",
    "",
  ].join("\n"));
  const r = runCheck(dir);
  const pathHit = [...r.errors, ...r.warnings].find((f) => (f.path || "").includes("/etc/passwd"));
  assert.ok(pathHit, "path 类 finding 应保留 path 字段");
  assert.equal(pathHit.id, "path_invalid", "path 类 id 收敛 path_invalid");
  const md = fs.readFileSync(path.join(dir, REL), "utf8");
  const total = r.summary.errors + r.summary.warnings + r.summary.infos;
  const blocks = md.split("\n").filter((l) => l.startsWith("### "));
  assert.equal(blocks.length, total, `MD ###块数(${blocks.length})==finding数(${total})`);
  const refTplCount = md.split("\n").filter((l) => l.startsWith("#### 参考模板")).length;
  assert.equal(refTplCount, total, "每个 finding 恰一参考模板源码块");
  assert.ok(md.includes("scripts/check-static.js:"), "含文件:行号映射");
  assert.ok(md.includes("path_invalid"), "MD 含 path_invalid");
  assert.ok(md.includes("[NEW]"), "首现标记 [NEW]");
  for (const line of md.split("\n").filter((l) => l.startsWith("- suggestion:"))) {
    assert.ok(line.replace("- suggestion:", "").trim().length > 0, "MD suggestion 禁空保留");
  }
  // no_plan 正例：空项目 --write-md 落盘，no_plan_files 块含正例
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "csmdx-empty-"));
  const r0 = runCheck(empty, ["--write-md"]);
  assert.ok(r0.warnings.some((w) => w.id === "no_plan_files"), "空项目应 no_plan_files");
  const md0 = fs.readFileSync(path.join(empty, REL), "utf8");
  const total0 = r0.summary.errors + r0.summary.warnings + r0.summary.infos;
  assert.equal(md0.split("\n").filter((l) => l.startsWith("### ")).length, total0, "空项目 MD 块数==finding数");
  assert.ok(md0.includes("no_plan_files") && md0.includes("正例"), "no_plan_files 补正例");
  // validate_crash 正例映射在源码侧兜底（难经外部输入稳定触发 crash，走白盒校验模板存在）
  const scriptSrc = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(/validate_crash[\s\S]{0,600}正例/.test(scriptSrc), "validate_crash 补正例");
  // 去重标记 [DUP]：绘图五缺文件 → 同 file+id ×5，首 [NEW] 后 [DUP]
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "csmdx-dup-"));
  write(path.join(dir2, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir2, "experiments", "plans", "myplan.yaml"), [
    "suite: s", "mode: train", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    "naming:", '  job_name: "{index}_{case}_seed{seed}"',
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir}" }',
    "outputs:",
    '  registry: "simple_cluster/results/result_registry.json"',
    '  stats: "simple_cluster/results/statistics.json"',
    "",
  ].join("\n"));
  const r2 = runCheck(dir2);
  assert.equal(r2.warnings.filter((w) => w.id === "plotting_contract_missing_file").length, 5, "缺五文件应 5 warnings（同 file+id）");
  const md2 = fs.readFileSync(path.join(dir2, REL), "utf8");
  assert.ok(md2.includes("plotting_contract_missing_file") && md2.includes("[NEW]"), "同 file+id 首 [NEW]");
  assert.ok(md2.includes("[DUP]"), "同 file+id 后 [DUP]");
  assert.ok(!/#L0/.test(md2), "无行号标题省略#L0（bare file）");
  assert.ok(/^### \[warnings\][\[`plotting_contract_missing_file`[\]`]+ [^#\s]+ \[(NEW|DUP)\]/m.test(md2), "无行号标题为 bare file（不带#L）");
});

test("ID_SRC动态锚点+未注册抛错+plotting DUP说明", () => {
  const scriptSrc = fs.readFileSync(SCRIPT, "utf8");
  const scriptLines = scriptSrc.split(/\r?\n/);
  // 白盒（与 validate_crash 正例断言同风格）：动态提取优先断言保留，静态表允许±漂移，兜底随 writeFileSync 行移动重锚
  const fb = /CHECK_STATIC_ID_SRC_FALLBACK\s*=\s*"scripts\/check-static\.js:(\d+)"/.exec(scriptSrc);
  assert.ok(fb, "兜底常量可提取行号");
  const writeIdx = scriptLines.findIndex((l) => l.includes("fs.writeFileSync(reportPath"));
  assert.ok(writeIdx >= 0, "writeFileSync 落盘行可定位");
  const drift = Math.abs(Number(fb[1]) - (writeIdx + 1));
  assert.ok(drift <= 10, `兜底 ${fb[1]} 须随 writeFileSync 行 ${writeIdx + 1} 移动重锚（漂移 ${drift}≤10，静态表允许±漂移）`);
  // 动态提取优先：构造位 id:"" > === 判定位 > 首个含引号 id 的行
  assert.ok(scriptSrc.includes("id: ${quoted}"), "动态提取构造位优先");
  assert.ok(scriptSrc.includes('l.includes("===")'), "动态提取 === 判定位次之");
  assert.ok(/未注册的 finding id/.test(scriptSrc), "ID_SRC 未注册抛错");
  assert.ok(/参考模板未注册/.test(scriptSrc), "GOOD_PLAN_REF 未注册抛错");
  // 新增 id 无模板抛错、不断言 GOOD 回退：除 "-" 兜底外禁止静默回退 GOOD_PLAN_REF
  assert.ok(scriptSrc.includes('if (refId === "-") return GOOD_PLAN_REF'), '"-" 兜底保留');
  assert.ok(!/\|\|\s*GOOD_PLAN_REF/.test(scriptSrc), "新增 id 禁止静默回退 GOOD");
  assert.ok(!/check-static\.js:1022/.test(scriptSrc), "旧兜底 1022 已消除");
  // result_schema 四独立 id 已注册为检查位，旧统合 id 不再产出
  for (const id of ["result_schema_summary_missing_columns", "result_schema_summary_bad_value", "result_schema_case_missing_columns", "result_schema_case_bad_value"]) {
    assert.ok(scriptSrc.includes(`id: "${id}"`), `四独立 id 已注册 ${id}`);
  }
  assert.ok(!/id:\s*"result_schema_missing_columns"/.test(scriptSrc) && !/id:\s*"result_schema_bad_value"/.test(scriptSrc), "旧统合 id 不再产出");
  // legacy 裸 id 已注册：bad-mode 触发 legacy mode，MD 渲染不崩溃且带动态行号锚点
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csid-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: evil", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir}" }',
    "",
  ].join("\n"));
  const r = runCheck(dir);
  assert.ok(r.errors.some((e) => e.id === "mode"), "legacy 裸 id mode 应进入报告");
  const md = fs.readFileSync(path.join(dir, "simple_cluster/check_reports/check-static-latest.md"), "utf8");
  assert.ok(md.includes("`mode`"), "MD 含 mode 明细块（id 反引号 code）");
  assert.ok(/^### \[errors\]\[`mode`\] \S+#L\d+ \[NEW\]|^### \[errors\]\[`mode`\] \S+ \[(NEW|DUP)\]/m.test(md), "MD 标题为 ### [severity][id] file#Lx [NEW/DUP]（有行号带#L，无行号时 bare file 省略#L0）");
  assert.ok(!/#L0/.test(md), "有行号标题带#Lx，无#L0 残留");
  assert.ok(/scripts\/check-static\.js:\d+/.test(md), "MD 行号锚点动态生成");
  // plotting DUP 说明：五缺文件块均带五文件共用 id 解释
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "csid-plot-"));
  write(path.join(dir2, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir2, "experiments", "plans", "myplan.yaml"), [
    "suite: s", "mode: train", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    "naming:", '  job_name: "{index}_{case}_seed{seed}"',
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir}" }',
    "outputs:",
    '  registry: "simple_cluster/results/result_registry.json"',
    '  stats: "simple_cluster/results/statistics.json"',
    "",
  ].join("\n"));
  runCheck(dir2);
  const md2 = fs.readFileSync(path.join(dir2, "simple_cluster/check_reports/check-static-latest.md"), "utf8");
  assert.ok(md2.includes("五文件共用同一 id"), "plotting 缺文件块带 DUP 说明");
});

test("O1候选收敛：仅候选键域判扩展名，非候选列表不再误伤", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cso1-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), goodPlan("ok"));
  // 非候选键下的坏扩展名不再报 candidate_extension（收敛前全文 `- x.ext` 会误伤）
  write(path.join(dir, "experiments", "simple_project.yaml"), [
    "projectName: demo",
    "version: 0.4.2",
    "secondaryMetrics:",
    "  - badfile.report",
    "outputs:",
    "  manifest: artifact_manifest.json",
    "",
  ].join("\n"));
  const r = runCheck(dir);
  assert.ok(!r.errors.some((e) => e.id === "simple_project_candidate_extension"), "非候选键坏扩展名不报");
  // 候选键域内坏扩展名仍报 critical
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cso1b-"));
  write(path.join(dir2, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir2, "experiments", "plans", "p.yaml"), goodPlan("ok"));
  write(path.join(dir2, "experiments", "simple_project.yaml"), [
    "projectName: demo",
    "version: 0.4.2",
    "outputs:",
    "  manifest: artifact_manifest.json",
    "  candidateCsv:",
    '    - "{output_dir}/metrics_summary.csv"',
    "    - badfile.report",
    "",
  ].join("\n"));
  const r2 = runCheck(dir2);
  assert.ok(r2.errors.some((e) => e.id === "simple_project_candidate_extension"), "候选键域坏扩展名仍 critical");
  // 行内数组写法同样收敛计入
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "cso1c-"));
  write(path.join(dir3, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir3, "experiments", "plans", "p.yaml"), goodPlan("ok"));
  write(path.join(dir3, "experiments", "simple_project.yaml"), [
    "projectName: demo",
    "version: 0.4.2",
    "outputs:",
    "  manifest: artifact_manifest.json",
    "  candidateJson: [a.json, badfile.report]",
    "",
  ].join("\n"));
  const r3 = runCheck(dir3);
  assert.ok(r3.errors.some((e) => e.id === "simple_project_candidate_extension"), "行内数组坏扩展名仍 critical");
});

test("O2选b：metricAliases 未落主次保持 warning（不升级 critical）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cso2-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), goodPlan("ok"));
  write(path.join(dir, "experiments", "simple_project.yaml"), [
    "projectName: demo",
    "version: 0.4.2",
    "primaryMetric: AUC",
    "outputs:",
    "  manifest: artifact_manifest.json",
    "  metricAliases:",
    "    acc: NotAMetric",
    "",
  ].join("\n"));
  const r = runCheck(dir);
  assert.ok(r.warnings.some((w) => w.id === "simple_project_metric_alias"), "别名未落主次应 warning");
  assert.ok(!r.errors.some((e) => e.id === "simple_project_metric_alias"), "选b：不升级 critical");
});

test("O4渲染归一折叠+G9抛错保留：DUP 模板折叠但块数/字段/抛错不断链", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cso4-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "myplan.yaml"), [
    "suite: s", "mode: train", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    "naming:", '  job_name: "{index}_{case}_seed{seed}"',
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir}" }',
    "outputs:",
    '  registry: "simple_cluster/results/result_registry.json"',
    '  stats: "simple_cluster/results/statistics.json"',
    "",
  ].join("\n"));
  const r = runCheck(dir);
  assert.equal(r.warnings.filter((w) => w.id === "plotting_contract_missing_file").length, 5, "缺五文件应 5 warnings");
  const md = fs.readFileSync(path.join(dir, "simple_cluster/check_reports/check-static-latest.md"), "utf8");
  const total = r.summary.errors + r.summary.warnings + r.summary.infos;
  assert.equal(md.split("\n").filter((l) => l.startsWith("### ")).length, total, "块数==finding数（折叠不断链）");
  assert.equal(md.split("\n").filter((l) => l.startsWith("#### 参考模板")).length, total, "每块仍恰一模板头");
  assert.ok(md.includes("[NEW]"), "首现 [NEW] 全量多行模板");
  assert.ok(md.includes("[DUP] 模板已折叠"), "后随 [DUP] 模板折叠为单行");
  assert.ok(/见第\d+块（MD行L\d+）/.test(md), "DUP 模板引用指向首块块号+MD行号");
  assert.ok(!/\r/.test(md), "CRLF 归一为 LF");
  // G9 不编造：双抛错保留（源码级）+ "-" 兜底唯一回退保留
  const scriptSrc = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(/未注册的 finding id/.test(scriptSrc), "ID_SRC 未注册照抛错");
  assert.ok(/参考模板未注册/.test(scriptSrc), "模板未注册照抛错");
  assert.ok(scriptSrc.includes('if (refId === "-") return GOOD_PLAN_REF'), '"-" 兜底保留');
  assert.ok(!/\|\|\s*GOOD_PLAN_REF/.test(scriptSrc), "新增 id 禁止静默回退 GOOD");
});

test("报告头/candidate放宽/run_wrapper豁免/120注入语义", () => {
  const REL = "simple_cluster/check_reports/check-static-latest.md";
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
  // 报告头：JSON 含 generatedAt/toolVersion/reportWritten；MD 头含五行且双常量一致
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "csnew-bad-"));
  write(path.join(bad, "experiments", "plans", "bad.yaml"), "suite: bad\nmode: test\n");
  const rb = runCheck(bad);
  assert.ok(typeof rb.generatedAt === "string" && !Number.isNaN(Date.parse(rb.generatedAt)), "generatedAt 为 ISO 时间");
  assert.equal(rb.toolVersion, pkgVersion, "toolVersion 与 package.json 一致");
  assert.equal(rb.reportWritten, true, "failed 须 reportWritten=true");
  const md = fs.readFileSync(path.join(bad, REL), "utf8");
  assert.ok(md.includes(`- generatedAt: ${rb.generatedAt}`), "MD 头含 generatedAt");
  assert.ok(md.includes(`- toolVersion: ${rb.toolVersion}`), "MD 头含 toolVersion");
  assert.ok(md.includes("- reportWritten: true"), "MD 头含 reportWritten");
  assert.ok(md.includes(`- reportRel: ${REL}`), "MD 头含双常量 reportRel");
  assert.ok(md.includes("- reportDir: simple_cluster/check_reports"), "MD 头含双常量 reportDir");
  // candidate 放宽：md/jsonl/config_diff.json 放行，badfile.report 仍 critical
  const cand = fs.mkdtempSync(path.join(os.tmpdir(), "csnew-cand-"));
  write(path.join(cand, "configs", "base.yaml"), "x: 1\n");
  write(path.join(cand, "experiments", "plans", "p.yaml"), goodPlan("ok"));
  write(path.join(cand, "experiments", "simple_project.yaml"), [
    "projectName: demo", "version: 0.4.2",
    "outputs:", "  manifest: artifact_manifest.json",
    "  candidateCsv:", '    - "{output_dir}/metrics_summary.csv"',
    "    - report.md", "    - data.jsonl", "    - config_diff.json", "",
  ].join("\n"));
  const rc = runCheck(cand);
  assert.ok(!rc.errors.some((e) => e.id === "simple_project_candidate_extension"), "md/jsonl/config_diff.json 应放行");
  // run_wrapper 豁免：无 wrapper 时 stdout/stderr 为 critical；有项目级 wrapper 时转 info 豁免
  const rwBase = [
    "suite: s", "mode: train", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    "naming:", '  job_name: "{index}_{case}_seed{seed}"',
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir}" }',
    "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
    "  - experiments/results/m.csv", "",
  ].join("\n");
  const rw0 = fs.mkdtempSync(path.join(os.tmpdir(), "csnew-rw0-"));
  write(path.join(rw0, "configs", "base.yaml"), "x: 1\n");
  write(path.join(rw0, "experiments", "plans", "p.yaml"), rwBase);
  const r0 = runCheck(rw0);
  assert.ok(r0.errors.some((e) => e.id === "output_contract_missing_stdout_log"), "无 wrapper 时 stdout 仍 critical");
  assert.ok(r0.errors.some((e) => e.id === "output_contract_missing_stderr_log"), "无 wrapper 时 stderr 仍 critical");
  const rw1 = fs.mkdtempSync(path.join(os.tmpdir(), "csnew-rw1-"));
  write(path.join(rw1, "configs", "base.yaml"), "x: 1\n");
  write(path.join(rw1, "experiments", "plans", "p.yaml"), rwBase);
  write(path.join(rw1, "experiments", "simple_adapter", "run_wrapper.py"), "# ok\n");
  const r1 = runCheck(rw1);
  assert.ok(!r1.errors.some((e) => e.id === "output_contract_missing_stdout_log"), "有 wrapper 时 stdout 豁免");
  assert.ok(!r1.errors.some((e) => e.id === "output_contract_missing_stderr_log"), "有 wrapper 时 stderr 豁免");
  assert.ok(r1.infos.some((i) => i.id === "output_contract_wrapper_summary"), "豁免 5 明细折叠为 1 条 wrapper 汇总 info");
  assert.ok(!r1.infos.some((i) => /_via_wrapper$/.test(i.id || "")), "明细 via_wrapper 不再逐条落 infos");
  assert.ok(!r1.warnings.some((w) => w.id === "output_contract_case_csv_via_wrapper"), "豁免 case_csv 不再记 warning");
  // 120等11行语义：注入降 warning（G3 已覆盖，此处显式回归 via_injection 不报 critical）
  const via = fs.mkdtempSync(path.join(os.tmpdir(), "csnew-120-"));
  write(path.join(via, "configs", "base.yaml"), "x: 1\n");
  write(path.join(via, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: test", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    'paper: { result_csv: "{output_dir}/metrics_summary.csv" }',
    "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
    "  - experiments/results/m.csv",
    'runner: { test_command: "python test.py --config {config} --output-dir {output_dir}" }', "",
  ].join("\n"));
  const rVia = runCheck(via);
  assert.ok(rVia.warnings.some((w) => w.id === "test_command_via_injection"), "注入语义保持 warning");
  assert.ok(!rVia.errors.some((e) => e.id === "test_command_missing_result_csv"), "注入语义不报 critical");
});

test("checkerSource/O1 markdown收敛/O2豁免明确/MD直观(禁改归档)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csnew-o12-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), goodPlan("o12"));
  write(path.join(dir, "experiments", "simple_adapter", "run_wrapper.py"), "# ok\n");
  write(path.join(dir, "experiments", "simple_project.yaml"), [
    "projectName: demo", "version: 0.4.2",
    "outputs:", "  manifest: artifact_manifest.json",
    "  candidateCsv:", '    - "{output_dir}/metrics_summary.csv"',
    "    - notes.markdown",
    "  secondaryMetrics:", "    - weird.report", "",
  ].join("\n"));
  const r = runCheck(dir, ["--write-md"]);
  assert.equal(r.checkerSource, "scripts/check-static.js", "JSON checkerSource");
  assert.ok(!r.errors.some((e) => e.id === "simple_project_candidate_extension"), "O1 markdown放行且secondaryMetrics不计入");
  const std = r.infos.find((i) => i.id === "output_contract_wrapper_summary");
  assert.ok(std && std.message.includes("豁免，来源"), "O2 豁免来源明确");
  const scriptSrc = fs.readFileSync(SCRIPT, "utf8");
  const legacySrc = fs.readFileSync(path.join(REPO, "src", "extension", "legacy.ts"), "utf8");
  assert.ok(scriptSrc.includes('CHECKER_SOURCE = "scripts/check-static.js"'), "脚本侧checkerSource单源");
  assert.ok(legacySrc.includes('CHECK_STATIC_CHECKER_SOURCE = "scripts/check-static.js"'), "legacy侧checkerSource双常量");
  const md = fs.readFileSync(path.join(dir, "simple_cluster/check_reports/check-static-latest.md"), "utf8");
  assert.ok(md.includes("- checkerSource: scripts/check-static.js"), "MD直观checkerSource");
  assert.ok(md.includes("summary: errors="), "MD直观summary行");
});

test("降噪：via齐备降info+D1抑制+wrapper折叠+quiet旗", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csquiet-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  // paper + test.results_csv + candidateCsv 齐备：缺 --result-csv 降 info，大表 warning 被 D1 直接抑制
  write(path.join(dir, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: test", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    "paper:", '  result_csv: "{output_dir}/metrics_summary.csv"',
    'test.results_csv: "{output_dir}/metrics_summary.csv"',
    "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
    "  - experiments/results/m.csv",
    "outputs:", "  candidateCsv:", '    - "experiments/results/m.csv"',
    'runner: { test_command: "python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}" }',
    "",
  ].join("\n"));
  const r = runCheck(dir);
  assert.ok(r.infos.some((i) => i.id === "test_command_via_injection"), "齐备时 via 降 info");
  assert.ok(!r.warnings.some((w) => w.id === "test_command_via_injection"), "齐备时 via 不再记 warning");
  assert.ok(![...r.warnings, ...r.infos].some((f) => f.id === "output_contract_big_table_via_injection"), "D1 直接抑制大表 findings");
  // wrapper 折叠：项目级 wrapper 下 5 明细 → 1 汇总；--quiet-wrapper 连汇总都抑制
  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), "csquietw-"));
  write(path.join(wdir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(wdir, "experiments", "plans", "p.yaml"), [
    "suite: s", "mode: train", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: a",
    "naming:", '  job_name: "{index}_{case}_seed{seed}"',
    'runner: { train_command: "python train.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}" }',
    "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
    "  - experiments/results/m.csv", "",
  ].join("\n"));
  write(path.join(wdir, "experiments", "simple_adapter", "run_wrapper.py"), "# ok\n");
  const rw = runCheck(wdir);
  assert.equal(rw.infos.filter((i) => i.id === "output_contract_wrapper_summary").length, 1, "5 明细折叠为 1 汇总");
  assert.ok(String(rw.infos.find((i) => i.id === "output_contract_wrapper_summary").suggestion || "").includes("--quiet-wrapper"), "wrapper 汇总 suggestion 注明 --quiet-wrapper CLI 示例");
  assert.ok(String(rw.infos.find((i) => i.id === "output_contract_wrapper_summary").suggestion || "").includes("node scripts/check-static.js --project <dir> --write-md --quiet-wrapper"), "wrapper 汇总 suggestion 含完整 CLI 示例");
  const rwq = runCheck(wdir, ["--quiet-wrapper"]);
  assert.ok(!rwq.infos.some((i) => i.id === "output_contract_wrapper_summary"), "--quiet-wrapper 抑制汇总");
  assert.ok(!rwq.infos.some((i) => /_via_wrapper$/.test(i.id || "")), "--quiet-wrapper 下无明细");
});

test("G10分片大表错位：多分片+paper大表+缺接线warning", () => {
  const base = (testCmd) => [
    "suite: s", "mode: test", "base_config: configs/base.yaml", "seeds: [0]",
    "cases:", "  - name: shard_a", "  - name: shard_b",
    "paper:", '  result_csv: "{output_dir}/metrics_summary.csv"',
    "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
    "  - experiments/results/paper_all.csv",
    `runner: { test_command: "${testCmd}" }`,
    "# 产物： metrics_summary.csv metrics_case.csv stdout.log stderr.log env_snapshot.json config_snapshot.yaml",
    "",
  ].join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csg10-"));
  write(path.join(dir, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir, "experiments", "plans", "p.yaml"), base("python test.py --config {config} --output-dir {output_dir}"));
  const r = runCheck(dir);
  assert.ok(r.warnings.some((w) => w.id === "sharded_big_table_mismatch"), "多分片名不对齐且缺接线应 warning");
  // 反例：test 带 --case/--seed 接线 → 不报
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "csg10ok-"));
  write(path.join(dir2, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir2, "experiments", "plans", "p.yaml"), base("python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed} --result-csv {result_csv}"));
  const r2 = runCheck(dir2);
  assert.ok(![...r2.warnings, ...r2.errors].some((f) => f.id === "sharded_big_table_mismatch"), "带分片接线不报");
  // 反例：goodPlan（双分片+接线齐备）不报
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "csg10good-"));
  write(path.join(dir3, "configs", "base.yaml"), "x: 1\n");
  write(path.join(dir3, "experiments", "plans", "p.yaml"), goodPlan("ok"));
  const r3 = runCheck(dir3);
  assert.ok(![...r3.warnings, ...r3.errors].some((f) => f.id === "sharded_big_table_mismatch"), "goodPlan 不报");
  // MD 可渲染：新 id 行号锚点 + 独立正例模板
  const md = fs.readFileSync(path.join(dir, "simple_cluster/check_reports/check-static-latest.md"), "utf8");
  assert.ok(md.includes("sharded_big_table_mismatch"), "MD 含新 id 明细");
  assert.ok(/scripts\/check-static\.js:\d+/.test(md), "MD 行号锚点");
});

test("MultiModal降噪：wrapper+注入项目 warnings 0/errors 0/overall passed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csmmq-"));
  write(path.join(dir, "configs", "base.yaml"), "lr: 0.01\n");
  write(path.join(dir, "experiments", "simple_adapter", "run_wrapper.py"), "# ok\n");
  const injPlan = (suite) => [
    `suite: ${suite}`,
    "mode: test",
    "base_config: configs/base.yaml",
    "seeds: [0]",
    "naming:", '  job_name: "{index}_{case}_seed{seed}"',
    "paper:", '  result_csv: "{output_dir}/metrics_summary.csv"',
    'test.results_csv: "{output_dir}/metrics_summary.csv"',
    "cases:", "  - name: a",
    "runner:", `  test_command: "python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}"`,
    "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
    '  - "{output_dir}/metrics_case.csv"',
    "  - experiments/results/m.csv",
    "outputs:", "  candidateCsv:", '    - "experiments/results/m.csv"',
    "",
  ].join("\n");
  write(path.join(dir, "experiments", "plans", "inj1.yaml"), injPlan("mm_inj1"));
  write(path.join(dir, "experiments", "plans", "inj2.yaml"), injPlan("mm_inj2"));
  write(path.join(dir, "experiments", "plans", "good.yaml"), goodPlan("mm_good"));
  const r = runCheck(dir);
  assert.equal(r.summary.errors, 0, `errors 应 0，实际 ${JSON.stringify(r.errors.map((e) => e.id))}`);
  assert.equal(r.summary.warnings, 0, `warnings 应 0，实际 ${JSON.stringify(r.warnings.map((w) => w.id))}`);
  assert.equal(r.overall, "passed", "overall=passed");
  assert.ok(r.summary.infos <= 12, `infos 应大幅下降（3 plans 预期≤12），实际 ${r.summary.infos}`);
});
