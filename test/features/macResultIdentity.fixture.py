"""Select only the compiled Agent's shared result-layout function, never an entry point."""
import json
import pathlib
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions

agent = extract_runtime_functions(sys.argv[1], ["result_plan_directory_key"])
values = json.loads(sys.argv[2])
keys = [agent.result_plan_directory_key(value) for value in values]
assert len(set(keys)) == len(keys)
for value in ["./a.yaml", "a//b.yaml", "a/../b.yaml", "a\\b.yaml", "/a.yaml", "C:/a.yaml", "a:b", 1, [], "a\n.yaml", "a\x7f.yaml"]:
    try: agent.result_plan_directory_key(value)
    except ValueError: pass
    else: raise AssertionError("invalid result Plan identity accepted")
print(json.dumps({"keys": keys, "remoteOperations": 0}))
