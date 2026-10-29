"""Only extracted query functions; no server, research command or filesystem mutation."""
import ast, base64, json, os, pathlib, sys
source=pathlib.Path(sys.argv[1]).read_text(encoding="utf8").split("String.raw`",1)[1].rsplit("`",1)[0]
names={"task_result_query","task_declaration_query","task_declared_results","task_execution_inventory"}
nodes=[n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name in names]
assert len(nodes)==len(names),"lightweight result/declaration queries missing"
calls=[]
def forbidden(*args,**kwargs):raise AssertionError("no historical logs, source payload or repeated tmux query")
def manifest(root,job):
    calls.append(("manifest",job["outputDir"]))
    return dict(runId="command",status="completed",present=True,verified=True,artifactsComplete=True,identityMatches=True,job=dict(index=0,case="case",seed=42))
def logs(*args,**kwargs):
    calls.append(("logs",kwargs.get("terminal")))
    return dict(commandId="command",runId="command",state="clear",count=0,scanComplete=True)
q=dict(commandId="command",projectId="project",workerId="worker",outputDir="work/job",collectionResultCsv="tmp/job.csv",case="case",seed=42,experimentIndex=0)
ns=dict(os=os,json=json,base64=base64,now_iso=lambda:"now",task_safe_path=lambda root,path:path,
        task_manifest_observation=manifest,task_log_diagnostics=logs,task_inventory=forbidden,task_tmux=forbidden,task_memory_scheduler_capability=forbidden)
exec(compile(ast.Module(body=nodes,type_ignores=[]),"lightweight-queries","exec"),ns)
result=ns["task_result_query"]("/project",[q])
assert result["resultsOnly"] and result["queryComplete"] and result["tasks"][0]["observation"]["result"]["verified"]
assert "tmux" not in result["tasks"][0]["observation"] and "executionState" not in result["tasks"][0]
assert calls==[("manifest","work/job")],"artifact receipt must never wait for raw logs: "+str(calls)
assert result["metadataOnly"] and "runtimeDiagnostics" not in result["tasks"][0]["observation"]
calls.clear()
result=ns["task_result_query"]("/project",[q],diagnostics_only=True)
assert result["diagnosticsOnly"] and result["tasks"][0]["observation"]["runtimeDiagnostics"]["scanComplete"]
assert calls==[("manifest","work/job"),("logs",True)],calls
calls.clear()
ns["task_log_diagnostics"]=forbidden
ns["task_inventory"]=lambda root,execution_only=False:[dict(q,tmuxPane="%1",tmuxWindowId="@1",tmuxSession="configured-gpu-0",dead=True,exitCode=0,phase="running",gpuId="0")]
ns["task_tmux"]=lambda args: calls.append(("tmux",args[0])) or ""
d=dict(index=0,case="case",seed=42,mode="train_test",output_dir="work/job",result_csv="tmp/job.csv")
result=ns["task_declaration_query"]("/project",[d])
assert "executionOnly" not in result and result["capabilities"]["declaredResultQuery"]==1
assert result["capabilities"]["idleGpuAdmission"] is True and result["capabilities"]["queuedJobRecall"] is True
assert result["declaredResults"][0]["completed"] and result["cleanupExecutors"]==[]
assert calls==[("tmux","list-panes"),("manifest","work/job")],calls
print("bounded result and launch declaration reads verified")
