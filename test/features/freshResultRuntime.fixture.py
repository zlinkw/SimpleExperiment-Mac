"""Extract only the collection functions. No Agent startup, queue, state database, or remote work."""
import ast
import builtins
import hashlib
import json
import os
import pathlib
import sys
import tempfile

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
tree = ast.parse(source)
names = {"task_safe_path", "task_collection_result", "task_collection_query", "task_declared_results"}
selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert len(selected) == len(names)
space = dict(os=os, json=json, hashlib=hashlib, now_iso=lambda: "now", task_inventory=lambda root: [])
def forbidden_log_scan(*args, **kwargs):
    raise AssertionError("artifact aggregation must not inspect console logs")
space["task_log_diagnostics"] = forbidden_log_scan
exec(compile(ast.Module(body=selected, type_ignores=[]), "collection-functions", "exec"), space)
root = pathlib.Path(tempfile.mkdtemp(prefix="simple-collection-functions-"))
job = dict(index=0, case="alpha", seed=42, mode="train_test", planFile="experiments/plans/a.yaml", output_dir="work_dirs/alpha42", result_csv="work_dirs/alpha42/metrics.csv", collect=True)
assert space["task_collection_result"](str(root), job)["resultState"] == "missing"
output = root / job["output_dir"]
output.mkdir(parents=True)
(output / "model.pth").write_bytes(b"synthetic-weight")
(root / job["result_csv"]).write_text("case,seed,AUC\nalpha,42,0.5\n", encoding="utf-8")
metric_hash = hashlib.sha256((root / job["result_csv"]).read_bytes()).hexdigest()
report = dict(runId="command", status="completed", mode="train_test", outputDir=job["output_dir"], resultCsv=job["result_csv"], planFile=job["planFile"],
              job=dict(index=0, case="alpha", seed=42), weights=[job["output_dir"] + "/model.pth"], sha256={job["result_csv"]: metric_hash},
              fileStats={job["output_dir"] + "/model.pth": dict(size=16, inode=-123, device=-99)})
manifest = output / "artifact_manifest.json"
manifest.write_text(json.dumps(dict(simpleExperiment=report)), encoding="utf-8")
real_open = builtins.open
def guarded_open(file, *args, **kwargs):
    name = str(file)
    assert not name.endswith("model.pth"), "weights must only be stat'ed"
    assert name.endswith(("artifact_manifest.json", "metrics.csv")), name
    return real_open(file, *args, **kwargs)
builtins.open = guarded_open
try:
    complete = space["task_collection_query"](str(root), [job])
    assert complete["queryComplete"] and complete["capabilities"]["resultCollection"] == 1
    result = complete["declaredResults"][0]
    assert result["completed"] and result["runId"] == "command" and len(result["files"]) == 2, result
    mixed = space["task_collection_query"](str(root), [{"collect": True}, job])
    assert mixed["declaredResults"][0]["error"] and mixed["declaredResults"][1]["completed"]
finally:
    builtins.open = real_open
(root / job["result_csv"]).write_text("case,seed,AUC\nalpha,42,0.8\n", encoding="utf-8")
changed = space["task_collection_query"](str(root), [job])["declaredResults"][0]
assert not changed["completed"] and "RESULT_METRIC_HASH_CHANGED" in changed["error"], changed
assert not list(root.rglob("*registry*")) and not list(root.rglob("*.sqlite*"))
print(json.dumps(dict(ok=True, stateFiles=0, weightReads=0, mixedQueriesIsolated=True)))
