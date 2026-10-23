"""Function-only admission/diagnostics and seven synthetic PLAN messages, no research checkout."""
import argparse
import copy
import hashlib
import json
import os
import pathlib
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
runtime = pathlib.Path(__file__).resolve().parents[2] / "dist/runtime"
agent = extract_runtime_functions(str(runtime / "cluster_agent.py"), ["job_shell_environment_prefix", "fresh_task_runtime_env", "tmux_task_client_env", "worker_task_failure_diagnostic"])
scheduler = extract_runtime_functions(str(runtime / "cluster_scheduler.py"), ["formal_job_preflight", "run_job", "launch_experiment"])
identity = {"workflowId": "wf", "commandId": "cmd", "globalJobId": "wf:0", "planRevision": "rev", "codeFingerprint": "code", "index": 0}
env = {"SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY": json.dumps(identity), "SIMPLE_EXPERIMENT_JOB_COMMAND_ID": "cmd", "SIMPLE_EXPERIMENT_MANAGED_JOB": "1"}
assert agent.tmux_task_client_env({**env, "AGENT_API_TOKEN": "fixture-secret", "PATH": "fixture-path"}) == {"PATH": "fixture-path"}
assert "SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY=" in agent.job_shell_environment_prefix(env, ["--only-index", "0", "--plan-revision", "rev"])
for change, token in (({"workflowId": ""}, "missing=workflowId"), ({"globalJobId": "wf:1"}, "fields=index"),
                       ({"commandId": "foreign"}, "fields=commandId")):
    altered = {**env, "SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY": json.dumps({**identity, **change})}
    try:
        agent.job_shell_environment_prefix(altered)
    except ValueError as exc:
        assert token in str(exc), str(exc)
    else:
        raise AssertionError("invalid identity forwarded")
for raw in ("", "not-json", "[]"):
    try:
        agent.job_shell_environment_prefix({**env, "SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY": raw})
    except ValueError as exc:
        assert "FORMAL_JOB_IDENTITY_REQUIRED" in str(exc)
    else:
        raise AssertionError("missing/invalid JSON allowed")
with patch.dict(os.environ, {**env, "SIMPLE_EXPERIMENT_CHECKPOINT_TEST_ONLY": "1", "SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS": "1", "CUDA_VISIBLE_DEVICES": "9"}):
    cleaned = agent.fresh_task_runtime_env()
    assert not any(key in cleaned for key in env)
    assert "SIMPLE_EXPERIMENT_CHECKPOINT_TEST_ONLY" not in cleaned and "CUDA_VISIBLE_DEVICES" not in cleaned
root = pathlib.Path(tempfile.mkdtemp(prefix="simple-identity-diagnostic-")).resolve()
virtual = SimpleNamespace(index=0, case="fixture", seed=42, output_dir="work/fixture", result_csv="tmp/result/fixture.csv",
    working_directory=".", train_command="", config={"runtime": {"result_path_contract": {"policy": "declared"}}}, template_values={"plan_revision": "rev"})
for raw in ("", "not-json", "[]", json.dumps({key: value for key, value in identity.items() if key != "globalJobId"})):
    with patch.dict(os.environ, {"SIMPLE_EXPERIMENT_MANAGED_JOB": "1", "SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY": raw}), \
         patch.object(scheduler, "formal_source_fingerprint", side_effect=AssertionError("invalid identity must fail before source scanning")):
        try:
            scheduler.run_job(virtual, argparse.Namespace(mode="train_test"))
        except ValueError as exc:
            assert "FORMAL_JOB_IDENTITY_REQUIRED" in str(exc), str(exc)
        else:
            raise AssertionError("missing raw identity silently reconstructed")
previous_cwd = pathlib.Path.cwd()
os.chdir(root)
(root / virtual.output_dir / "attempts" / "old").mkdir(parents=True)
old_log = root / virtual.output_dir / "attempts" / "old" / "stderr.log"
old_log.write_bytes(b"protected historical evidence")
try:
    scheduler.formal_job_preflight(virtual, identity, "train_test")
except scheduler.FormalJobConflictError as exc:
    assert exc.evidence["onlyHistoricalAttemptsDirectory"] and not exc.evidence["ownerExists"]
    assert exc.evidence["hashesVerified"] is False and exc.evidence["lockState"] == "absent"
else:
    raise AssertionError("historical parent adopted")
