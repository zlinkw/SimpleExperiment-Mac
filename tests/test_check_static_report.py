"""check-static 报告头/候选放宽/run_wrapper 豁免/120等11行语义断言.

运行: python tests/test_check_static_report.py
      pytest tests/test_check_static_report.py -q
仅用标准库,经 subprocess 调用 node scripts/check-static.js --project <tmp> --json,
并读取 simple_cluster/check_reports/check-static-latest.md 校验 MD 头.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "check-static.js"
REL = "simple_cluster/check_reports/check-static-latest.md"
DIR_REL = "simple_cluster/check_reports"
PKG_VERSION = json.loads((REPO / "package.json").read_text(encoding="utf-8"))["version"]


def write(p: Path, content: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def good_plan(suite: str = "ok") -> str:
    return "\n".join([
        f"suite: {suite}",
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
        "cases:",
        "  - name: smoke",
        "  - name: public",
        "",
    ])


def run_check(project: Path, extra=()):
    proc = subprocess.run(
        ["node", str(SCRIPT), "--project", str(project), "--json", *extra],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(REPO),
    )
    out = (proc.stdout or "").strip()
    idx = out.find("{")
    assert idx >= 0, f"stdout 非 JSON: {out[:300]} / stderr: {(proc.stderr or '')[:300]}"
    return json.loads(out[idx:])


class TestCheckStaticReport(unittest.TestCase):
    def test_report_json_header(self):
        d = Path(tempfile.mkdtemp(prefix="cs-py-hdr-"))
        rep = run_check(d)
        self.assertIn("generatedAt", rep)
        self.assertIn("toolVersion", rep)
        self.assertIn("reportWritten", rep)
        self.assertEqual(rep["toolVersion"], PKG_VERSION)
        from datetime import datetime
        datetime.fromisoformat(str(rep["generatedAt"]).replace("Z", "+00:00"))

    def test_md_header_reports_written_and_dual_const(self):
        d = Path(tempfile.mkdtemp(prefix="cs-py-md-"))
        write(d / "experiments" / "plans" / "bad.yaml", "suite: bad\nmode: test\n")
        rep = run_check(d)
        self.assertEqual(rep["overall"], "failed")
        self.assertTrue(rep["reportWritten"])
        md = (d / REL).read_text(encoding="utf-8")
        self.assertIn(f"- generatedAt: {rep['generatedAt']}", md)
        self.assertIn(f"- toolVersion: {rep['toolVersion']}", md)
        self.assertIn("- reportWritten: true", md)
        self.assertIn(f"- reportRel: {REL}", md)
        self.assertIn(f"- reportDir: {DIR_REL}", md)
        # 双常量:脚本侧 REL/DIR_REL 与 legacy 侧 REL_PATH 一致
        script_src = SCRIPT.read_text(encoding="utf-8")
        legacy_src = (REPO / "src" / "extension" / "legacy.ts").read_text(encoding="utf-8")
        self.assertIn(f'CHECK_STATIC_REPORT_REL = "{REL}"', script_src)
        self.assertIn(f'CHECK_STATIC_REPORT_DIR_REL = "{DIR_REL}"', script_src)
        self.assertIn(f'CHECK_STATIC_REPORT_REL_PATH = "{REL}"', legacy_src)

    def test_candidate_relaxed_md_jsonl_config_diff(self):
        d = Path(tempfile.mkdtemp(prefix="cs-py-cand-"))
        write(d / "configs" / "base.yaml", "x: 1\n")
        write(d / "experiments" / "plans" / "p.yaml", good_plan())
        write(d / "experiments" / "simple_project.yaml", "\n".join([
            "projectName: demo",
            "version: 0.4.2",
            "outputs:",
            "  manifest: artifact_manifest.json",
            "  candidateCsv:",
            '    - "{output_dir}/metrics_summary.csv"',
            "    - report.md",
            "    - data.jsonl",
            "    - config_diff.json",
            "",
        ]))
        rep = run_check(d)
        bad = [e for e in rep["errors"] if e.get("id") == "simple_project_candidate_extension"]
        self.assertEqual(bad, [], f"md/jsonl/config_diff.json 应放行,实际 {bad}")
        # 对照:坏扩展名仍 critical
        d2 = Path(tempfile.mkdtemp(prefix="cs-py-candbad-"))
        write(d2 / "configs" / "base.yaml", "x: 1\n")
        write(d2 / "experiments" / "plans" / "p.yaml", good_plan())
        write(d2 / "experiments" / "simple_project.yaml", "\n".join([
            "projectName: demo",
            "version: 0.4.2",
            "outputs:",
            "  manifest: artifact_manifest.json",
            "  candidateCsv:",
            '    - "{output_dir}/metrics_summary.csv"',
            "    - badfile.report",
            "",
        ]))
        rep2 = run_check(d2)
        self.assertTrue(
            any(e.get("id") == "simple_project_candidate_extension" for e in rep2["errors"]),
            "badfile.report 应仍为 critical",
        )

    def test_run_wrapper_exempts_stdout_stderr(self):
        base_plan = "\n".join([
            "suite: s",
            "mode: train",
            "base_config: configs/base.yaml",
            "seeds: [0]",
            "cases:",
            "  - name: a",
            "naming:",
            '  job_name: "{index}_{case}_seed{seed}"',
            'runner: { train_command: "python train.py --config {config} --output-dir {output_dir}" }',
            "expectedResults:",
            '  - "{output_dir}/metrics_summary.csv"',
            "  - experiments/results/m.csv",
            "",
        ])
        # 无 wrapper:stdout/stderr 为 critical
        d0 = Path(tempfile.mkdtemp(prefix="cs-py-rw0-"))
        write(d0 / "configs" / "base.yaml", "x: 1\n")
        write(d0 / "experiments" / "plans" / "p.yaml", base_plan)
        r0 = run_check(d0)
        ids0 = {e.get("id") for e in r0["errors"]}
        self.assertIn("output_contract_missing_stdout_log", ids0)
        self.assertIn("output_contract_missing_stderr_log", ids0)
        # 有项目级 wrapper:转为 info 豁免,不再 critical
        d1 = Path(tempfile.mkdtemp(prefix="cs-py-rw1-"))
        write(d1 / "configs" / "base.yaml", "x: 1\n")
        write(d1 / "experiments" / "plans" / "p.yaml", base_plan)
        write(d1 / "experiments" / "simple_adapter" / "run_wrapper.py", "# ok\n")
        r1 = run_check(d1)
        ids1_err = {e.get("id") for e in r1["errors"]}
        ids1_info = {i.get("id") for i in r1["infos"]}
        self.assertNotIn("output_contract_missing_stdout_log", ids1_err)
        self.assertNotIn("output_contract_missing_stderr_log", ids1_err)
        # W1 折叠：5 条 via_wrapper 明细折叠为 1 条 wrapper 汇总 info
        self.assertIn("output_contract_wrapper_summary", ids1_info)
        for detail in ("output_contract_stdout_via_wrapper", "output_contract_stderr_via_wrapper",
                       "output_contract_case_csv_via_wrapper", "output_contract_env_snapshot_via_wrapper",
                       "output_contract_config_snapshot_via_wrapper"):
            self.assertNotIn(detail, ids1_info)
        # 豁免 id 已注册:MD 明细可渲染行号锚点
        md = (d1 / REL).read_text(encoding="utf-8") if (d1 / REL).exists() else None
        if md is not None:
            self.assertIn("output_contract_wrapper_summary", md)

    def test_line120_injection_semantics_kept(self):
        # 120等11行语义:经 test.results_csv/paper.result_csv + expectedResults 大表注入
        # 缺 --result-csv 时降 warning(test_command_via_injection),不报 critical;
        # 无注入对照仍报 critical(test_command_missing_result_csv).
        via = "\n".join([
            "suite: s", "mode: test", "base_config: configs/base.yaml", "seeds: [0]",
            "cases:", "  - name: a",
            'paper: { result_csv: "{output_dir}/metrics_summary.csv" }',
            "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
            "  - experiments/results/m.csv",
            'runner: { test_command: "python test.py --config {config} --output-dir {output_dir}" }',
            "",
        ])
        d = Path(tempfile.mkdtemp(prefix="cs-py-120-"))
        write(d / "configs" / "base.yaml", "x: 1\n")
        write(d / "experiments" / "plans" / "p.yaml", via)
        r = run_check(d)
        self.assertTrue(any(w.get("id") == "test_command_via_injection" for w in r["warnings"]))
        self.assertFalse(any(e.get("id") == "test_command_missing_result_csv" for e in r["errors"]))
        no = "\n".join([
            "suite: s", "mode: test", "base_config: configs/base.yaml", "seeds: [0]",
            "cases:", "  - name: a",
            'runner: { test_command: "python test.py --config {config} --output-dir {output_dir}" }',
            "",
        ])
        d2 = Path(tempfile.mkdtemp(prefix="cs-py-120b-"))
        write(d2 / "configs" / "base.yaml", "x: 1\n")
        write(d2 / "experiments" / "plans" / "p.yaml", no)
        r2 = run_check(d2)
        self.assertTrue(any(e.get("id") == "test_command_missing_result_csv" for e in r2["errors"]))
        # 白盒:注入语义块仍在脚本内(120行附近 message + suggestion baseline 引用)
        src = SCRIPT.read_text(encoding="utf-8")
        self.assertIn("test_command_via_injection", src)
        self.assertIn("test.results_csv/paper.result_csv", src)
        self.assertIn("BASELINE_TEST_COMMAND", src)

    def test_checker_source_o1_converge_o2_exempt_md(self):
        # 1 报告头 checkerSource(JSON+MD 与双常量一致);2 O1 收敛(.markdown 放行,
        # cases/secondaryMetrics 非候选不误伤);3 O2 豁免明确(info 标注豁免来源);
        # 4 MD 直观(checkerSource/summary 行);禁改归档:本用例不触 archive* 逻辑.
        d = Path(tempfile.mkdtemp(prefix="cs-py-o12-"))
        write(d / "configs" / "base.yaml", "x: 1\n")
        write(d / "experiments" / "plans" / "p.yaml", good_plan())
        write(d / "experiments" / "simple_adapter" / "run_wrapper.py", "# ok\n")
        write(d / "experiments" / "simple_project.yaml", "\n".join([
            "projectName: demo",
            "version: 0.4.2",
            "outputs:",
            "  manifest: artifact_manifest.json",
            "  candidateCsv:",
            '    - "{output_dir}/metrics_summary.csv"',
            "    - notes.markdown",
            "  secondaryMetrics:",
            "    - weird.report",
            "",
        ]))
        rep = run_check(d)
        self.assertEqual(rep.get("checkerSource"), "scripts/check-static.js")
        bad = [e for e in rep["errors"] if e.get("id") == "simple_project_candidate_extension"]
        self.assertEqual(bad, [], f"O1:notes.markdown 应放行且 secondaryMetrics 不计入,实际 {bad}")
        infos = {i.get("id"): i for i in rep["infos"]}
        self.assertIn("output_contract_wrapper_summary", infos)
        self.assertIn("豁免，来源", infos["output_contract_wrapper_summary"].get("message", ""))
        script_src = SCRIPT.read_text(encoding="utf-8")
        legacy_src = (REPO / "src" / "extension" / "legacy.ts").read_text(encoding="utf-8")
        self.assertIn('CHECKER_SOURCE = "scripts/check-static.js"', script_src)
        self.assertIn('CHECK_STATIC_CHECKER_SOURCE = "scripts/check-static.js"', legacy_src)
        md = (d / REL).read_text(encoding="utf-8") if (d / REL).exists() else ""
        if md:
            self.assertIn("- checkerSource: scripts/check-static.js", md)
            self.assertIn("summary: errors=", md)

    def test_wrapper_summary_quiet_flag(self):
        base_plan = "\n".join([
            "suite: s",
            "mode: train",
            "base_config: configs/base.yaml",
            "seeds: [0]",
            "cases:",
            "  - name: a",
            "naming:",
            '  job_name: "{index}_{case}_seed{seed}"',
            'runner: { train_command: "python train.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}" }',
            "expectedResults:",
            '  - "{output_dir}/metrics_summary.csv"',
            "  - experiments/results/m.csv",
            "",
        ])
        d = Path(tempfile.mkdtemp(prefix="cs-py-wq-"))
        write(d / "configs" / "base.yaml", "x: 1\n")
        write(d / "experiments" / "plans" / "p.yaml", base_plan)
        write(d / "experiments" / "simple_adapter" / "run_wrapper.py", "# ok\n")
        rep = run_check(d)
        infos = [i.get("id") for i in rep["infos"]]
        self.assertIn("output_contract_wrapper_summary", infos)
        self.assertEqual(sum(1 for i in infos if str(i).endswith("_via_wrapper")), 0)
        rep_q = run_check(d, extra=("--quiet-wrapper",))
        infos_q = [i.get("id") for i in rep_q["infos"]]
        self.assertNotIn("output_contract_wrapper_summary", infos_q)

    def test_via_complete_downgrades_to_info_and_sharded(self):
        via = "\n".join([
            "suite: s", "mode: test", "base_config: configs/base.yaml", "seeds: [0]",
            "cases:", "  - name: a",
            "paper:", '  result_csv: "{output_dir}/metrics_summary.csv"',
            'test.results_csv: "{output_dir}/metrics_summary.csv"',
            "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
            "  - experiments/results/m.csv",
            "outputs:", "  candidateCsv:", '    - "experiments/results/m.csv"',
            'runner: { test_command: "python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}" }',
            "",
        ])
        d = Path(tempfile.mkdtemp(prefix="cs-py-viai-"))
        write(d / "configs" / "base.yaml", "x: 1\n")
        write(d / "experiments" / "plans" / "p.yaml", via)
        r = run_check(d)
        self.assertTrue(any(i.get("id") == "test_command_via_injection" for i in r["infos"]))
        self.assertFalse(any(w.get("id") == "test_command_via_injection" for w in r["warnings"]))
        self.assertFalse(any(f.get("id") == "output_contract_big_table_via_injection"
                             for f in r["warnings"] + r["infos"]))
        # G10:多分片 + paper 大表名不对齐 + 缺接线 -> warning；带接线反例不报
        shard = "\n".join([
            "suite: s", "mode: test", "base_config: configs/base.yaml", "seeds: [0]",
            "cases:", "  - name: shard_a", "  - name: shard_b",
            "paper:", '  result_csv: "{output_dir}/metrics_summary.csv"',
            "expectedResults:", '  - "{output_dir}/metrics_summary.csv"',
            "  - experiments/results/paper_all.csv",
            'runner: { test_command: "python test.py --config {config} --output-dir {output_dir}" }',
            "",
        ])
        d2 = Path(tempfile.mkdtemp(prefix="cs-py-shard-"))
        write(d2 / "configs" / "base.yaml", "x: 1\n")
        write(d2 / "experiments" / "plans" / "p.yaml", shard)
        r2 = run_check(d2)
        self.assertTrue(any(w.get("id") == "sharded_big_table_mismatch" for w in r2["warnings"]))
        d3 = Path(tempfile.mkdtemp(prefix="cs-py-shardok-"))
        write(d3 / "configs" / "base.yaml", "x: 1\n")
        write(d3 / "experiments" / "plans" / "p.yaml",
              shard.replace("--output-dir {output_dir}\" }", "--output-dir {output_dir} --case {case} --seed {seed}\" }"))
        r3 = run_check(d3)
        self.assertFalse(any(f.get("id") == "sharded_big_table_mismatch"
                             for f in r3["warnings"] + r3["errors"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
