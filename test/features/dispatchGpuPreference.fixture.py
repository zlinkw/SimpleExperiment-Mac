"""Exercise automatic placement after its original GPU becomes busy."""
import ast
import json
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8").split("String.raw`", 1)[1].rsplit("`", 1)[0]
node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == "task_admission_gpu")
ns = dict(gpu_row_id=lambda gpu: gpu["index"], task_memory_info=lambda *args: None,
          gpu_row_busy=lambda gpu, *args: gpu["busy"])
exec(compile(ast.Module(body=[node], type_ignores=[]), "admission", "exec"), ns)
choose = ns["task_admission_gpu"]
gpus = [{"index": str(i), "busy": i == 0} for i in range(3)]
automatic = dict(gpuId="0", requireIdleGpu=True, maxConcurrentGpus=3, dispatchPolicy="automatic")
assert choose(automatic, gpus, {"0": 1}) == "1", "an idle card must not be stranded behind the original automatic placement"
assert choose(dict(automatic, gpuId="2"), gpus, {"0": 1}) == "2", "prefer the original GPU while it has capacity"
assert choose(dict(automatic, dispatchPolicy="manual"), gpus, {"0": 1}) == "0", "manual placement stays exact"
assert choose(automatic, [dict(gpu, busy=True) for gpu in gpus], {"0": 1}) is None
assert choose(dict(automatic, maxConcurrentGpus=1), gpus, {"0": 1}) is None, "configured card cap still applies"
print(json.dumps({"ok": True, "fallback": "1", "manual": "0"}))
