"""Only extracted query functions, synthetic panes, no server or runtime import."""
import ast
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
tree = ast.parse(source.split("String.raw`", 1)[1].rsplit("`", 1)[0])
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in ("task_execution_inventory", "task_query")]
row = dict(commandId="live", projectId="project", workerId="worker", workflowId="flow", globalJobId="flow:0",
           planRevision="revision", codeFingerprint="code", planFile="p.yaml", planJobCount=1, runKey="live",
           experimentIndex=0, case="case", seed=42, outputDir="work/job", resultPathPolicy="declared",
           tmuxPane="%1", tmuxWindowId="@1", tmuxSession="configured-gpu-2", gpuId="2", dead=False,
           exitCode=None, phase="starting", root="/fixture")
def forbidden(*args, **kwargs):
    raise AssertionError("execution must not inspect results, raw logs or launch source")
ns = dict(json=json, now_iso=lambda:"now", task_inventory=lambda *a,**k:[dict(row)],
          task_safe_path=forbidden, task_read_job=forbidden, task_public_observation=forbidden)
exec(compile(ast.Module(body=nodes,type_ignores=[]),"extracted-query","exec"),ns)
for phase,dead,code,expected in [("starting",False,None,"queued"),("running",False,None,"running"),("running",True,7,"failed"),("running",True,0,"unknown")]:
    row.update(phase=phase,dead=dead,exitCode=code)
    result=ns["task_execution_inventory"]("/fixture")
    task=result["tasks"][0]
    assert task["status"]==expected,task
    for key in ("planRevision","codeFingerprint","globalJobId","planJobCount","runKey"):
        assert task[key]==row[key],(key,task)
    assert "result" not in task["observation"] and "runtimeDiagnostics" not in task["observation"]
    assert "root" not in task and "codeManifest" not in task

# Missing Scheduler/cancel option must be queried once per Worker, not once per job.
calls=[]
def option(*args):
    calls.append(args)
    raise RuntimeError("scheduler temporarily unavailable")
ns.update(task_safe_path=lambda *a:None,task_public_observation=lambda root,job,row:{"status":"unknown","observation":{}},
          task_option=option,task_queue_session=lambda *a:"configured-sch",task_memory_scheduler_capability=lambda *a:1,
          task_inventory=lambda *a,**k:[{**row,"commandId":str(i)} for i in range(45)],task_tmux=lambda *a:"")
ns["task_query"]("/fixture")
assert len(calls)==1,len(calls)
print("execution independent; cancel lookup bounded")
