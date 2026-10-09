"""Exercise only the log filter; do not initialize the Agent or write state."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions

agent = extract_runtime_functions(str(Path(__file__).resolve().parents[2] / "dist/runtime/cluster_agent.py"), ["_is_noise_line"])
for line, expected in [
    ("(custom-env) owner@compute:~/project$", True),
    ("(custom-env) owner@compute:~/project$ conda activate custom-env", True),
    ("(custom-env) owner@compute:~/project$ Error: failed", False),
    ("(stage) loss=0.4", False),
    ("/srv/projects/simple_agent/checkpoint saved", False),
    ("/home/researcher/project metrics completed", False),
    ("CUDA out of memory", False),
    ("exit_code 1", False),
    ("[pipe-pane] capture", True),
]:
    assert agent._is_noise_line(line) == expected, line
print("generic log filter passed")
