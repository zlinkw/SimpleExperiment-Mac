"""Lightweight shell-boundary probe, never a research train/test entry point."""
import json
import os
import pathlib
import sys
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
scheduler = extract_runtime_functions(str(pathlib.Path(__file__).resolve().parents[2] / "dist/runtime/cluster_scheduler.py"), ["formal_job_writer"])
spec = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
raw = os.environ.get("SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY")
job = SimpleNamespace(index=spec["index"], case="probe", seed=42, output_dir="jobs/" + str(spec["index"]),
    result_csv="tmp/result/" + str(spec["index"]) + ".csv", working_directory=".", train_command="",
    config={"runtime": {"result_path_contract": {"policy": "declared"}}}, template_values={"plan_revision": spec["revision"]})
report = {"raw": raw, "writerEntered": False, "error": "", "environment": {
    key: os.environ.get(key) for key in ("SIMPLE_EXPERIMENT_CHECKPOINT_TEST_ONLY", "SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS",
        "CUDA_VISIBLE_DEVICES", "SIMPLE_EXPERIMENT_JOB_COMMAND_ID", "SIMPLE_EXPERIMENT_CONDA_ENV", "AGENT_API_TOKEN")}}
class ProbeComplete(Exception):
    pass
try:
    identity = json.loads(raw) if raw else {}
    with scheduler.formal_job_writer(job, identity, "train_test"):
        report["writerEntered"] = True
        raise ProbeComplete()  # Never manufacture a completed scientific result.
except ProbeComplete:
    pass
except Exception as exc:
    report["error"] = str(exc)
if report["writerEntered"]:
    owner = pathlib.Path(job.output_dir) / "formal_job_owner.json"
    before = owner.read_bytes()
    report["rejections"] = []
    for change in ({"workflowId": ""}, {"globalJobId": "other:9"}, {"commandId": "other-command"}):
        try:
            scheduler.formal_job_preflight(job, {**identity, **change}, "train_test")
        except ValueError as exc:
            assert str(exc).startswith(("FORMAL_JOB_IDENTITY_REQUIRED", "FORMAL_JOB_IDENTITY_MISMATCH")), str(exc)
            report["rejections"].append(str(exc))
        else:
            raise AssertionError("corrupted/cross-job identity entered writer")
    assert owner.read_bytes() == before
pathlib.Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
