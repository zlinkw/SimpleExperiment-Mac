"""Only extracted lifecycle functions, real isolated tmux, stdlib CPU probes."""
import ast, base64, datetime, hashlib, json, math, os, pathlib, re, shlex, subprocess, sys, tempfile, threading, time, urllib.request, urllib.parse, uuid, textwrap
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from closeFixtureTmuxWindows import close_fixture_tmux_windows
runtime = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
tree = ast.parse(runtime)
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name.startswith("task_")]
code = ast.unparse(ast.Module(body=nodes, type_ignores=[]))
code += r'''
_modern_task_tmux = task_tmux
def task_tmux(args, timeout=5, **kwargs):
    # Emulate the deployed older tmux protocol, while all accepted commands still
    # run against a real isolated tmux server.
    if args[:2] == ["source-file", "-"]: raise RuntimeError("TMUX_QUERY_FAILED: -: No such file or directory")
    if sum(len(str(arg).encode("utf-8")) + 1 for arg in args) > 4096: raise RuntimeError("TMUX_QUERY_FAILED: command too long")
    fields = None
    if args and args[0] == "list-panes" and "-F" in args:
        at = args.index("-F") + 1
        if "#{pane_dead_status}" in args[at] and "#{pane_id}" in args[at]:
            args = list(args)
            fields = args[at].split("\t")
            args[at] += "\t#{pane_dead_signal}"
    value = _modern_task_tmux(args, timeout=timeout, **kwargs)
    if fields is not None:
        native = globals().setdefault("_fixture_native_fields", {})
        lines = []
        for line in value.splitlines():
            parts = line.split("\t")
            row = dict(zip(fields + ["signal"], parts))
            native[row.get("#{pane_id}", "?")] = {key: row.get(key) for key in ("#{pane_dead}", "#{pane_dead_status}", "signal")}
            lines.append("\t".join(parts[:-1]))
        return "\n".join(lines)
    return value
'''
root = tempfile.mkdtemp(prefix="se-native-lifecycle-")
os.environ.pop("TMUX", None)
os.environ["TMUX_TMPDIR"] = root
os.environ["SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX"] = "fixture"
bootstrap = '''import base64, datetime, hashlib, json, math, os, pathlib, re, shlex, subprocess, sys, threading, time, urllib.request, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
def now_iso(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def collect_local_gpu(): return ([{"id":"0"},{"id":"1"}], "")
def gpu_row_id(row): return row["id"]
def gpu_row_busy(*args): return pathlib.Path(os.environ["TMUX_TMPDIR"], "gpu-busy").exists()
_fixture_collect_local_gpu = collect_local_gpu
def collect_local_gpu():
    rows, error = _fixture_collect_local_gpu()
    for row in rows:
        row.setdefault("memoryTotalMb", 24576)
        row.setdefault("memoryUsedMb", 24576 if gpu_row_busy(row) else 0)
    return rows, error
def fixed_gpu_window_name(prefix, gpu): return (prefix or "fixture")+"-gpu-"+gpu
def execute_worker_command(root, job, worker):
    if job["commandId"] == "command-0" and "codeManifest" in job: assert len(job["codeManifest"]) == 180
    task_option(os.environ["TMUX_PANE"],"phase","running")
    identity=json.dumps({"workflowId":job["workflowId"],"commandId":job["commandId"]},ensure_ascii=False)
    probe=pathlib.Path(root)/"probe.py"
    env=dict(os.environ,SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY=identity,CUDA_VISIBLE_DEVICES=str(job["gpuId"]))
    proc=subprocess.run([sys.executable,str(probe),root,job["commandId"],job["case"],job["outputDir"],job["collectionResultCsv"]],env=env)
    return {"status":"completed" if proc.returncode==0 else "failed","exitCode":proc.returncode}
'''
program = pathlib.Path(root)/"runtime.py"
program.write_text(bootstrap+code+'''
if __name__=="__main__":
    mode=sys.argv[1];root=sys.argv[3];worker=sys.argv[5]
    sys.exit(task_queue_serve(root,worker) if mode=="task-queue" else task_runner(root,worker))
''',encoding="utf-8")
probe = pathlib.Path(root)/"probe.py"
probe.write_text('''import json,os,pathlib,sys,time
root,command,case,output,csv=sys.argv[1:]
identity=json.loads(os.environ["SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY"])
assert identity["commandId"]==command
pathlib.Path(root,"started-"+command).write_text(json.dumps({"at":time.monotonic(),"gpu":os.environ["CUDA_VISIBLE_DEVICES"]}),encoding="utf-8")
time.sleep(1.2 if case=="slow" else 0.1)
if case=="failure": sys.exit(7)
out=pathlib.Path(root)/output;out.mkdir(parents=True,exist_ok=True)
(out/"model.pth").write_bytes(b"cpu-fixture")
metrics=pathlib.Path(root)/csv;metrics.parent.mkdir(parents=True,exist_ok=True);metrics.write_text("metric,value\\nacc,1\\n",encoding="utf-8")
(out/"artifact_manifest.json").write_text(json.dumps({"simpleExperiment":{"runId":command,"status":"completed","mode":"train_test","job":{"index":int(command.split("-")[-1]),"case":case,"seed":42},"outputDir":output,"weights":[output+"/model.pth"],"resultCsv":csv}}),encoding="utf-8")
''',encoding="utf-8")
namespace={"__file__":str(program)}
exec(bootstrap+code,namespace)
def install_fixture_budget_observer(peak_mb):
    # Device-boundary fixture result, published by the Scheduler's sole metadata writer.
    # An external set-option races a live sampling turn and does not model this ownership.
    observer = r'''
_fixture_budget_update = task_budget_update
def task_budget_update(root, rows, gpus, now=None):
    _fixture_budget_update(root, rows, gpus, now)
    if not pathlib.Path(root, "fixture-budget-calibrated").exists():
        return
    for row in rows:
        value = task_budget_read(row)
        if not value:
            continue
        value["peakMb"] = max(value.get("peakMb", 0), PEAK_MB)
        value["oom"] = bool(value.get("oom") or pathlib.Path(root, "fixture-budget-oom").exists())
        value["ready"] = not value["oom"]
        value["budgetMb"] = task_budget_size(value["peakMb"])
        task_option(row["tmuxPane"], "gpu_budget", json.dumps(value))
        row["_gpuBudget"] = value
'''.replace('PEAK_MB', str(int(peak_mb)))
    source = program.read_text(encoding='utf-8')
    assert source.count('if __name__=="__main__":') == 1
    program.write_text(source.replace('if __name__=="__main__":', observer + '\nif __name__=="__main__":'), encoding='utf-8')
