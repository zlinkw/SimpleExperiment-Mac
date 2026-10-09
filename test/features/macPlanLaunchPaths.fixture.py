"""AST-selected compiled production functions, in-memory POSIX paths, no process/remote business."""
import contextlib
import copy
import hashlib
import io
import json
import os
import pathlib
import posixpath
import stat
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
runtime = pathlib.Path(__file__).resolve().parents[2] / "dist/runtime"
scenario = sys.argv[1]
root = "/Projects/中文 "
plan_name = "experiments/Plans/ A%20.yaml "
output = " work_runs/中文 A /seed_7 "
attempt = output + "/attempts/1 "
result_dir = "experiments/结果 "
nodes = {root: stat.S_IFDIR, root + "/experiments": stat.S_IFDIR,
         root + "/experiments/Plans": stat.S_IFDIR, root + "/" + plan_name: stat.S_IFREG,
         root + "/tmp": stat.S_IFDIR, root + "/tmp/tmux_logs": stat.S_IFDIR}
aliases = {}
mkdirs = []

def info(name):
    actual = aliases.get(name, name)
    if actual not in nodes:
        raise FileNotFoundError(name)
    return SimpleNamespace(st_mode=nodes[actual])

def entries(name):
    prefix = name + "/"
    return [key[len(prefix):] for key in nodes if key.startswith(prefix) and "/" not in key[len(prefix):]]

class MemoryPath(pathlib.PurePosixPath):
    @classmethod
    def cwd(cls): return cls(root)
    def resolve(self): return type(self)(posixpath.normpath(str(self) if self.is_absolute() else root + "/" + str(self)))
    def exists(self): return str(self.resolve()) in nodes
    def is_dir(self): return nodes.get(str(self.resolve())) == stat.S_IFDIR
    def is_file(self): return nodes.get(str(self.resolve())) == stat.S_IFREG

fake_os = SimpleNamespace(**{key: getattr(os, key) for key in dir(os) if not key.startswith("__")})
fake_os.path = SimpleNamespace(**{key: getattr(posixpath, key) for key in dir(posixpath) if not key.startswith("__")})
fake_os.path.abspath = lambda name: posixpath.normpath(name if posixpath.isabs(name) else root + "/" + name)
fake_os.path.realpath = fake_os.path.abspath
fake_os.path.isfile = lambda name: nodes.get(name, stat.S_IFREG) == stat.S_IFREG
fake_os.sep = "/"
fake_os.stat = fake_os.lstat = info
fake_os.listdir = entries
fake_os.makedirs = lambda name, **kwargs: mkdirs.append(name)
fake_os.environ = {}

def rejects(action):
    try: action()
    except (ValueError, SystemExit, FileNotFoundError): return
    raise AssertionError("invalid path accepted")