assert old_log.read_bytes() == b"protected historical evidence"
os.chdir(previous_cwd)
log = agent.worker_task_console_log("cmd")
(root / log).parent.mkdir(parents=True)
trace = "Traceback (most recent call last):\n  File 'scheduler.py', line 1, in formal_job_writer\nValueError: FORMAL_JOB_IDENTITY_REQUIRED: missing=workflowId,commandId\n"
(root / log).write_bytes(trace.encode("utf-8"))
task = {"commandId": "cmd", "runKey": "cmd", "tmuxPane": "%184", "tmuxSession": "probe-gpu", "tmuxWindowId": "@12", "logPath": log}
report = agent.worker_task_failure_diagnostic(str(root), task)
assert report["failureDiagnostic"]["traceback"] == trace and report["failureDiagnostic"]["tmuxPane"] == "%184"
assert "missing=workflowId,commandId" in report["error"]
assert not agent.worker_task_failure_diagnostic(str(root), {**task, "commandId": "foreign"})
assert not agent.worker_task_failure_diagnostic(str(root), {**task, "logPath": "tmp/tmux_logs/gpu-0.log"})

# The deleted consumer experiment is not part of plugin acceptance. Exercise the
# same 20 dispatch identities with independent, retained portable PLAN inputs.
project = root / "portable-project"
folder = project / "plans"
folder.mkdir(parents=True)
for index in range(7):
    count = 3 if index < 6 else 2
    config = {"fixture": {"variant": index < 6}}
    plan = {"suite": "portable_" + str(index), "mode": ["train", "test", "train_test"][index % 3],
        "base_config": config, "seeds": [42],
        "runner": {"train_command": "python train.py", "test_command": "python test.py --result-csv {result_csv}"},
        "paper": {"result_csv": "tmp/result/{suite}/{case}/seed{seed}/metrics.csv"},
        "cases": [{"case": "case_" + str(item)} for item in range(count)]}
    (folder / (str(index) + ".yaml")).write_text(json.dumps(plan), encoding="utf-8")
os.chdir(project)
files = sorted(folder.glob("*.yaml"))
assert len(files) == 7
pressure = reference = 0
messages = []
worker = {"id": "fixture-worker", "project_dir": str(project), "conda_env": "fixture-only",
          "_availability": {"declaredJobPaths": True, "formalJobIdentityEnv": 1, "runtimeVersion": scheduler.RUNTIME_VERSION},
          "_availability_received_monotonic": scheduler.time.monotonic()}
with patch.object(scheduler, "scheduler_agent_state_dir", lambda: root / "message-state"), \
     patch.object(scheduler, "formal_source_fingerprint", lambda _: hashlib.sha256(b"fixture-preverified-code-proof").hexdigest()), \
     patch.object(scheduler.urllib.request, "urlopen", side_effect=AssertionError("network forbidden")):
    for filename in files:
        plan_file = filename.relative_to(project).as_posix()
        loaded = scheduler.load_plan(plan_file)
        _, jobs = scheduler.build_jobs(loaded)
        for job in jobs:
            assert job.seed == 42 and job.config["fixture"]["variant"] == (filename.stem != "6")
            if job.config["fixture"]["variant"]:
                pressure += 1
            else:
                reference += 1
            workflow = "contract-" + str(len(messages))
            scheduler.launch_experiment(worker, plan_file, job.index, "0", root / "fixture-logs", mode=loaded["mode"],
                case_name=job.case, seed=job.seed, workflow_id=workflow, output_dir=job.output_dir)
            message = json.loads((root / "message-state/worker_commands_fixture-worker.jsonl").read_text(encoding="utf-8").splitlines()[-1])
            assert message["globalJobId"] == workflow + ":" + str(job.index)
            assert message["outputDir"] == job.output_dir and message["collectionResultCsv"] == job.result_csv
            assert message["planRevision"] == loaded["_revision"] and message["codeFingerprint"]
            assert "attempts/" not in message["outputDir"]
            original = {key: message[key] for key in ("workflowId", "commandId", "globalJobId", "planRevision", "codeFingerprint")}
            original["index"] = job.index
            prefix = agent.job_shell_environment_prefix({"SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY": json.dumps(original, ensure_ascii=False),
                "SIMPLE_EXPERIMENT_JOB_COMMAND_ID": message["commandId"], "SIMPLE_EXPERIMENT_MANAGED_JOB": "1"},
                ["--only-index", str(job.index), "--plan-revision", loaded["_revision"]])
            assert "SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY=" in prefix
            messages.append(message)
assert (pressure, reference) == (18, 2), (pressure, reference)
print(json.dumps({"ok": True, "plans": len(files), "pressure": pressure, "reference": reference, "messages": len(messages)}, ensure_ascii=False))