# 失败诊断只增加可见性：5 秒截止、50ms 轮询、异常口径、返回值与全部原断言均保持不变。
# 循环里本来就要发起的那一次观测（task_inventory、task_query 或 display-message）顺手记进 LAST_OBS，
# 所以超时定位只靠“循环内最后一次观测”；到期后不再发起任何 tmux 查询（含版本查询），
# 观察预算严格是一份 5 秒，不扞大外层 python 10 秒与 node 单文件 20 秒上限。
LAST_OBS={"stage":"","rows":None,"raw":None,"error":"","polls":0}
# tmux 版本在起动时取一次并缓存（不属于等待观测预算），超时诊断只读这份缓存。
# 用函数内缩进的 try：兄弟夹具 tmuxSchedulerPrefix.fixture.py 按第一个行首 "try:" 切取本文件前缀复用，
# 在本行之前新增行首 try: 会截断它的前缀。
def cached_tmux_version():
    try:
        return subprocess.run(["tmux","-V"],capture_output=True,timeout=1).stdout.decode("utf-8","replace").strip()
    except Exception as exc:
        return "unavailable:"+type(exc).__name__+":"+str(exc)[:120]
TMUX_VERSION=cached_tmux_version()
def wait_for(check,stage="",refresh=None):
    deadline=time.monotonic()+5
    LAST_OBS["stage"]=stage
    LAST_OBS["polls"]=0
    LAST_OBS["error"]=""
    while time.monotonic()<deadline:
        try:
            if refresh is not None:
                observed=refresh()
                if isinstance(observed,list):LAST_OBS["rows"]=observed
                else:LAST_OBS["raw"]=observed
            value=check()
            LAST_OBS["polls"]+=1
            if value:return value
        except (RuntimeError, ValueError, OSError) as exc:LAST_OBS["error"]=type(exc).__name__+":"+str(exc)[:200]
        time.sleep(.05)
    try:report_timeout()
    except Exception as exc:sys.stderr.write("[fixture-diagnostic] reporterFailed="+type(exc).__name__+":"+str(exc)[:200]+chr(10))
    raise AssertionError("bounded native observation timed out"+(" @"+stage if stage else ""))
