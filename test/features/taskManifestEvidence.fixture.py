"""Query synthetic final artifacts with extracted production functions, never run a job."""
import ast, json, os, pathlib, re, sys, tempfile

source=pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").split("String.raw`",1)[1].rsplit("`",1)[0]
names={"task_safe_path","task_manifest_observation","task_public_observation"}
nodes=[n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name in names]
ns=dict(os=os,json=json,re=re,now_iso=lambda:"2026-10-15T00:00:00Z")
exec(compile(ast.Module(body=nodes,type_ignores=[]),"manifest-query","exec"),ns)
root=pathlib.Path(tempfile.mkdtemp(prefix="se-final-artifacts-"));cases=[]

def check(name, mode="train_test", change=None, dead=True, exit_code=None, phase="running", expected=("exited","complete","completed")):
    output="work/"+name;directory=root/output;directory.mkdir(parents=True)
    weights=[output+"/model.pth"] if mode!="test" else []
    csv="tmp/"+name+".csv"
    for relative in [*weights,csv]:
        f=root/relative;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(b"synthetic-output")
    job=dict(commandId="current",projectId="project",workerId="worker",experimentIndex=0,case="case",seed=42,
        outputDir=output,collectionResultCsv=csv,mode=mode,executionMode=mode)
    report=dict(runId="current",status="completed",mode=mode,outputDir=output,weights=weights,resultCsv=csv,
        job=dict(index=0,case="case",seed=42))
    write=True
    if change: write=change(job,report,directory) is not False
    if write:(directory/"artifact_manifest.json").write_text(json.dumps({"simpleExperiment":report}),encoding="utf-8")
    row=dict(tmuxWindowId="@1",tmuxPane="%1",tmuxSession="fixture",gpuId="0",dead=dead,exitCode=exit_code,phase=phase)
    result=ns["task_public_observation"](str(root),job,row)
    wanted=dict(zip(("executionState","resultState","status"),expected))
    actual={k:result.get(k) for k in wanted}
    assert actual==wanted,(name,actual,wanted,result)
    cases.append(dict(name=name,observation=result["observation"],expected=wanted))

for mode in ("train","test","train_test"):check(mode,mode=mode)
check("checkpoint-test-only",change=lambda j,r,d:(j.update(checkpointTestOnly=True),r.update(mode="test",weights=[])))
check("running",dead=False,expected=("running","complete","running"))
check("unknown-phase",dead=False,phase="other",expected=("unknown","complete","unknown"))
check("explicit-failure",exit_code=7,expected=("failed","complete","failed"))
check("absent",change=lambda *args:False,expected=("exited","incomplete","unknown"))
check("empty-weight",change=lambda j,r,d:(root/r["weights"][0]).write_bytes(b""),expected=("exited","incomplete","unknown"))
check("empty-result",change=lambda j,r,d:(root/r["resultCsv"]).write_bytes(b""),expected=("exited","incomplete","unknown"))
check("missing-result-declaration",change=lambda j,r,d:r.update(resultCsv=None),expected=("exited","incomplete","unknown"))
check("missing-weights",change=lambda j,r,d:r.update(weights=[]),expected=("exited","incomplete","unknown"))
check("directory-weight",change=lambda j,r,d:(r.update(weights=[j["outputDir"]+"/directory"]),(d/"directory").mkdir()),expected=("exited","incomplete","unknown"))
check("old-run",change=lambda j,r,d:r.update(runId="old"),expected=("exited","conflict","unknown"))
check("missing-run",change=lambda j,r,d:r.update(runId=""),expected=("exited","conflict","unknown"))
check("other-job",change=lambda j,r,d:r["job"].update(seed=99),expected=("exited","conflict","unknown"))
check("mode-mismatch",change=lambda j,r,d:r.update(mode="train"),expected=("exited","conflict","unknown"))
check("foreign-weight",change=lambda j,r,d:r.update(weights=["work/train/model.pth"]),expected=("exited","unverified","unknown"))
def changed_stat(job,report,directory):
    report["fileStats"]={report["weights"][0]:{"size":999}}
check("changed-stat",change=changed_stat,expected=("exited","incomplete","unknown"))
def unreadable(job,report,directory):
    (directory/"artifact_manifest.json").write_text("{",encoding="utf-8");return False
check("unreadable",change=unreadable,expected=("exited","unverified","unknown"))
print(json.dumps(cases))
