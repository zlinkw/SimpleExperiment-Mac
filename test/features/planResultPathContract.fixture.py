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
project = pathlib.Path(sys.argv[1]).resolve()
os.chdir(project)
plan_file = "experiments/plans/quality_composition/late_fusion.yaml"
plan = scheduler.load_plan(plan_file)
_, jobs = scheduler.build_jobs(plan)
captured = []
args = SimpleNamespace(debug_mode=False, plan=plan_file, mode="", only_index=0, worker_id="fixture", gpu_ids="",
                       default_result_csv_dir="experiments/results", output_dir_override=jobs[0].output_dir)
with patch.object(scheduler, "run_job", lambda job, args: captured.append(job)), \
     patch.dict(os.environ, {"SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS": "1"}), contextlib.redirect_stdout(io.StringIO()):
    scheduler.run_job_mode(args)
job = captured[0]

class Config(dict):
    def __getattr__(self, name):
        return self[name]

def config(value):
    return Config({key: config(item) for key, item in value.items()}) if isinstance(value, dict) else value

quality_file = project / "experiments/quality_composition.py"
tree = ast.parse(quality_file.read_text(encoding="utf-8"))
guard = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "check_quality_paths")
namespace = {"Path": pathlib.Path, "Any": object, "PROJECT_ROOT": project, "validate_quality_config": lambda cfg: None}
helper = project / "experiments/quality_paths.py"
if helper.is_file():
    import importlib.util
    spec = importlib.util.spec_from_file_location("quality_path_fixture", helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    namespace["check_quality_locations"] = module.check_quality_locations
exec(compile(ast.Module(body=[guard], type_ignores=[]), str(quality_file), "exec"), namespace)
error = ""
try:
    namespace["check_quality_paths"](config(job.config), job.result_csv)
except ValueError as exc:
    error = str(exc)
command = scheduler.render_command(job.test_command, job, pathlib.Path(job.output_dir) / "job_config.yaml", args)
result = {"path_error": error, "declared": jobs[0].result_csv, "execution": job.result_csv,
          "command_result": command[command.index("--result-csv") + 1], "test_config": job.config.get("test", {}).get("results_csv"),
          "runtime_config": job.config.get("runtime", {}).get("result_csv"), "paper_config": job.config.get("paper", {}).get("result_csv"),
          "contract": job.config.get("runtime", {}).get("result_path_contract")}

# Exercise the real scheduler preflight and the exact same lightweight project
# guard used at execution, without importing model/dataset/Agent entry points.
result["preflight"] = scheduler.result_path_preflight(project, jobs)
result["quality_plan_preflights"] = {}
for filename in sorted((project / "experiments/plans/quality_composition").rglob("*.yaml")):
    _, other_jobs = scheduler.build_jobs(scheduler.load_plan(filename.relative_to(project).as_posix()))
    result["quality_plan_preflights"][filename.relative_to(project).as_posix()] = scheduler.result_path_preflight(project, other_jobs)
relocated = [scheduler.bind_execution_result_paths(item, item.output_dir) for item in jobs]
result["isolated_csvs"] = [item.result_csv for item in relocated]
result["collection_csvs"] = [item.config["runtime"]["result_path_contract"]["collection_result_csv"] for item in relocated]
try:
    scheduler.bind_execution_result_paths(jobs[0], jobs[0].output_dir + "/attempts/replay-two")
except ValueError as exc:
    result["attempt_rejection"] = str(exc)
result["shared_preflight"] = scheduler.result_path_preflight(project, [job, job], include_attempt=False)
literal = scheduler.replace(jobs[0], test_command="python test.py --result-csv stale.csv")
result["literal_preflight"] = scheduler.result_path_preflight(project, [literal])
cwd_job = scheduler.replace(job, working_directory="experiments")
cwd_job = scheduler.bind_execution_result_paths(cwd_job, jobs[0].output_dir)
cwd_command = scheduler.render_command(cwd_job.test_command, cwd_job, pathlib.Path(cwd_job.output_dir) / "job_config.yaml", args)
result["cwd_csv"] = cwd_command[cwd_command.index("--result-csv") + 1]
result["cwd_config_csv"] = cwd_job.config["test"]["results_csv"]

bad = copy.deepcopy(job.config)
bad["runtime"].pop("result_path_contract")
unbound = scheduler.replace(job, config=bad)
result["unbound_preflight"] = scheduler.result_path_preflight(project, [unbound], include_attempt=False)
blocked = []
with patch.object(scheduler, "build_jobs", lambda *a: (plan, [unbound])), \
     patch.object(scheduler, "jobs_for_args", lambda *a: [unbound]), \
     patch.object(scheduler, "run_job", lambda *a: (_ for _ in ()).throw(AssertionError("launched"))), \
     patch.object(scheduler, "refresh_missing_worker_availability", lambda *a: (_ for _ in ()).throw(AssertionError("Worker contacted"))):
    for fn in (scheduler.validate_plan_mode, scheduler.dry_run_plan_mode):
        try:
            fn(args)
        except SystemExit as exc:
            blocked.append(str(exc))
result["blocked_before_dispatch"] = blocked

# Queued identity must match the current PLAN; no stale mode/config/path may run.
args.plan_revision = "0" * 64
with patch.object(scheduler, "run_job", lambda *a: (_ for _ in ()).throw(AssertionError("launched stale PLAN"))):
    try:
        scheduler.run_job_mode(args)
    except SystemExit as exc:
        result["stale_revision"] = str(exc)
args.plan_revision = scheduler.hashlib.sha256((project / plan_file).read_bytes()).hexdigest()
captured.clear()
with patch.object(scheduler, "run_job", lambda item, _args: captured.append(item)), \
     patch.dict(os.environ, {"SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS": "1"}), contextlib.redirect_stdout(io.StringIO()):
    scheduler.run_job_mode(args)
result["fresh_revision_csv"] = captured[0].result_csv

# Use the real config writer and project's snapshot writer, intercepting all
# writes in memory. Their serialized configs, wrapper context and collector agree.
writes = {}
def capture_write(filename, text, **kw):
    assert kw.get("encoding") == "utf-8"
    writes[str(filename)] = text
    return len(text)
with patch.object(pathlib.Path, "mkdir", lambda *a, **kw: None), patch.object(pathlib.Path, "write_text", capture_write):
    config_path = scheduler.write_job_config(job)
writer = project / "experiments/simple_adapter/result_writer.py"
writer_tree = ast.parse(writer.read_text(encoding="utf-8"))
snapshot = next(node for node in writer_tree.body if isinstance(node, ast.FunctionDef) and node.name == "write_config_snapshot")
snapshot_ns = {"Path": pathlib.Path}
exec(compile(ast.Module(body=[snapshot], type_ignores=[]), str(writer), "exec"), snapshot_ns)
config_body = writes[str(config_path)]
with patch.object(pathlib.Path, "exists", lambda *a: True), patch.object(pathlib.Path, "is_file", lambda *a: True), \
     patch.object(pathlib.Path, "mkdir", lambda *a, **kw: None), \
     patch.object(pathlib.Path, "read_text", lambda *a, **kw: config_body), patch.object(pathlib.Path, "write_text", capture_write):
    snapshot_ns["write_config_snapshot"](pathlib.Path(job.output_dir) / "config_snapshot.yaml", config_path)
    result["wrapper_context"] = scheduler.wrapper_context(job, config_path, args, "test")
result["snapshot_config"] = scheduler.yaml.safe_load(writes[str(pathlib.Path(job.output_dir) / "config_snapshot.yaml")])

# Actual adapter manifest writer feeds the plugin's actual declaration collector.
manifest_nodes = [node for node in writer_tree.body if isinstance(node, ast.FunctionDef)
                  and node.name in ("_display_path", "write_artifact_manifest")]
manifest_ns = {"Path": pathlib.Path, "Any": object, "SCHEMA_VERSION": "simple-output-v1", "now_iso": lambda: "fixture",
               "write_json": lambda path, description, value: result.update(manifest=value)}
exec(compile(ast.Module(body=manifest_nodes, type_ignores=[]), str(writer), "exec"), manifest_ns)
manifest_ns["write_artifact_manifest"](pathlib.Path(job.output_dir) / "artifact_manifest.json", job.output_dir,
    config_path=str(pathlib.Path(job.output_dir) / "config_snapshot.yaml"),
    metrics_summary_path=job.output_dir + "/metrics_summary.csv", extra_artifacts={"result_csv": job.result_csv})

rejections = []
for mutation in ("shared", "escape", "pressure", "config_mismatch"):
    altered = copy.deepcopy(job.config)
    target = job.result_csv
    if mutation == "shared":
        target = "experiments/results/shared.csv"
    elif mutation == "escape":
        target = "tmp/result/quality_composition/../../../shared.csv"
    elif mutation == "unbound":
        altered["runtime"].pop("result_path_contract")
    elif mutation == "pressure":
        altered["data"]["protocol"]["pressure_matrix"] = True
    else:
        altered["test"]["results_csv"] = "tmp/result/quality_composition/stale.csv"
        try:
            module.validate_result_paths(altered, {**job.config["runtime"]["result_path_contract"], "project_root": str(project)})
        except ValueError:
            rejections.append(mutation)
        continue
    try:
        namespace["check_quality_paths"](config(altered), target)
    except ValueError:
        rejections.append(mutation)
result["guard_rejections"] = rejections

# Formal PLAN + tmp/result never invokes the retained legacy draft snapshot.
agent = extract_runtime_functions(str(runtime.parent / "cluster_agent.py"), ["prepare_draft_run_plan"])
with patch.object(agent, "materialize_draft_snapshot", lambda *a: (_ for _ in ()).throw(AssertionError("draft snapshot called")), create=True):
    result["execution_plan"] = agent.prepare_draft_run_plan(str(project), plan_file, False)

# Verify an unchanged PLAN still declares tmp/result, and preflight makes zero
# file writes even for refused policies. Do not create any real project outputs.
with patch("builtins.open", wraps=open) as opening, patch.object(pathlib.Path, "write_text", side_effect=AssertionError("preflight wrote a file")), \
     patch.object(pathlib.Path, "mkdir", side_effect=AssertionError("preflight created a directory")):
    scheduler.result_path_preflight(project, jobs)
    scheduler.result_path_preflight(project, [unbound], include_attempt=False)
    result["preflight_writes"] = [str(call) for call in opening.call_args_list if len(call.args) > 1 and any(letter in call.args[1] for letter in "wax+")]
print(json.dumps(result, ensure_ascii=False))
