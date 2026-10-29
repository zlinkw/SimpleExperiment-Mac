"""Extract just the native execution inventory; synthetic panes, no remote server."""
import ast
import base64
import json
import os
from pathlib import Path
import re
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8").split("String.raw`", 1)[1].rsplit("`", 1)[0]
names = {"task_inventory", "task_execution_inventory", "task_safe_path"}
nodes = [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name in names]
assert len(nodes) == len(names)
root = os.path.realpath("/synthetic-project")
lines = []
for index in range(180):
    header = dict(root=root, lifecycleProtocol=2, commandId="command-" + str(index), workerId="w", projectId="project",
                  workflowId="plan", planFile="plan.yaml", outputDir="work/" + str(index), tmuxPane="%" + str(index), pane="%" + str(index),
                  _se_payload=dict(version=1, parts=80, bytes=160000, sha256="a" * 64))
    if index == 179:
        header["root"] = os.path.realpath("/other-project")
    encoded = base64.urlsafe_b64encode(json.dumps(header).encode("utf-8")).decode("ascii")
    lines.append("\t".join([header["pane"], "@" + str(index), "mine-gpu-0", "0" if index < 3 else "1",
                           "" if index < 3 else "0", encoded, "running", "0", "work/log"]))
calls = []
def tmux(args):
    calls.append(args)
    assert args[0] == "list-panes", "inventory must not fetch source chunks or capture logs"
    return "\n".join(lines)
def forbidden(*args, **kwargs):
    raise AssertionError("execution inventory read artifacts, logs or source payload")
ns = dict(os=os, base64=base64, json=json, re=re, task_tmux=tmux, now_iso=lambda: "now",
          task_read_job=forbidden, task_public_observation=forbidden, task_manifest_observation=forbidden)
exec(compile(ast.Module(body=nodes, type_ignores=[]), "execution_inventory", "exec"), ns)
result = ns["task_execution_inventory"](root)
assert result["queryComplete"] and result["executionOnly"] and len(result["tasks"]) == 179
assert sum(not task["observation"]["tmux"]["dead"] for task in result["tasks"]) == 3
assert len(calls) == 1
initial_calls = len(calls)
assert all(not ({"runtimeDiagnostics", "successful", "resultState", "_se_payload", "executionSource"} & task.keys()) for task in result["tasks"])
ns["task_queue_session"] = lambda *args: "mine-scheduler"
ns["task_option"] = lambda target, key: '["missing-old"]' if (target, key) == ("mine-scheduler:queue", "cancelled") else forbidden()
queries = [dict(commandId="command-0", projectId="project", workerId="w", outputDir="work/0"),
           dict(commandId="missing-old", projectId="project", workerId="w", outputDir="work/missing")]
selected = ns["task_execution_inventory"](root, queries)
assert len(selected["tasks"]) == 2
assert selected["tasks"][0]["observation"]["tmux"]["paneId"] == "%0"
assert selected["tasks"][1]["observation"]["cancelled"] and "tmux" not in selected["tasks"][1]["observation"]
assert all("result" not in task["observation"] for task in selected["tasks"])
ns["local_stop_tmux_inventory"] = lambda root: [dict(command="missing-old", project="project", pane="%legacy", window="@legacy", session="mine", dead="0", exitCode="")]
legacy = ns["task_execution_inventory"](root, [queries[1]])["tasks"][0]["observation"]
assert legacy["cancelled"] and legacy["tmux"]["paneId"] == "%legacy", "a cancel fence cannot conceal a still-live legacy tab"
ns["local_stop_tmux_inventory"] = lambda root: []
for invalid in [dict(queries[0], workerId="other"), dict(queries[0], outputDir="../outside")]:
    try:
        ns["task_execution_inventory"](root, [invalid])
    except ValueError:
        pass
    else:
        raise AssertionError("foreign worker or escaping control path accepted")
ns["task_option"] = lambda *args: forbidden()
try:
    ns["task_execution_inventory"](root, [queries[1]])
except AssertionError:
    pass
else:
    raise AssertionError("a failed fence query was reported as confirmed absence")
ns["task_option"] = lambda target, key: '["missing-old"]' if (target, key) == ("mine-scheduler:queue", "cancelled") else forbidden()
# Exercise the actual HTTP branch, extracting its AST without importing or
# executing the Agent module, starting a server, or reading a project log.
agent = ast.parse(Path(sys.argv[2]).read_text(encoding="utf-8"))
branch = next(node for node in ast.walk(agent) if isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
              and isinstance(node.test.left, ast.Name) and node.test.left.id == "route"
              and len(node.test.comparators) == 1 and isinstance(node.test.comparators[0], ast.Constant)
              and node.test.comparators[0].value == "/api/worker/tasks/query" and any(isinstance(item, ast.Call) and isinstance(item.func, ast.Attribute) and item.func.attr == "read_request_body" for item in ast.walk(node)))
