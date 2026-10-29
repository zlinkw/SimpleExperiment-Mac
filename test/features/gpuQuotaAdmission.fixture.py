import ast
import json
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8").split("String.raw`", 1)[1].rsplit("`", 1)[0]
names = {"task_gpu_quota_policy", "task_admission_gpu"}
nodes = [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name in names]
ns = dict(gpu_row_id=lambda gpu: str(gpu["index"]), task_memory_info=lambda *args: None)
exec(compile(ast.Module(body=nodes, type_ignores=[]), "quota", "exec"), ns)
gpus = [dict(index=str(i), memoryTotalMb=140*1024, memoryUsedMb=(106 if i < 2 else 119)*1024,
             utilizationPercent=100, processCount=5) for i in range(3)]
row = dict(gpuId="0", options=dict(gpuQuotaScheduling=1, gpuJobsPerCard=6, gpuMinFreeMemoryGb=22), maxConcurrentGpus=1)
choose = ns["task_admission_gpu"]
assert choose(row, gpus, {"0": 5}) == "0"
assert choose(row, gpus, {"0": 6}) == "1", "physical-card cap and foreign processes must not hide a usable card"
assert choose(row, gpus, {"0": 6, "1": 6}) is None
assert choose(dict(row, dispatchPolicy="manual"), gpus, {"0": 6}) is None
try:
    choose(dict(row, dispatchPolicy="manual", gpuId="missing"), gpus, {})
except ValueError as exc:
    assert "MANUAL_GPU_NOT_VISIBLE" in str(exc)
else:
    raise AssertionError("unknown manual GPU was left silently queued")
assert choose(row, [dict(gpus[0], memoryUsedMb=118*1024)], {}) == "0"
assert choose(row, [dict(gpus[0], memoryTotalMb=None)], {}) is None
limited = dict(row, options={**row['options'], 'gpuMaxConcurrentCards': 1})
assert choose(limited, gpus, {'1': 2}) == '1', 'active card 1 must win over preferred new card 0'
assert choose(limited, gpus, {'1': 6}) is None
assert choose(limited, gpus, {'0': 1, '1': 1}) is None
assert choose(dict(limited, dispatchPolicy='manual'), gpus, {'1': 1}) is None
assert choose(dict(row, options={**row['options'], 'gpuMaxConcurrentCards': 0}), gpus, {}) is None
per_card = dict(row, options={**row["options"], "gpuCardOverrides": {
    "0": {"gpuJobsPerCard": 2, "gpuMinFreeMemoryGb": 35},
    "1": {"gpuJobsPerCard": 3, "gpuMinFreeMemoryGb": 22},
    "2": {"gpuJobsPerCard": 0}, "9": {"gpuJobsPerCard": 100}}})
assert choose(per_card, gpus, {}) == "1", "card 0 must use its own 35 GiB gate"
assert choose(per_card, gpus, {"1": 3}) is None, "card 2 disabled, absent card 9 ignored"
assert choose(dict(per_card, dispatchPolicy="manual"), gpus, {}) is None
assert choose(dict(per_card, dispatchPolicy="manual", gpuId="1"), gpus, {"1": 2}) == "1"
assert ns["task_gpu_quota_policy"](per_card["options"], [])["gpuCardOverrides"]["2"]["gpuJobsPerCard"] == 0
for invalid in [dict(gpuJobsPerCard=0), dict(gpuJobsPerCard=2.5), dict(gpuMinFreeMemoryGb=-1),
                dict(gpuCardOverrides={"0": {"gpuJobsPerCard": 1.5}}), dict(gpuCardOverrides={"../0": {}}),
                dict(gpuCardOverrides={"0": {"gpuMinFreeMemoryGb": -1}})]:
    try:
        ns["task_gpu_quota_policy"]({**row["options"], **invalid}, [])
    except ValueError:
        pass
    else:
        raise AssertionError("invalid settings accepted")
# Exercise the actual authenticated Handler branch without importing the Agent.
agent = ast.parse(Path(sys.argv[2]).read_text(encoding="utf-8"))
branch = next(n for n in ast.walk(agent) if isinstance(n, ast.If) and isinstance(n.test, ast.Compare)
              and isinstance(n.test.left, ast.Name) and n.test.left.id == "route" and len(n.test.comparators) == 1
              and isinstance(n.test.comparators[0], ast.Constant) and n.test.comparators[0].value == "/api/actions/configure-gpu-quota")
handler = ast.parse("def handle(self): pass").body[0]
handler.body = [branch]
calls = []
def rpc(root, worker, action, payload, ensure=True):
    calls.append((worker, action, payload, ensure))
    return payload
ns.update(json=json, route="/api/actions/configure-gpu-quota", root="/fixture", task_queue_rpc=rpc)
exec(compile(ast.fix_missing_locations(ast.Module(body=[handler], type_ignores=[])), "quota_http", "exec"), ns)
class Request:
    def __init__(self, payload): self.payload = payload
    def read_request_body(self, route): return json.dumps(self.payload).encode("utf-8")
    def send_json(self, value, status=200): return value, status
value, status = ns["handle"](Request(dict(workerId="w", **per_card["options"])))
assert status == 200 and value["ok"] and calls[0][0:2] == ("w", "configure") and calls[0][3] is False
assert calls[0][2]["gpuCardOverrides"]["1"]["gpuJobsPerCard"] == 3
value, status = ns["handle"](Request(dict(workerId="w", gpuJobsPerCard=0)))
assert status == 400 and len(calls) == 1
print(json.dumps({"ok": True, "quota": 6, "minimumFreeGb": 22}))
