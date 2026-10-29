"""Extract final manifest query only. Synthetic files, no runtime import or disk writes."""
import ast, hashlib, io, json, pathlib, sys, types
source=pathlib.Path(sys.argv[1]).read_text(encoding="utf8").split("String.raw`",1)[1].rsplit("`",1)[0]
node=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=="task_manifest_observation")
metric=b"value\n0.5\n"
report=dict(runId="command",status="completed",outputDir="work/job",mode="train_test",job=dict(index=0,case="case",seed=42),
            weights=["work/job/best.pt"],resultCsv="tmp/job.csv",
            sha256={"tmp/job.csv":hashlib.sha256(metric).hexdigest()},
            fileStats={"work/job/best.pt":dict(size=10,mtimeNs=99,ctimeNs=88,inode=77,device=66)})
sizes={"work/job/artifact_manifest.json":100,"work/job/best.pt":10,"tmp/job.csv":len(metric)}
def opened(name,mode="r",**kwargs):
    if name.endswith("artifact_manifest.json"):return io.StringIO(json.dumps(dict(simpleExperiment=report)))
    assert name=="tmp/job.csv", "weight contents must never be scanned"
    return io.BytesIO(metric)
path=types.SimpleNamespace(isfile=lambda n:True,getsize=lambda n:sizes.get(n,100))
os=types.SimpleNamespace(path=path,stat=lambda n:types.SimpleNamespace(st_mode=0o100644,st_size=sizes[n],st_mtime_ns=1,st_ctime_ns=2,st_ino=3,st_dev=4))
ns=dict(os=os,open=opened,json=json,hashlib=hashlib,task_safe_path=lambda root,name:name)
exec(compile(ast.Module(body=[node],type_ignores=[]),"manifest-query","exec"),ns)
job=dict(commandId="command",outputDir="work/job",collectionResultCsv="tmp/job.csv",experimentIndex=0,case="case",seed=42)
assert ns["task_manifest_observation"]("root",job)["artifactsComplete"], "valid copied files must not fail filesystem-local identity checks"
metric=b"value\n0.0\n"
assert not ns["task_manifest_observation"]("root",job)["artifactsComplete"], "same-length corrupted metrics must not pass"
metric=b"value\n0.5\n";sizes["work/job/best.pt"]=9
assert not ns["task_manifest_observation"]("root",job)["artifactsComplete"], "truncated weights must not pass"
query_node=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=="task_result_query")
ns["now_iso"]=lambda:"now"
exec(compile(ast.Module(body=[query_node],type_ignores=[]),"result-query","exec"),ns)
q=dict(job,projectId="project",workerId="worker")
original_stat=os.stat
def inaccessible(name):
    if name.endswith("artifact_manifest.json"):raise PermissionError("NFS observation unavailable")
    return original_stat(name)
os.stat=inaccessible
observation=ns["task_result_query"]("root",[q])["tasks"][0]["observation"]
assert "resultQueryError" in observation and "artifactIssue" not in observation, "I/O failure is not proof of missing artifacts"
def missing(name):
    if name.endswith("artifact_manifest.json"):raise FileNotFoundError(name)
    return original_stat(name)
os.stat=missing
observation=ns["task_result_query"]("root",[q])["tasks"][0]["observation"]
assert observation["result"] is None and observation["artifactIssue"]=="missing_or_invalid_manifest"
print("portable manifest identity, metric hash and weight size verified")