handler = ast.parse("def handle(self): pass").body[0]
handler.body = [branch]
ns.update(root=root, route="/api/worker/tasks/query", task_query=forbidden, task_collection_query=forbidden, task_declared_results=forbidden)
exec(compile(ast.fix_missing_locations(ast.Module(body=[handler], type_ignores=[])), "http_inventory", "exec"), ns)
class Request:
    def __init__(self, payload): self.payload = payload
    def read_request_body(self, route): return json.dumps(self.payload).encode("utf-8")
    def send_json(self, value, status=200): return value, status
value, status = ns["handle"](Request(dict(executionOnly=True, queries=[queries[1]])))
assert status == 200 and value["tasks"][0]["observation"]["cancelled"]
value, status = ns["handle"](Request(dict(executionOnly=True, queries=queries, declarations=[])))
assert status == 400 and value["error"] == "EXECUTION_INVENTORY_SELECTION_INVALID"
selected_calls = []
def selected_query(root, queries, selected_only=False, observation_only=False):
    selected_calls.append((queries, selected_only, observation_only))
    return {"queryComplete": True, "tasks": []}
ns["task_query"] = selected_query
value, status = ns["handle"](Request(dict(selectedOnly=True, queries=[queries[0]])))
assert status == 200 and selected_calls == [([queries[0]], True, False)]
value, status = ns["handle"](Request(dict(selectedOnly=True, observationOnly=True, queries=[queries[0]])))
assert status == 400 # Result-only route cannot silently fall back to the full control query.
result_calls=[]
ns["task_result_query"]=lambda root, queries,diagnostics_only=False,compact=False: result_calls.append((queries,diagnostics_only,compact)) or {"resultsOnly":True}
value, status = ns["handle"](Request(dict(selectedOnly=True, observationOnly=True, queries=[queries[0]])))
assert status == 200 and value["resultsOnly"] and result_calls==[([queries[0]],False,False)]
value,status=ns["handle"](Request(dict(selectedOnly=True,observationOnly=True,diagnosticsOnly=True,queries=[queries[0]])))
assert status==200 and result_calls[-1]==([queries[0]],True,False)
value,status=ns['handle'](Request(dict(selectedOnly=True,observationOnly=True,compact=True,queries=[queries[0]])))
assert status==200 and result_calls[-1]==([queries[0]],False,True)
declaration_calls=[]
ns["task_declaration_query"]=lambda root,declarations:declaration_calls.append(declarations) or {"declarationOnly":True}
value,status=ns["handle"](Request(dict(declarationOnly=True,declarations=[])))
assert status==200 and value["declarationOnly"] and declaration_calls==[[]]
value, status = ns["handle"](Request(dict(selectedOnly=True, queries=queries, declarations=[])))
assert status == 400 and value["error"] == "TASK_QUERY_SELECTION_INVALID"
diagnostic_branch=next(node for node in ast.walk(agent) if isinstance(node,ast.If) and isinstance(node.test,ast.Compare)
    and isinstance(node.test.left,ast.Name) and node.test.left.id=='route' and len(node.test.comparators)==1
    and isinstance(node.test.comparators[0],ast.Constant) and node.test.comparators[0].value=='/api/worker/tasks/diagnostics'
    and any(isinstance(item,ast.Call) and isinstance(item.func,ast.Attribute) and item.func.attr=='read_request_body' for item in ast.walk(node)))
handler.body=[diagnostic_branch];ns['route']='/api/worker/tasks/diagnostics'
exec(compile(ast.fix_missing_locations(ast.Module(body=[handler],type_ignores=[])),'http_diagnostics','exec'),ns)
value,status=ns['handle'](Request(dict(queries=[queries[0]])))
assert status==200 and result_calls[-1]==([queries[0]],True,False)
value,status=ns['handle'](Request(dict(queries=[queries[0]],compact=True)))
assert status==200 and result_calls[-1]==([queries[0]],True,True)
classifier=next(node for node in ast.walk(agent) if isinstance(node,ast.FunctionDef) and node.name=='classify_request')
exec(compile(ast.fix_missing_locations(ast.Module(body=[classifier],type_ignores=[])),'http_class','exec'),ns)
assert ns['classify_request'](None,'POST','/api/worker/tasks/diagnostics')=='read','log reads must leave control/probe slots free'
print(json.dumps(dict(ok=True, panes=179, tmuxCalls=initial_calls)))
