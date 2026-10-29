import ast
import json
import math
from pathlib import Path
import re
import time

root = Path(__file__).resolve().parents[2]
def definitions(file, names=None):
    source = file.read_text(encoding="utf-8").split("String.raw`", 1)[1].rsplit("`", 1)[0]
    return [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and (names is None or node.name in names)]

options = {}
capture = ""
def option(target, key, value=None):
    if value is None:
        return options.get((target, key), "")
    options[target, key] = value
def tmux(args):
    assert args[0] == "capture-pane"
    return capture
ns = dict(json=json, math=math, re=re, time=time, task_option=option, task_tmux=tmux,
          gpu_row_id=lambda gpu: str(gpu["index"]), task_memory_info=lambda *args: None)
nodes = definitions(root / "src/runtime/GpuMemoryBudget.ts") + definitions(root / "src/runtime/TmuxTaskLifecycle.ts", {"task_admission_gpu", "task_gpu_quota_policy"})
exec(compile(ast.Module(body=nodes, type_ignores=[]), "native-memory-budget", "exec"), ns)
gpu = dict(index="0", name="fixture GPU", memoryTotalMb=81920, memoryUsedMb=100, processes=[])
row = dict(commandId="c", projectId="p", workflowId="plan", planRevision="r", codeFingerprint="code", case="case", executionMode="train", workerId="w", tmuxPane="%1", gpuId="0", phase="running", dead=False,
           options=dict(gpuQuotaScheduling=1, gpuMemoryBudgetScheduling=1, gpuJobsPerCard=4, gpuMinFreeMemoryGb=2))
choose = ns["task_admission_gpu"]
assert choose(row, [gpu], {}) == "0"
ns["task_budget_reserve"](row, gpu)
other = dict(row, commandId="c2", tmuxPane="%2", options=dict(row["options"]))
other["_budgetLive"], other["_budgetEvidence"] = [row], [(row, ns["task_budget_read"](row))]
assert choose(other, [gpu], {"0": 1}) is None, "an unmeasured job reserves all startup capacity"
gpu.update(memoryUsedMb=12388, processes=[dict(pid="1", pluginManaged=True, jobCommandId="c", jobProjectId="p", usedMemoryMb=12288)])
update = ns["task_budget_update"]
for now in range(0, 600, 20):
    update("/fixture", [row], [gpu], now)
assert not ns["task_budget_read"](row)["ready"]
update("/fixture", [row], [gpu], 600)
evidence = ns["task_budget_read"](row)
assert evidence["ready"] and evidence["peakMb"] == 12288
assert evidence["budgetMb"] == ns["task_budget_size"](12288)
# Simulate a fresh controller recovering only persisted window metadata.
restored = {key: value for key, value in row.items() if key != "_gpuBudget"}
assert ns["task_budget_read"](restored)["ready"]
other["options"].pop("gpuMemoryReservation", None)
other["_budgetEvidence"] = [(row, evidence)]
assert choose(other, [gpu], {"0": 1}) == "0"
ns["task_budget_reserve"](other, gpu)
third = dict(other, commandId="c3", tmuxPane="%3", options=dict(other["options"]))
third["_budgetLive"] = [row, other]
third["_budgetEvidence"] = [(row, evidence), (other, ns["task_budget_read"](other))]
gpu["memoryUsedMb"] = 65 * 1024
assert choose(third, [gpu], {"0": 2}) is None, "newly admitted, unallocated budget survives another pass"
gpu["memoryUsedMb"] = 12388
capture = "torch.OutOfMemoryError: CUDA out of memory"
update("/fixture", [row, other], [gpu], 620)
assert ns["task_budget_read"](row)["oom"]
third["_budgetEvidence"] = [(row, ns["task_budget_read"](row)), (other, ns["task_budget_read"](other))]
assert choose(third, [gpu], {"0": 2}) is None
# Gaps do not count toward the ten-minute coverage, and no project-specific epoch output is needed.
capture = ""
gap = dict(row, commandId="gap", tmuxPane="%4", options={**row["options"]})
gap["options"].pop("gpuMemoryReservation", None)
gap.pop("_gpuBudget", None)
assert choose(gap, [gpu], {}) == "0"
ns["task_budget_reserve"](gap, gpu)
gpu["processes"] = [dict(pid="4", pluginManaged=True, jobCommandId="gap", jobProjectId="p", usedMemoryMb=12288)]
update("/fixture", [gap], [gpu], 0)
update("/fixture", [gap], [gpu], 600)
assert not ns["task_budget_read"](gap)["ready"]
# The source window may be gone after a reload. An exact PLAN/hardware estimate
# carried by the local scheduler remains usable, with the same native admission checks.
gpu.update(memoryUsedMb=100, processes=[])
cached = dict(row, commandId="cached", tmuxPane="%5", options={**row["options"]}, _budgetLive=[], _budgetEvidence=[])
cached.pop("_gpuBudget", None)
request = dict(version=1, group=ns["task_budget_group"](cached), hardware=ns["task_budget_hardware"]("w", gpu),
               budgetMb=ns["task_budget_size"](12288), probe=False, estimate=dict(version=1, peakMb=12288, ready=True))
cached["options"]["gpuMemoryReservation"] = request
assert choose(cached, [gpu], {}) == "0"
ns["task_budget_reserve"](cached, gpu)
assert ns["task_budget_read"](cached)["peakMb"] == 12288 and ns["task_budget_read"](cached)["ready"]
for change in (dict(group="other-plan"), dict(hardware="other-worker"), dict(budgetMb=12288), dict(estimate=dict(version=1, peakMb=float("nan"), ready=True))):
    invalid = dict(cached, options={**cached["options"], "gpuMemoryReservation": {**request, **change}})
    assert choose(invalid, [gpu], {}) is None
gpu["memoryUsedMb"] = 75 * 1024
assert choose(cached, [gpu], {}) is None
gpu["memoryUsedMb"] = 100
cached["_budgetEvidence"] = [(row, {**evidence, "oom": True})]
assert choose(cached, [gpu], {}) is None, "persisted estimates never override native OOM evidence"
print(json.dumps(dict(timedProbe=True, reservation=True, oom=True)))
