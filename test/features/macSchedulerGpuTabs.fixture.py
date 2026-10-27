"""AST-selected current protocol-2 window functions; all native/process leaves simulated."""
import base64
import copy
import json
import os
import pathlib
import sys
from types import SimpleNamespace
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
runtime = pathlib.Path(__file__).resolve().parents[2] / "dist/runtime/cluster_agent.py"
agent = extract_runtime_functions(str(runtime), ["task_queue_accept", "task_inventory", "task_stop"])
agent.__file__ = str(runtime)
agent.agent_dir = lambda _: "/virtual/state"
scenario = sys.argv[1]
calls, options, windows = [], {}, []
session = "$3"
listing = ""
def tmux(args, timeout=5):
    calls.append(copy.deepcopy(args))
    if args[0] == "list-panes": return listing
    if args[0] == "display-message":
        if args[-1] == "#{session_id}": return session
        raise AssertionError(args)
    if args[0] == "new-window":
        pane = "%" + str(17 + len(windows)); windows.append(pane); return pane
    if args[0] == "set-option":
        options[(args[3], args[4])] = args[5]; return ""
    if args[0] == "kill-window": return ""
    raise AssertionError("unexpected native command: " + repr(args))
agent.task_tmux = tmux
# 生产 task_queue_accept / task_inventory 用 os.path.realpath 规范化项目根，断言按同一口径：
# macOS 上 /virtual 原样返回，Windows 宿主会规范化为盘符路径，两种宿主都断言同一条契约。
project_root = "/virtual"
root = os.path.realpath(project_root)
def job(index=0):
    return dict(action="start-worker-task", commandId="command-" + str(index), projectId="project", workerId="worker",
                workflowId="workflow", globalJobId="workflow:" + str(index), experimentIndex=index,
                planFile="experiments/Plans/ A.yaml ", outputDir="outputs/中文 " + str(index),
                collectionResultCsv="results/" + str(index) + ".csv", resultPathPolicy="declared",
                planRevision="revision", codeFingerprint="code", lifecycleProtocol=2, case="case", seed=42)
def rejects(action, text):
    try: action()
    except (ValueError, RuntimeError) as exc: assert text in str(exc), str(exc)
    else: raise AssertionError("unverified identity was accepted")
if scenario in ("launch", "hub"):
    # Historical topology metadata cannot switch protocol-2 launch back to a Hub/control container.
    if scenario == "hub": agent.os.environ["SIMPLE_EXPERIMENT_TOPOLOGY_MODE"] = "hub_worker"
    for index in range(2):
        result = agent.task_queue_accept(project_root, "worker", job(index), "@1")
        assert result["pane"] == windows[index] and result["root"] == root and result["lifecycleProtocol"] == 2
        bound = json.loads(base64.urlsafe_b64decode(options[(windows[index], "@se_job")]))
        assert bound["commandId"] == job(index)["commandId"] and bound["planFile"] == job(index)["planFile"]
        assert options[(windows[index], "@se_phase")] == "queued"
    launch = [call for call in calls if call[0] == "new-window"]
    assert len(launch) == 2 and all(call[call.index("-t") + 1] == "$3:" for call in launch)
    assert all(os.path.realpath(call[call.index("-c") + 1]) == root and "task-runner" in call[-1] for call in launch)
    assert not any(call[0] in ("new-session", "kill-session", "kill-window", "kill-pane") for call in calls)
    assert not any("-sch-" in str(call) or "-control" in str(call) for call in calls)
elif scenario == "failed":
    for session in ("", "lwb-gpu-1", "$3\n$4", "$3;kill"):
        rejects(lambda: agent.task_queue_accept(project_root, "worker", job(), "@1"), "SCHEDULER_SESSION_UNVERIFIED")
    assert not windows and not options
elif scenario == "identity":
    bound = {**job(), "root": root, "pane": "%17"}
    def row(value):
        encoded = base64.urlsafe_b64encode(json.dumps(value).encode()).decode()
        return "\t".join(["%17", "@17", "worker-gpu", "0", "", encoded, "running", "1", "logs/task.log"])
    listing = row(bound)
    result = agent.task_inventory(project_root, execution_only=True)
    assert len(result) == 1 and result[0]["commandId"] == bound["commandId"] and result[0]["tmuxWindowId"] == "@17"
    for change in ({"root": "/other"}, {"pane": "%18"}, {"lifecycleProtocol": 1}):
        listing = row({**bound, **change}); assert agent.task_inventory(project_root, execution_only=True) == []
    listing = "malformed"; assert agent.task_inventory(project_root, execution_only=True) == []
    assert not any(call[0].startswith("kill-") for call in calls)
elif scenario == "stop":
    row = {**job(), "tmuxWindowId": "@17"}
    rows = [row]
    agent.task_inventory = lambda *args, **kwargs: list(rows)
    agent.local_stop_tmux_inventory = lambda _: []
    def unavailable(*args, **kwargs): raise RuntimeError("isolated controller unavailable")
    agent.task_queue_rpc = unavailable
    command = dict(targetCommandId="command-0", projectId="project")
    for changed in ({"projectId": "foreign"}, {"workerId": "foreign"}):
        rows[:] = [{**row, **changed}]
        rejects(lambda: agent.task_stop(project_root, command, "worker"), "TASK_OWNER_MISMATCH")
    rejects(lambda: agent.task_stop(project_root, {}, "worker"), "TASK_STOP_IDENTITY_REQUIRED")
    assert not calls
    rows[:] = [row]
    original = agent.task_tmux
    def close(args, timeout=5):
        result = original(args, timeout)
        if args == ["kill-window", "-t", "@17"]: rows.clear()
        return result
    agent.task_tmux = close
    result = agent.task_stop(project_root, command, "worker")
    assert result["status"] == "completed" and result["stoppedTasks"][0]["paneClosed"] is True
    assert calls == [["kill-window", "-t", "@17"]]
    # A close command without a fresh disappearance observation cannot claim success.
    calls.clear(); rows[:] = [row]; agent.task_tmux = original
    rejects(lambda: agent.task_stop(project_root, command, "worker"), "TASK_STOP_NOT_CONFIRMED")
    assert calls == [["kill-window", "-t", "@17"]]
else: raise AssertionError(scenario)
print(json.dumps({"scenario": scenario, "remoteOperations": 0}))
