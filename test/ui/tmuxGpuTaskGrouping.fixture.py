import ast, json, pathlib, re, sys, types
runtime = pathlib.Path(sys.argv[1])
tree = ast.parse(runtime.read_text(encoding="utf-8"))
# Extract only the real /api/tmux/list branch. No Agent service, listener, sampler,
# PID lifecycle, private tmux server or complete runtime is executed.
branches = [n for n in ast.walk(tree) if isinstance(n, ast.If) and isinstance(n.test, ast.Compare)
    and any(isinstance(x,ast.Constant) and x.value=="/api/tmux/list" for x in n.test.comparators)]
assert len(branches)==1
fn = ast.FunctionDef(name="probe",args=ast.arguments(posonlyargs=[],args=[ast.arg(arg="self")],kwonlyargs=[],kw_defaults=[],defaults=[]),body=branches[0].body,decorator_list=[])
helpers = [n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {"gpu_row_id","_normalize_gpu_id_for_window"}]
responses={"list-sessions":"simple-gpu-1|1|0|0\n","list-windows":"0|run-123|1|1|@4\n","list-panes":"0|1|python|80|24|%7|task\n"}
calls=[]
def fake_run(args,**kwargs):
    assert args[0]=="tmux" and args[1] in responses,args
    assert kwargs.get("timeout",0)<=5
    calls.append(args)
    return types.SimpleNamespace(returncode=0,stdout=responses[args[1]],stderr="")
ns={"root":"/private/model-project","SCHEMA_VERSION":1,"re":re,
    "os":types.SimpleNamespace(environ={"SIMPLE_EXPERIMENT_WORKER_ID":"worker-model"}),
    "subprocess":types.SimpleNamespace(run=fake_run),"tmux_available":lambda:True,
    "path_for":lambda root,name:name,
    "read_runtime_json_cached":lambda *args:{"gpus":[{"index":0},{"index":1}]},
    "task_scheduler_runtime_report":lambda *args:{"status":"missing"},
    "task_inventory":lambda root:[{"workerId":"worker-model","commandId":"original","tmuxPane":"%7","gpuId":"1","case":"bus_p30","seed":43,"phase":"running","dead":True,"exitCode":1,"planFile":"plans/model.yaml"},
        {"workerId":"other-worker","commandId":"foreign","tmuxPane":"%7","case":"foreign","phase":"running"}]}
exec(compile(ast.fix_missing_locations(ast.Module(body=helpers+[fn],type_ignores=[])),"isolated-tmux-list","exec"),ns)
class Handler:
    def send_json(self,body,status=200):
        assert status==200,body
        return body
result=ns["probe"](Handler())
assert result["ok"] is True,result
assert result["workerId"]=="worker-model" and result["gpuIds"]==["0","1"],result
window=result["sessions"][0]["windows"][0]
assert window["windowId"]=="@4" and window["panes"][0]["id"]=="%7",window
task=window["task"]
assert task["commandId"]=="original" and task["case"]=="bus_p30" and task["seed"]==43 and task["status"]=="failed",task
assert len(calls)==3,calls
print(json.dumps({"ok":True,"windowId":window["windowId"],"task":task}))