def report_timeout():
    # 诊断仅进 stderr；stdout 仍只输出末尾那一行结果 JSON。不打印环境、不打印原任务正文。
    lines=["[fixture-diagnostic] nativeFields="+json.dumps(namespace.get("_fixture_native_fields", {})),"[fixture-diagnostic] stage="+str(LAST_OBS["stage"]),"polls="+str(LAST_OBS["polls"]),"lastQueryError="+str(LAST_OBS["error"] or "none")]
    rows=LAST_OBS["rows"]
    if isinstance(rows,list):
        lines.append("[fixture-diagnostic] inventoryRows="+str(len(rows)))
        for row in rows:
            lines.append("[fixture-diagnostic] inventory commandId="+str(row.get("commandId"))+" phase="+str(row.get("phase"))
                +" dead="+str(row.get("dead"))+" exitCode="+repr(row.get("exitCode"))+" windowId="+str(row.get("tmuxWindowId"))
                +" paneId="+str(row.get("tmuxPane"))+" session="+str(row.get("tmuxSession"))
                +" observationTmux="+json.dumps((row.get("observation") or {}).get("tmux"),ensure_ascii=False,sort_keys=True)[:240])
    elif LAST_OBS["raw"] is not None:
        lines.append("[fixture-diagnostic] lastRawObservation="+repr(LAST_OBS["raw"])[:200])
    # 到期只打印已收集事实：不再发 list-panes，也不再发 tmux -V，超时路径的追加查询数为 0。
    lines.append("[fixture-diagnostic] queriesAfterDeadline=0")
    lines.append("[fixture-diagnostic] tmuxVersion(cachedAtStartup)="+TMUX_VERSION)
    sys.stderr.write(chr(10).join(lines)+chr(10))
    sys.stderr.flush()
def job(index,case="slow"):
    return dict(commandId="command-"+str(index),projectId="project",workerId="worker",workflowId="workflow",
        planFile="experiments/plans/中文 plan.yaml",planRevision="a"*64,codeFingerprint="b"*64,globalJobId="workflow:"+str(index),
        experimentIndex=index,case=case,seed=42,resultPathPolicy="declared",outputDir="work/job"+str(index),
        collectionResultCsv="tmp/result/job"+str(index)+".csv",planJobCount=4,mode="train_test",executionMode="train_test",maxConcurrentGpus=2)
def fixture_jobs():
    a,b,c=job(0),job(1),job(2,"failure")
    a["codeManifest"] = {"source/module_" + str(i) + ".py": {"size": i, "sha256": hashlib.sha256(str(i).encode()).hexdigest()} for i in range(180)}
    a["distributedResults"] = {"label": "中文 'quoted' $literal \\ value\n" * 12}
    return a,b,c