if scenario in ("physical", "agent", "changed", "revision"):
    agent = extract_runtime_functions(str(runtime / "cluster_agent.py"),
        ["worker_plan_project_path", "_execute_worker_command_unfenced", "verified_durable_execution_mode"])
    agent.os = fake_os
    if scenario == "physical":
        assert agent.worker_plan_project_path(root, plan_name, require_file=True) == root + "/" + plan_name
        assert agent.worker_plan_project_path(root, attempt, directory=True) == root + "/" + attempt
        assert agent.worker_plan_project_path(root, root + "/" + plan_name, require_file=True) == root + "/" + plan_name
        for value in [plan_name.lower(), plan_name.rstrip(), "/Other/plan.yaml", "../plan.yaml", "experiments//a.yaml",
                      "experiments/./a.yaml", "experiments\\a.yaml", "C:/plan.yaml", [], 1, "experiments/a\n.yaml"]:
            rejects(lambda: agent.worker_plan_project_path(root, value, require_file=True))
        alias = root + "/experiments/plans"
        aliases[alias] = root + "/experiments/Plans"
        rejects(lambda: agent.worker_plan_project_path(root, "experiments/plans/ A%20.yaml ", require_file=True))
        nodes[root + "/experiments/Link"] = stat.S_IFLNK
        rejects(lambda: agent.worker_plan_project_path(root, "experiments/Link/a.yaml", require_file=True))
        nodes[root + "/experiments/Plans"] = stat.S_IFREG
        rejects(lambda: agent.worker_plan_project_path(root, plan_name, require_file=True))
        assert agent.worker_path_value({"plan": plan_name}, {"planFile": plan_name}, ("planFile", "plan")) == plan_name
        rejects(lambda: agent.worker_path_value({"plan": plan_name}, {"planFile": plan_name.rstrip()}, ("planFile", "plan")))
    elif scenario == "revision":
        raw = b"mode: train\n" + b"# retained full plan\n" * 70000
        reads = [raw, raw]
        scheduler = SimpleNamespace(load_plan=lambda name: {"mode": "train"}, plan_execution_mode=lambda plan: plan["mode"])
        command = {"planFile": plan_name, "planRevision": hashlib.sha256(raw).hexdigest(), "executionMode": "train"}
        with patch.object(agent, "scalar_scheduler_module", lambda: scheduler), \
             patch.object(pathlib.Path, "read_bytes", lambda _: reads.pop(0)):
            assert agent.verified_durable_execution_mode(root, command) == "train"
            reads[:] = [raw, raw + b"#changed"]
            rejects(lambda: agent.verified_durable_execution_mode(root, command))
            reads[:] = [b"changed"]
            rejects(lambda: agent.verified_durable_execution_mode(root, command))
    else:
        launched, saved = [], []
        command = dict(action="start-worker-task", commandId="launch", planFile=plan_name, plan=plan_name,
                       projectDir=root, projectId="project", planRevision="revision", codeFingerprint="code",
                       experimentIndex=0, attempt=1, outputDir=attempt, configPath=attempt + "/job_config.yaml",
                       mode="train", executionMode="train", condaEnv="env", gpuId="0", session="session",
                       defaultResultCsvDir=result_dir, logPath="tmp/tmux_logs/中文 log ", options={"distributedResults": True})
        def probe(*args):
            if scenario == "changed": nodes[root + "/experiments/Plans"] = stat.S_IFLNK
        replacements = {
            "agent_install_dir": lambda _: root + "/runtime ", "require_scheduler_dependencies": probe,
            "simple_runtime_python": lambda _: "virtual-python", "verified_durable_execution_mode": lambda *args: "train",
            "reserve_distributed_gpu": lambda *args: None, "release_distributed_gpu_reservation": lambda *args: None,
            "tmux_available": lambda: True, "start_job_in_gpu_pane": lambda window, args, *rest: launched.append((args, rest)) or "%virtual",
            "append_worker_task": lambda _, task: saved.append(task), "append_event": lambda *args: None,
        }
        with contextlib.ExitStack() as scope:
            for key, replacement in replacements.items(): scope.enter_context(patch.object(agent, key, replacement))
            scope.enter_context(patch.object(agent.threading, "Thread", lambda *args, **kwargs: SimpleNamespace(start=lambda: None)))
            if scenario == "changed":
                rejects(lambda: agent._execute_worker_command_unfenced(root, command, "worker"))
                assert not launched and not saved and not mkdirs
            else:
                response = agent._execute_worker_command_unfenced(root, command, "worker")
                assert response["status"] == "running" and len(launched) == 1
                args, rest = launched[0]
                assert args[args.index("--plan") + 1] == plan_name
                assert args[args.index("--output-dir-override") + 1] == attempt
                assert args[args.index("--default-result-csv-dir") + 1] == result_dir
                assert rest[0] == root
                assert saved[0]["planFile"] == plan_name and saved[0]["outputDir"] == attempt
                assert saved[0]["configPath"] == attempt + "/job_config.yaml"
                assert saved[0]["logPath"] == command["logPath"]
                launched.clear(); saved.clear(); mkdirs.clear()
                for changes in [{"planFile": plan_name.rstrip()}, {"plan": []}, {"outputDir": "/invalid"},
                                {"configPath": "../outside"}, {"defaultResultCsvDir": 2}, {"logPath": "tmp//log"},
                                {"options": {"distributedResults": True, "outputDir": attempt.rstrip()}}]:
                    rejects(lambda: agent._execute_worker_command_unfenced(root, {**command, **changes}, "worker"))
                    assert not launched and not saved and not mkdirs
