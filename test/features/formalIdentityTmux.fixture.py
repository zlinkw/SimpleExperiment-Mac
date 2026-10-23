"""Real isolated, already-running tmux server; production launch functions only."""
import concurrent.futures
import json
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from closeFixtureTmuxWindows import close_fixture_tmux_windows
repo = pathlib.Path(__file__).resolve().parents[2]
agent = extract_runtime_functions(str(repo / "dist/runtime/cluster_agent.py"), ["start_job_in_gpu_pane", "start_simple_tmux_command", "worker_task_tmux_location"])
mode = sys.argv[1]
root = pathlib.Path(tempfile.mkdtemp(prefix="simple-identity-tmux-")).resolve()
probe_source = "\"\"\"Lightweight shell-boundary probe, never a research train/test entry point.\"\"\"\nimport json\nimport os\nimport pathlib\nimport sys\nfrom types import SimpleNamespace\n\nsys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / \"_helpers\"))\nfrom extractRuntimeFunctions import extract_runtime_functions\nscheduler = extract_runtime_functions(str(pathlib.Path(__file__).resolve().parents[2] / \"dist/runtime/cluster_scheduler.py\"), [\"formal_job_writer\"])\nspec = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding=\"utf-8\"))\nraw = os.environ.get(\"SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY\")\njob = SimpleNamespace(index=spec[\"index\"], case=\"probe\", seed=42, output_dir=\"jobs/\" + str(spec[\"index\"]),\n    result_csv=\"tmp/result/\" + str(spec[\"index\"]) + \".csv\", working_directory=\".\", train_command=\"\",\n    config={\"runtime\": {\"result_path_contract\": {\"policy\": \"declared\"}}}, template_values={\"plan_revision\": spec[\"revision\"]})\nreport = {\"raw\": raw, \"writerEntered\": False, \"error\": \"\", \"environment\": {\n    key: os.environ.get(key) for key in (\"SIMPLE_EXPERIMENT_CHECKPOINT_TEST_ONLY\", \"SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS\",\n        \"CUDA_VISIBLE_DEVICES\", \"SIMPLE_EXPERIMENT_JOB_COMMAND_ID\", \"SIMPLE_EXPERIMENT_CONDA_ENV\", \"AGENT_API_TOKEN\")}}\nclass ProbeComplete(Exception):\n    pass\ntry:\n    identity = json.loads(raw) if raw else {}\n    with scheduler.formal_job_writer(job, identity, \"train_test\"):\n        report[\"writerEntered\"] = True\n        raise ProbeComplete()  # Never manufacture a completed scientific result.\nexcept ProbeComplete:\n    pass\nexcept Exception as exc:\n    report[\"error\"] = str(exc)\nif report[\"writerEntered\"]:\n    owner = pathlib.Path(job.output_dir) / \"formal_job_owner.json\"\n    before = owner.read_bytes()\n    report[\"rejections\"] = []\n    for change in ({\"workflowId\": \"\"}, {\"globalJobId\": \"other:9\"}, {\"commandId\": \"other-command\"}):\n        try:\n            scheduler.formal_job_preflight(job, {**identity, **change}, \"train_test\")\n        except ValueError as exc:\n            assert str(exc).startswith((\"FORMAL_JOB_IDENTITY_REQUIRED\", \"FORMAL_JOB_IDENTITY_MISMATCH\")), str(exc)\n            report[\"rejections\"].append(str(exc))\n        else:\n            raise AssertionError(\"corrupted/cross-job identity entered writer\")\n    assert owner.read_bytes() == before\npathlib.Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False), encoding=\"utf-8\")\nprint(json.dumps(report, ensure_ascii=False))\n"
probe_source = probe_source.replace('str(pathlib.Path(__file__).resolve().parents[1] / "_helpers")', repr(str(repo / "test/_helpers")))
probe_source = probe_source.replace('str(pathlib.Path(__file__).resolve().parents[2] / "dist/runtime/cluster_scheduler.py")', repr(str(repo / "dist/runtime/cluster_scheduler.py")))
(root / "formalIdentityProbe.py").write_text(probe_source, encoding="utf-8")

socket = "simple-identity-probe-" + str(os.getpid())
wrapper = root / "tmux"
wrapper.write_text("#!/bin/sh\nexec /usr/bin/tmux -L " + shlex.quote(socket) + " -f /dev/null \"$@\"\n", encoding="utf-8")
wrapper.chmod(0o700)
shell = root / "probe-shell"
# 现行 task_shell_args 会把重绑脚本作为 `-lc <script>` 传入登录 shell；夹具 shell 必须透传参数
# （无参时仍是免 profile 的交互 shell，保持建窗快且与用户 rc 隔离的原意）。
shell.write_text("#!/bin/sh\nexec /bin/bash --noprofile --norc \"$@\"\n", encoding="utf-8")
shell.chmod(0o700)
os.environ["PATH"] = str(root) + ":" + os.environ["PATH"]
os.environ["SHELL"] = str(shell)
for key in list(os.environ):
    if key.startswith("SIMPLE_EXPERIMENT_") or key == "CUDA_VISIBLE_DEVICES":
        os.environ.pop(key)