def recovery_case():
    a,b,c=fixture_jobs()
    namespace["task_queue_rpc"](root,"worker","accept",a,ensure=True)
    assert next(row for row in namespace["task_inventory"](root) if row["commandId"] == a["commandId"])["codeManifest"] == a["codeManifest"]
    assert next(row for row in namespace["task_inventory"](root) if row["commandId"] == a["commandId"])["distributedResults"] == a["distributedResults"]
    namespace["task_queue_rpc"](root,"worker","accept",b,ensure=True)
    first=wait_for(lambda: len([r for r in (LAST_OBS["rows"] or []) if r["phase"]=="running" and not r["dead"]])==2,
        "two-running-panes",lambda: namespace["task_inventory"](root))
    duplicate=namespace["task_queue_rpc"](root,"worker","accept",a,ensure=True)
    assert len([r for r in namespace["task_inventory"](root) if r["commandId"]==a["commandId"]])==1
    conflict={**job(8),"outputDir":a["outputDir"]}
    try:
        namespace["task_queue_rpc"](root,"worker","accept",conflict,ensure=True)
        raise AssertionError("same declared output must have only one managed tmux writer")
    except RuntimeError as exc:
        assert "TASK_OUTPUT_BUSY" in str(exc)
    namespace["task_queue_rpc"](root,"worker","accept",c,ensure=True)
    wait_for(lambda: any(r["commandId"]==c["commandId"] and r["phase"]=="queued" for r in (LAST_OBS["rows"] or [])),
        "queued-tab-visible",lambda: namespace["task_inventory"](root))
    control=namespace["task_queue_session"](root,"worker")+":queue"
    assert control.startswith("fixture-sch-"), control
    epoch=namespace["task_queue_endpoint"](root,"worker")["epoch"]
    namespace["task_tmux"](["send-keys","-t",control,"C-c"])
    wait_for(lambda: LAST_OBS["raw"]=="1","control-dead-after-interrupt",
        lambda: namespace["task_tmux"](["display-message","-p","-t",control,"#{pane_dead}"]))
    # Existing queued/running tabs remain the queue across controller recovery.
    namespace["task_queue_rpc"](root,"worker","accept",a,ensure=True)
    assert namespace["task_queue_endpoint"](root,"worker")["epoch"]!=epoch
    stopped=namespace["task_stop"](root,{"targetCommandId":c["commandId"],"projectId":"project","workflowId":"workflow"},"worker")
    assert stopped["stoppedTasks"][0]["paneClosed"]
    # Only the pane death is awaited here: a live tmux build can leave
    # pane_dead_status unpublished for the whole 5 second budget, and production
    # completion for that case is defined by verified artifacts, not by a number.
    # So completion is asserted on the real task_query observation below; a real
    # non-zero exit code would still fail there, and none is claimed when absent.
    wait_for(lambda: all(any(r["commandId"]==item["commandId"] and r["dead"] for r in (LAST_OBS["rows"] or [])) for item in (a,b)),
        "settled-exit-before-query",lambda: namespace["task_inventory"](root))
    observed=namespace["task_query"](root,[a,b])["tasks"]
    assert observed,observed
    completed={row["commandId"]:row for row in observed if row["commandId"] in (a["commandId"],b["commandId"])}
    assert set(completed)=={a["commandId"],b["commandId"]},observed
    for required in (a,b):
        row=completed[required["commandId"]]
        manifest=row["observation"]["result"]
        assert manifest and manifest["identityMatches"] and manifest["verified"] and manifest["artifactsComplete"],row
        assert row["status"]=="completed",row
        # An observed exit code must be zero; an unobserved one is unknown, not proven zero.
        assert row["exitCode"] in (None,0),row
    # Some live tmux builds return an empty status for retained dead panes.
    # Keep the real inventory/windows/manifests; omit only the unavailable field.
    real_tmux=namespace["task_tmux"]
    def missing_exit_status(args, timeout=5):
        text=real_tmux(args, timeout)
        if args[0]=="list-panes" and "#{pane_dead_status}" in args[-1]:
            lines=[]
            for line in text.splitlines():
                fields=line.split("\t")
                if len(fields) in (9,10) and fields[3]=="1": fields[4]=""
                lines.append("\t".join(fields))
            return "\n".join(lines)
        return text
    namespace["task_tmux"]=missing_exit_status
    try:
        unknown_exit=namespace["task_query"](root,[a,b])["tasks"]
        assert all(row["status"]=="completed" and row["exitCode"] is None for row in unknown_exit),unknown_exit
        ended=namespace["task_inventory"](root)[0]
        manifest=namespace["task_manifest_observation"](root,ended)
        assert manifest["runId"]==ended["commandId"] and manifest["verified"]
        assert namespace["task_public_observation"](root,{**ended,"commandId":"new-run"},ended)["status"]=="unknown"
        assert namespace["task_public_observation"](root,{**ended,"outputDir":"work/not-produced"},ended)["status"]=="unknown"
        assert namespace["task_public_observation"](root,ended,{**ended,"exitCode":7})["status"]=="failed"
    finally:
        namespace["task_tmux"]=real_tmux
    row=namespace["task_inventory"](root)[0]
    # Execute only the actual HTTP capture branch against this private tmux server.
    route_source = runtime.split('            if route == "/api/tmux/capture":', 1)[1].split('            if route == "/api/tmux/list":', 1)[0]
    route_source = 'def capture(self, parsed):\n' + textwrap.indent(textwrap.dedent(route_source), '    ')
    route_globals = dict(re=re, subprocess=subprocess, parse_qs=urllib.parse.parse_qs, SCHEMA_VERSION=1)
    exec(route_source, route_globals)
    class Response:
        def send_json(self, data, status=200): return status, data
    capture = lambda target: route_globals['capture'](Response(), urllib.parse.urlparse('/api/tmux/capture?window=' + urllib.parse.quote(target)))
    status, data = capture(row['tmuxWindowId'])
    assert status == 200 and data['ok'], (status, data)
    assert capture('@1;echo bad')[0] == 400
    namespace["task_tmux"](["rename-window","-t",row["tmuxWindowId"],"manually renamed"])
    assert capture(row['tmuxWindowId'])[1]['ok'], 'window log must remain readable after rename'
    namespace["task_tmux"](["kill-window","-t",row["tmuxWindowId"]])
    namespace["task_tmux"](["send-keys","-t",control,"C-c"])
    wait_for(lambda: LAST_OBS["raw"]=="1","control-dead-after-manual-window-close",
        lambda: namespace["task_tmux"](["display-message","-p","-t",control,"#{pane_dead}"]))
    try:
        namespace["task_queue_rpc"](root,"worker","accept",a if row["commandId"]==a["commandId"] else b,ensure=True)
        raise AssertionError("manually closed accepted task must never be replayed")
    except RuntimeError as exc:
        assert "TASK_ALREADY_ACCEPTED_WINDOW_CLOSED" in str(exc)
    assert namespace["task_query"](root,[a,b])["tasks"][-1]["status"]=="completed"
    return a,b