else:
    scheduler = extract_runtime_functions(str(runtime / "cluster_scheduler.py"),
        ["build_jobs", "run_job_mode", "plan_runtime_key", "launch_experiment"])
    scheduler.Path = MemoryPath
    scheduler.os = fake_os
    plan = {"suite": "suite", "mode": "train", "seeds": [7], "config": {"value": "kept"},
            "output_dir": output, "cases": [{"case": "baseline"}],
            "runner": {"train_command": "python quoted-entry.py", "inputs": [{"path": " data/中文 "}],
                       "outputs": [{"path": output + "/stdout.log"}]}}
    if scenario == "key":
        names = [" Plans/A.yaml ", " Plans/A.yaml", " Plans/a.yaml ", "Plans/A%20.yaml", "Plans/A .yaml",
                 "Plans/é.yaml", "Plans/e\u0301.yaml"]
        keys = [scheduler.plan_runtime_key(name) for name in names]
        assert len(set(keys)) == len(keys)
        assert keys == [scheduler.plan_runtime_key(name) for name in names]
    elif scenario == "enqueue":
        calls, runtimes = [], []
        worker = {"id": "worker", "project_dir": root, "conda_env": "env"}
        with patch.object(scheduler, "ensure_worker_runtime", lambda _: runtimes.append(True) or root + "/runtime/scheduler.py"), \
             patch.object(scheduler, "enqueue_worker_command", lambda worker, item: calls.append(item)):
            scheduler.launch_experiment(worker, plan_name, 0, "0", MemoryPath("tmp/tmux_logs"), output_dir=attempt, default_result_csv_dir=result_dir)
            assert calls[0]["plan"] == plan_name and calls[0]["projectDir"] == root
            assert calls[0]["outputDir"] == attempt and calls[0]["configPath"] == attempt + "/job_config.yaml"
            assert calls[0]["defaultResultCsvDir"] == result_dir
            calls.clear(); runtimes.clear()
            for value in ["/abs", "a//b", "a\\b", 1, False, "../outside"]:
                rejects(lambda: scheduler.launch_experiment(worker, plan_name, 0, "0", MemoryPath("tmp/logs"), output_dir=value))
                assert not calls and not runtimes
    else:
        _, jobs = scheduler.build_jobs(plan, result_dir)
        assert len(jobs) == 1 and jobs[0].output_dir == output
        assert jobs[0].config["runtime"]["output_dir"] == output
        assert jobs[0].result_csv == result_dir + "/suite.csv"
        assert jobs[0].inputs == (" data/中文 ",) and jobs[0].outputs == (output + "/stdout.log",)
        if scenario == "jobs":
            for value in ["/absolute", "a//b", "a/./b", "a/../b", "a\\b", "C:/a", 3, [], "a\nb"]:
                rejects(lambda: scheduler.build_jobs({**plan, "output_dir": value}, result_dir))
            for value in ["../outside", "bad\\path", 4]:
                rejects(lambda: scheduler.normalize_default_result_csv_dir(value))
            nodes[root + "/work 中文 "] = stat.S_IFDIR
            _, working_jobs = scheduler.build_jobs({**plan, "runner": {**plan["runner"], "cwd": "work 中文 "}}, result_dir)
            assert working_jobs[0].working_directory == "work 中文 "
            assert working_jobs[0].config["runtime"]["output_dir"] == root + "/" + output
            rejects(lambda: scheduler.build_jobs({**plan, "runner": {**plan["runner"], "inputs": [{"path": 42}]}}, result_dir))
        elif scenario == "attempt":
            dispatched = []
            args = SimpleNamespace(debug_mode=False, plan=plan_name, mode="train", only_index=0,
                                   output_dir_override=attempt, default_result_csv_dir=result_dir)
            with patch.object(scheduler, "load_plan", lambda _: plan), \
                 patch.object(scheduler, "jobs_for_args", lambda *args: jobs), \
                 patch.object(scheduler, "run_job", lambda job, args: dispatched.append(job)), \
                 patch.dict(fake_os.environ, {"SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS": "1"}), \
                 contextlib.redirect_stdout(io.StringIO()):
                scheduler.run_job_mode(args)
                assert dispatched[0].output_dir == attempt
                assert dispatched[0].config["runtime"]["output_dir"] == attempt
                assert dispatched[0].outputs == (attempt + "/stdout.log",)
                assert dispatched[0].template_values["output_dir"] == attempt
                dispatched.clear()
                for value in [output.rstrip() + "/attempts/1", output + "/attempts/../x", "/absolute", "a\\b", 0, False]:
                    args.output_dir_override = value
                    rejects(lambda: scheduler.run_job_mode(args))
                    assert not dispatched
        else: raise AssertionError(scenario)

print(json.dumps({"scenario": scenario, "passed": True, "remoteOperations": 0}))
