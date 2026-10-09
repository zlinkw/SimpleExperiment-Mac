"""Isolated mode/output-gate tests: no Agent entry points, files, or training processes."""
import contextlib
import io
import json
import pathlib
import sys
from types import SimpleNamespace
from unittest.mock import mock_open, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions

runtime = pathlib.Path(__file__).resolve().parents[2] / "dist/runtime"
kind = sys.argv[1]
if kind == "agent":
    agent = extract_runtime_functions(str(runtime / "cluster_agent.py"), ["worker_command_plan_mode", "plan_output_capture_evidence"])
    text = "mode: train\nrunner:\n  train_command: python train.py\n  test_command: python stale_eval.py --result-csv work_dirs/metrics_summary.csv\n"
    with patch.object(agent, "safe_project_path", lambda root, plan: str(pathlib.Path(root) / plan)), \
         patch.object(pathlib.Path, "read_text", lambda *args, **kwargs: text), \
         patch("builtins.open", mock_open(read_data=text)), \
         patch.object(agent, "read_project_metric_policy", lambda root: {"explicitResultCandidates": []}):
        print(json.dumps({"mode": agent.worker_command_plan_mode("virtual-project", "train.yaml"), "gate": agent.plan_output_capture_evidence("virtual-project", "train.yaml")}))
elif kind == "scheduler":
    scheduler = extract_runtime_functions(str(runtime / "cluster_scheduler.py"), ["plan_execution_mode", "run_job", "run_job_mode", "validate_plan_mode", "dry_run_plan_mode"])
    result = {}
    for mode in ("train", "test", "train_test"):
        commands = []
        verified = []
        plan = {"mode": mode, "runner": {"train_command": "train", "test_command": "test"}}
        job = SimpleNamespace(index=0, case="baseline", seed=0, output_dir="virtual-output", result_csv="virtual.csv", train_command="train", test_command="test", working_directory=".", collect_metrics=False, inputs=(), outputs=())
        args = SimpleNamespace(mode="", plan="virtual.yaml", default_result_csv_dir="experiments/results", workers_json="", worker_status_ttl_seconds=60, availability_path="", resume=False, gpu_ids="", worker_id="local")
        with contextlib.ExitStack() as scope:
            replacements = {
                "load_plan": lambda *a: plan,
                "build_jobs": lambda *a: (plan, [job]),
                "jobs_for_args": lambda *a: [job],
                "output_interface_report": lambda *a: {"ok": True, "missing": []},
                "detect_existing_outputs": lambda *a: [],
                "read_availability_cache": lambda *a: None,
                "refresh_missing_worker_availability": lambda *a: None,
                "write_job_config": lambda *a: "virtual-config.yaml",
                "render_command": lambda command, *a: [command],
                "wrap_command": lambda command, *a: command,
                "original_log_offsets": lambda *a: {},
                "run_command": lambda command, *a: commands.append(command[0]),
                "verify_declared_outputs": lambda *a: verified.append(True),
            }
            for key, replacement in replacements.items():
                scope.enter_context(patch.object(scheduler, key, replacement))
            scope.enter_context(patch.dict(scheduler.os.environ, {}, clear=True))
            validation = io.StringIO()
            with contextlib.redirect_stdout(validation):
                scheduler.validate_plan_mode(args)
            preview = io.StringIO()
            with contextlib.redirect_stdout(preview):
                scheduler.dry_run_plan_mode(args)
            args.mode = scheduler.plan_execution_mode(plan)
            scheduler.run_job(job, args)
            if mode == "train":
                # Empty test_command must never fall through to the default test.py.
                job.test_command = ""
                scheduler.run_job(job, args)
                assert commands == ["train", "train"]
                commands.pop()
                verified.pop()
                args.mode = "train_test"
                with patch.dict(scheduler.os.environ, {"SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS": "1"}):
                    args.debug_mode = False
                    try:
                        scheduler.run_job_mode(args)
                    except SystemExit as exc:
                        assert "execution mode disagrees" in str(exc)
                    else:
                        raise AssertionError("PLAN train mode was widened by Worker args")
            result[mode] = {"validation": json.loads(validation.getvalue()), "preview": json.loads(preview.getvalue()), "commands": commands, "verified": verified}
    print(json.dumps(result))
else:
    raise AssertionError(kind)
