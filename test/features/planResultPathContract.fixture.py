"""CPU/read-only replay of real PLAN parsing and the project's actual path guard.
No Agent/Scheduler module entry points, inference, writes to the project or GPU calls.
"""
import ast
import contextlib
import copy
import io
import json
import os
import pathlib
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions

runtime = pathlib.Path(__file__).resolve().parents[2] / "dist/runtime/cluster_scheduler.py"
scheduler = extract_runtime_functions(str(runtime), ["build_jobs", "load_plan", "run_job_mode", "render_command", "wrapper_context",
    "write_job_config", "result_path_preflight", "validate_plan_mode", "dry_run_plan_mode"])
if sys.argv[1] == "--generic":
    project = pathlib.Path.cwd()
    virtual_plan = {"_file": "experiments/plans/quality_composition/fixture.yaml", "suite": "formal", "mode": "test", "seeds": [42, 43],
                    "base_config": {"test": {"results_csv": "stale.csv"}, "runtime": {"result_csv": "stale.csv"}},
                    "paper": {"result_csv": "tmp/result/quality_composition/{case}/seed{seed}/metrics.csv"},
                    "runner": {"test_command": "python test.py --result-csv {result_csv}"}, "cases": [{"case": "one"}]}
    _, virtual_jobs = scheduler.build_jobs(virtual_plan)
    resolved = [scheduler.bind_execution_result_paths(item, item.output_dir) for item in virtual_jobs]
    assert len({item.result_csv for item in resolved}) == 2
    assert scheduler.result_path_preflight(project, virtual_jobs)["ok"]
    for item in resolved:
        assert item.config["test"]["results_csv"] == item.config["runtime"]["result_csv"] == item.config["paper"]["result_csv"] == item.result_csv
        assert item.config["runtime"]["result_path_contract"]["declared_result_csv"].startswith("tmp/result/")
    assert not scheduler.result_path_preflight(project, [resolved[0], resolved[0]], include_attempt=False)["ok"]
    literal = scheduler.replace(virtual_jobs[0], test_command="python test.py --result-csv stale.csv")
    assert not scheduler.result_path_preflight(project, [literal])["ok"]
    assert scheduler.result_path_preflight(project, [literal], execution_mode="train")["ok"]
    train_plan = {**virtual_plan, "mode": "train", "runner": {"train_command": "train", "test_command": "python test.py --result-csv stale.csv"}}
    _, train_jobs = scheduler.build_jobs(train_plan)
    assert scheduler.result_path_preflight(project, train_jobs)["ok"], "unused test command must not block train mode"
    print(json.dumps({"ok": True, "csvs": [item.result_csv for item in resolved]}))
    sys.exit(0)
raise SystemExit("only the portable --generic fixture is supported; retired research experiment is not accessed")