base = os.environ.copy()
subprocess.run([str(wrapper), "new-session", "-d", "-s", "bootstrap", str(shell)], check=True, env=base, timeout=3)
assert subprocess.run([str(wrapper), "show-environment", "-g"], capture_output=True, text=True, timeout=3).returncode == 0
started = []
try:
    def launch(index):
        task_root = root / ("任务 ' " + str(index))
        task_root.mkdir()
        identity = {"workflowId": "workflow 中文 ' space", "commandId": "command \"quoted\" ' " + str(index),
            "globalJobId": "workflow 中文 ' space:" + str(index), "planRevision": "revision", "codeFingerprint": "code",
            "index": index, "opaque": "保留\\斜线\n换行 $() `literal`"}
        raw = json.dumps(identity, ensure_ascii=False, indent=2)
        spec = task_root / "spec.json"
        spec.write_text(json.dumps({"index": index, "revision": "revision"}), encoding="utf-8")
        output = task_root / "received.json"
        env = {**base, "SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY": raw,
            "SIMPLE_EXPERIMENT_JOB_COMMAND_ID": identity["commandId"], "SIMPLE_EXPERIMENT_JOB_PROJECT_ID": "project",
            "SIMPLE_EXPERIMENT_MANAGED_JOB": "1", "CUDA_VISIBLE_DEVICES": str(index), "AGENT_API_TOKEN": "fixture-secret-never-forward"}
        if index == 0:
            env.update(SIMPLE_EXPERIMENT_CHECKPOINT_TEST_ONLY="1", SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS="1")
        args = [sys.executable, "-B", str(root / "formalIdentityProbe.py"), str(spec), str(output)]
        exit_file = task_root / "exit.code"
        session = "probe-gpu-" + str(index) if mode == "gpu" else "simple-sch-probe-" + str(index)
        if mode == "gpu":
            subprocess.run([str(wrapper), "new-session", "-d", "-s", session, str(shell)], check=True, env=base, timeout=3)
            if index == 1:
                for key, value in {"SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY": "stale-other-task", "SIMPLE_EXPERIMENT_CHECKPOINT_TEST_ONLY": "1", "SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS": "1"}.items():
                    subprocess.run([str(wrapper), "set-environment", "-t", session, key, value], check=True, env=base, timeout=3)
            pane = agent.start_job_in_gpu_pane(session, args, str(task_root), env, str(task_root / "task.log"), str(exit_file))
            assert pane.startswith("%")
        else:
            pane = agent.start_simple_tmux_command(session, args, str(task_root), str(task_root / "task.log"), env, str(exit_file))
        started.append(session)
        location = agent.worker_task_tmux_location(pane, session, str(task_root), env)
        assert location["tmuxPane"].startswith("%") and location["tmuxWindowId"].startswith("@")
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and (not output.is_file() or not exit_file.is_file() or exit_file.read_text(encoding="utf-8").strip() == "pending"):
            time.sleep(0.02)
        assert output.is_file(), "Probe never completed"
        report = json.loads(output.read_text(encoding="utf-8"))
        assert report["raw"] == raw, report
        assert report["writerEntered"], report
        assert len(report["rejections"]) == 3
        assert report["environment"]["SIMPLE_EXPERIMENT_CHECKPOINT_TEST_ONLY"] == ("1" if index == 0 else None), report
        assert report["environment"]["SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS"] == ("1" if index == 0 else None), report
        assert report["environment"]["CUDA_VISIBLE_DEVICES"] == str(index), report
        assert report["environment"]["AGENT_API_TOKEN"] is None, report
        assert exit_file.read_text(encoding="utf-8") == "0"
        global_env = subprocess.run([str(wrapper), "show-environment", "-g"], capture_output=True, text=True, timeout=3).stdout
        assert "SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY=" not in global_env
        return {"index": index, "pane": location["tmuxPane"], "window": location["tmuxWindowId"], "rawIdentityEqual": True, "writerEntered": True}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        reports = list(pool.map(launch, [0, 1]))
    print(json.dumps({"ok": True, "mode": mode, "reports": reports, "tmux": subprocess.run(["/usr/bin/tmux", "-V"], capture_output=True, text=True).stdout.strip()}, ensure_ascii=False))
finally:
    # Close only verified window IDs on this fixture socket; retain evidence.
    close_fixture_tmux_windows(lambda args: subprocess.run([str(wrapper), *args], env=base, capture_output=True, text=True, timeout=2), socket_name=socket)
