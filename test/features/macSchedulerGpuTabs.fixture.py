"""Only selected compiled functions; every process/remote leaf is simulated."""
import pathlib
import sys
import json
from types import SimpleNamespace
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
runtime = pathlib.Path(__file__).resolve().parents[2] / "dist/runtime/cluster_agent.py"
agent = extract_runtime_functions(str(runtime), ["start_scheduler_in_gpu_tab", "scheduler_tmux_stop_command", "tmux_session_alive"])
scenario = sys.argv[1]
calls, launches = [], []
agent._resolve_tmux_prefix = lambda *args: "lwb"
agent._tmux_prefix = lambda: "lwb"
agent.fixed_gpu_window_name = lambda prefix, gpu: prefix + "-gpu-" + str(gpu)
agent.tmux_pane_pid = lambda *args: 321
agent.process_start_identity = lambda pid: "boot:321:start"
def run(args, **kwargs):
    calls.append(args)
    if args[0] == "nvidia-smi":
        return SimpleNamespace(returncode=0, stdout="3\n1\n", stderr="")
    if args[1] == "display-message":
        if args[-1] == "#{pane_id}|#{session_name}|#{pane_pid}":
            return SimpleNamespace(returncode=0, stdout="%17|" + launches[-1] + "|321\n", stderr="")
        return SimpleNamespace(returncode=0, stdout="%17|lwb-gpu-1\n", stderr="")
    if args[1] == "has-session":
        return SimpleNamespace(returncode=0)
    raise AssertionError("unexpected process " + str(args))
agent.subprocess = SimpleNamespace(run=run, PIPE=-1, DEVNULL=-3)
def launch(container, *args):
    launches.append(container)
    return "%17"
agent.start_job_in_gpu_pane = launch
env = {"SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX": "lwb"}
if scenario in ("launch", "hub"):
    if scenario == "hub": env["SIMPLE_EXPERIMENT_TOPOLOGY_MODE"] = "hub_worker"
    for _ in range(2):
        assert agent.start_scheduler_in_gpu_tab("/virtual", ["python", "scheduler"], env, "log", "exit") == (321, "%17")
    assert launches == (["lwb-control"] * 2 if scenario == "hub" else ["lwb-gpu-1"] * 2)
    assert not any(call[:2] == ["tmux", "new-session"] for call in calls)
    assert not any("-sch-" in target for target in launches)
elif scenario == "failed":
    agent.subprocess.run = lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout="", stderr="not available")
    try: agent.start_scheduler_in_gpu_tab("/virtual", [], env, "log", "exit")
    except RuntimeError: pass
    else: raise AssertionError("unknown GPU must not create a fake GPU slot or standalone scheduler")
    assert not launches
elif scenario == "identity":
    assert agent.tmux_session_alive("%17", "/virtual", env)
    for text in ("%18|lwb-gpu-1", "%17|zlk-gpu-1", "%17|lwb-sch-old", "%17|lwb-gpu-1\n%18|lwb-gpu-1"):
        agent.subprocess.run = lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout=text)
        assert not agent.tmux_session_alive("%17", "/virtual", env)
    assert not agent.tmux_session_alive("%17;kill", "/virtual", env)
elif scenario == "stop":
    assert agent.scheduler_tmux_stop_command("/virtual", "%17", 321, "boot:321:start") == ["tmux", "kill-pane", "-t", "%17"]
    assert agent.scheduler_tmux_stop_command("/virtual", "lwb-sch-old", 321, "") == ["tmux", "kill-session", "-t", "lwb-sch-old"]
    for target, pid, start in (("%17", 322, "boot:321:start"), ("%17", 321, ""), ("%17", 321, "reused"), ("lwb-gpu-1", 321, "boot:321:start"), ("zlk-sch-other", 321, "")):
        try: agent.scheduler_tmux_stop_command("/virtual", target, pid, start)
        except ValueError: pass
        else: raise AssertionError("unconfirmed tab or shared GPU must not be closed")
else: raise AssertionError(scenario)
print(json.dumps({"scenario": scenario, "remoteOperations": 0}))