def failure_case(a=None,b=None):
    if a is None:
        a,b,_=fixture_jobs()
        for item in (a,b):
            namespace["task_queue_rpc"](root,"worker","accept",item,ensure=True)
        wait_for(lambda:all(any(row["commandId"]==item["commandId"] and row["dead"] for row in (LAST_OBS["rows"] or [])) for item in (a,b)),
            "failure-world-completed-fixtures",lambda:namespace["task_inventory"](root))
    control=namespace["task_queue_session"](root,"worker")+":queue"
    failure=job(3,"failure")
    namespace["task_queue_rpc"](root,"worker","accept",failure,ensure=True)
    # One real observation per poll, and that same observation is asserted: the
    # pane must be dead and carry a real integer native exit code. No second query
    # window, no fallback from the scripted case, file, phase or manifest; if the
    # platform never yields the code, the 5 second budget expires and fails here.
    def settled_failure():
        for row in (LAST_OBS["rows"] or []):
            observed=(((row or {}).get("observation") or {}).get("tmux") or {})
            if (row.get("commandId")==failure["commandId"] and row.get("projectId")==failure["projectId"]
                    and row.get("workerId")==failure["workerId"] and observed.get("dead") is True
                    and isinstance(observed.get("exitCode"),int)):
                return row
        return None
    failed=wait_for(settled_failure,"failed-task-settled-exit",lambda: namespace["task_query"](root,[failure])["tasks"])
    assert failed["status"]=="failed" and failed["exitCode"]==7,failed
    assert failed["observation"]["tmux"]["exitCode"]==failed["exitCode"],failed
    declarations=[dict(index=item["experimentIndex"],case=item["case"],seed=item["seed"],mode=item["mode"],output_dir=item["outputDir"],result_csv=item["collectionResultCsv"]) for item in (a,b,failure)]
    assert [item["completed"] for item in namespace["task_declared_results"](root,declarations)]==[True,True,False]
    option = namespace["task_option"]
    damaged = job(4)
    damaged["codeManifest"] = a["codeManifest"]
    prepared = namespace["task_queue_job"](root,"worker",damaged)
    def interrupted(target,key,value=None):
        if key.startswith("job_") and value: raise RuntimeError("synthetic metadata channel failure")
        return option(target,key,value)
    namespace["task_option"] = interrupted
    try:
        namespace["task_queue_accept"](root,"worker",damaged,control,prepared=prepared)
        raise AssertionError("injected metadata failure accepted")
    except RuntimeError as exc: assert "synthetic metadata" in str(exc)
    finally: namespace["task_option"] = option
    rejected = wait_for(lambda: next((row for row in (LAST_OBS["rows"] or []) if row["commandId"] == damaged["commandId"] and row["dead"]),None),
        "damaged-task-dead",lambda: namespace["task_inventory"](root))
    assert rejected["phase"] == "rejected" and rejected["exitCode"] != 0
    assert not pathlib.Path(root,"started-command-4").exists()
    namespace["task_write_job"](rejected["tmuxPane"],prepared)
    assert namespace["task_read_job"](rejected["tmuxPane"]) == prepared
    header=json.loads(base64.urlsafe_b64decode(option(rejected["tmuxPane"],"job")))
    key="job_"+header["_se_payload"]["sha256"][:16]+"_0"
    saved=option(rejected["tmuxPane"],key)
    option(rejected["tmuxPane"],key,"corrupt")
    try:
        namespace["task_read_job"](rejected["tmuxPane"])
        raise AssertionError("incomplete payload accepted")
    except RuntimeError as exc: assert "TASK_WINDOW_PAYLOAD_INCOMPLETE" in str(exc)
    option(rejected["tmuxPane"],key,saved)
    assert namespace["task_read_job"](rejected["tmuxPane"]) == prepared
    # An explicit rerun keeps the declared job/path but uses a new command;
    # the old command remains cancelled even if a delayed original POST arrives.
    namespace["task_stop"](root,{"targetCommandId":b["commandId"],"projectId":b["projectId"],"workflowId":b["workflowId"]},"worker")
    try:
        namespace["task_queue_rpc"](root,"worker","accept",b,ensure=True)
        raise AssertionError("cancelled original request accepted again")
    except RuntimeError as exc:
        assert "CANCELLED" in str(exc), str(exc)
    rerun={**b,"commandId":"rerun-command-1"}
    namespace["task_queue_rpc"](root,"worker","accept",rerun,ensure=True)
    wait_for(lambda:pathlib.Path(root,"started-rerun-command-1").exists(),"rerun-started-marker")
    # Retained dead panes may omit pane_dead_status on this tmux build (also
    # exercised above). Require real exit plus current-run completion evidence;
    # an explicit nonzero exit still fails the query below.
    wait_for(lambda:any(row["commandId"]==rerun["commandId"] and row["dead"] and row["exitCode"] in (None, 0) for row in (LAST_OBS["rows"] or [])),
        "rerun-dead-with-exit",lambda: namespace["task_inventory"](root))
    rerun_observed=next(row for row in namespace["task_query"](root,[rerun])["tasks"] if row["commandId"]==rerun["commandId"])
    assert rerun_observed["status"]=="completed", rerun_observed

try:
    # Deliberately corrupt legacy state: none of the native functions can read it.
    for name in ("worker_task_snapshot.json","distributed_plan_queue.json","worker_start_claims.json"):
        (pathlib.Path(root)/name).write_text("corrupt legacy state",encoding="utf-8")
    scenario=sys.argv[2] if len(sys.argv)>2 else "all"
    if scenario=="recovery": recovery_case()
    elif scenario=="failure": failure_case()
    elif scenario=="all": failure_case(*recovery_case())
    else: raise ValueError("unknown private fixture scenario")
    print(json.dumps(dict(ok=True,realTmux=True,callbacks=0,stateFilesRead=0)))
finally:
    # This is the fixture's newly created server under its private TMUX_TMPDIR only.
    close_fixture_tmux_windows(lambda args: subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=2), private_root=root)
