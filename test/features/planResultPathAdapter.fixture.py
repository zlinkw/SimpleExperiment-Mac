"""Production path/config/adapter integration in a dedicated, retained fixture only."""
import copy
import json
import os
import pathlib
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions

repo = pathlib.Path(__file__).resolve().parents[2]
scheduler = extract_runtime_functions(str(repo / "dist/runtime/cluster_scheduler.py"),
    ["build_jobs", "load_plan", "render_command", "wrapper_context", "write_job_config", "result_path_preflight"])
root = pathlib.Path(sys.argv[1]).resolve()
assert root.name.startswith("simple-plan-adapter-") and (root / "result_writer.py").is_file()
os.chdir(root)
plan_file = root / "experiments/plans/fixture.yaml"
plan_file.parent.mkdir(parents=True)
plan_file.write_text(json.dumps({"suite": "formal", "mode": "test", "seeds": [42, 43],
    "base_config": {"test": {"results_csv": "stale.csv"}, "runtime": {"result_csv": "stale.csv"}},
    "paper": {"result_csv": "tmp/result/{case}/seed{seed}/metrics.csv"},
    "runner": {"test_command": "python test.py --result-csv {result_csv}"}, "cases": [{"case": "one"}]}), encoding="utf-8")
_, jobs = scheduler.build_jobs(scheduler.load_plan(plan_file))
assert len(jobs) == 2 and len({job.result_csv for job in jobs}) == 2
with patch.object(pathlib.Path, "mkdir", side_effect=AssertionError("preflight created a directory")), \
     patch.object(pathlib.Path, "write_text", side_effect=AssertionError("preflight wrote a file")):
    assert scheduler.result_path_preflight(root, jobs)["ok"]
    assert not scheduler.result_path_preflight(root, [jobs[0], jobs[0]])["ok"]
    assert not scheduler.result_path_preflight(root, [scheduler.replace(jobs[0], test_command="python test.py --result-csv stale.csv")])["ok"]
    bad = copy.deepcopy(jobs[0].config)
    bad["runtime"].pop("result_path_contract")
    assert not scheduler.result_path_preflight(root, [scheduler.replace(jobs[0], config=bad)])["ok"]

adapter = extract_runtime_functions(str(root / "result_writer.py"), ["DefaultDeepLearningAdapter"])
# Discovery leaves read only this fixture; no external dataset, metric or training.
adapter.discover_csv_metrics = adapter.discover_json_metrics = adapter.discover_text_metrics = lambda *_: []
results = []
args = SimpleNamespace(worker_id="fixture", gpu_ids="", mode="test", debug_mode=False, plan=str(plan_file))
for job in jobs:
    job = scheduler.bind_execution_result_paths(job, job.output_dir)
    contract = job.config["runtime"]["result_path_contract"]
    assert "attempt" not in contract
    assert contract["declared_result_csv"] == contract["execution_result_csv"] == contract["collection_result_csv"] == job.result_csv
    config_file = scheduler.write_job_config(job)
    command = scheduler.render_command(job.test_command, job, config_file, args)
    assert command[command.index("--result-csv") + 1] == job.result_csv
    context = scheduler.wrapper_context(job, config_file, args, "test")
    assert context["result_csv"] == job.result_csv
    manifest = adapter.DefaultDeepLearningAdapter().collect(job.output_dir, context)
    snapshot = scheduler.yaml.safe_load((root / job.output_dir / "config_snapshot.yaml").read_text(encoding="utf-8"))
    for section, key in [("test", "results_csv"), ("runtime", "result_csv"), ("paper", "result_csv")]:
        assert snapshot[section][key] == job.result_csv
    try:
        scheduler.bind_execution_result_paths(job, job.output_dir + "/attempts/foreign")
    except ValueError as exc:
        assert "RESULT_PATH_DECLARATION_CHANGED" in str(exc)
    else:
        raise AssertionError("changed declared output was accepted")
    results.append({"outputDir": job.output_dir, "resultCsv": job.result_csv, "manifest": manifest})
print(json.dumps({"ok": True, "jobs": results}))
