"""Isolated generated Agent functions; retained local inputs and in-memory reports/events."""
import copy
import csv
import io
import json
import os
import pathlib
import posixpath
import stat
import sys
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions

scenario, runtime, base = sys.argv[1:4]
agent = extract_runtime_functions(runtime, ["output_contract_receipt", "action_receipt_fields", "job_result_candidates"])
base = os.path.abspath(base)
if os.name == "nt" and not base.startswith("\\\\?\\"):
    base = "\\\\?\\" + base
os.makedirs(base, exist_ok=True)
# The Agent runs on POSIX servers. Bridge POSIX calls to retained real NTFS
# fixtures on the Windows build host; do not weaken production path validators.
def native(value):
    text = os.fspath(value)
    if os.name == "nt" and (text == "/fixture" or text.startswith("/fixture/")):
        return os.path.join(base, *text[len("/fixture"):].lstrip("/").split("/"))
    return text

def virtual(value):
    text = os.fspath(value)
    if os.name != "nt":
        return text
    plain = os.path.normpath(text).removeprefix("\\\\?\\")
    plain_base = os.path.normpath(base).removeprefix("\\\\?\\")
    try:
        if os.path.normcase(os.path.commonpath([plain_base, plain])) != os.path.normcase(plain_base):
            return "/outside"
        relative = os.path.relpath(plain, plain_base).replace("\\", "/")
        return "/fixture" if relative == "." else "/fixture/" + relative
    except ValueError:
        return "/outside"

if os.name == "nt":
    class Proxy(SimpleNamespace):
        def __getattr__(self, key):
            return getattr(os, key)
    paths = SimpleNamespace(**{key:getattr(posixpath,key) for key in ["join","dirname","basename","splitext","isabs","normpath","relpath","commonpath"]})
    paths.abspath = lambda value: posixpath.normpath(value if str(value).startswith("/") else posixpath.join("/fixture",value))
    paths.realpath = lambda value: virtual(os.path.realpath(native(value)))
    for key in ["exists","isfile","isdir","lexists","getsize","getmtime"]:
        setattr(paths,key,lambda value,key=key:getattr(os.path,key)(native(value)))
    def walk(value, *args, **kwargs):
        for current, dirs, files in os.walk(native(value), *args, **kwargs):
            yield virtual(current), dirs, files
    agent.os = Proxy(path=paths,sep="/",listdir=lambda value:os.listdir(native(value)),
        stat=lambda value:os.stat(native(value)),lstat=lambda value:os.lstat(native(value)),walk=walk)
    agent.open = lambda value,*args,**kwargs:open(native(value),*args,**kwargs)
    agent.pathlib = SimpleNamespace(Path=lambda value:pathlib.Path(native(value)))
    original_glob = agent.glob
    agent.glob = SimpleNamespace(glob=lambda value,*args,**kwargs:[virtual(item) for item in original_glob.glob(native(value),*args,**kwargs)])
events, writes = [], []
agent.append_event = lambda root, event: events.append(copy.deepcopy(event))
agent.atomic_write = lambda file, report: writes.append((file, copy.deepcopy(report)))
plan = "Plans 中文/ 计划 É A.yaml "
file = "outputs/demo/bad.json"

def write(root, relative, content):
    target = os.path.join(native(root), *relative.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "x", encoding="utf-8", newline="\n") as stream:
        stream.write(content)
    return target

def workspace(name, plan_file=plan, result=file, text=None):
    root = os.path.join(base, name)
    os.makedirs(root)
    write(root, plan_file, text if text is not None else "suite: demo\nmode: test\nresult_csv: " + result + "\n")
    if result:
        write(root, result, '{"status":"done"}\n')
        parent = result.rsplit("/", 1)[0]
        write(root, parent + "/env_snapshot.json", '{"python":"test"}\n')
        write(root, parent + "/config_snapshot.yaml", "seed: 42\n")
    return virtual(root)

def request(value=plan, **extra):
    return {"planFile": value, "selectedPlanId": value, "planRevision": "r1", **extra}

def reject(callback):
    before = len(events), len(writes)
    try:
        callback()
    except (ValueError, FileNotFoundError):
        pass
    else:
        raise AssertionError("invalid source accepted")
    assert (len(events), len(writes)) == before

out = {"scenario": scenario, "remoteOperations": 0}
if scenario == "identity":
    calls = []
    def report(root, selected):
        calls.append(selected)
        return {"planFile": selected or "", "status": "failed", "unparseableFiles": [file],
                "checkedAt": "2026-10-10T00:00:00Z", "path": "simple_cluster/contracts/report.json"}
    agent.check_output_contract_action = report
    rows = []
    for value in [plan, plan.strip(), plan.lower(), plan.replace("É", "E\u0301"), plan.replace(" A", "%20A"), "nested/" + plan]:
        body = request(value, options={"plan_file": value, "plan_revision": "r1"})
        before = copy.deepcopy(body)
        started = agent.action_receipt_fields("check-output-contract", body)
        receipt = agent.output_contract_receipt(base, body, "operation", "command")
        assert body == before and started["planFile"] == value and started["selectedPlanId"] == value
        assert receipt["planFile"] == value and receipt["selectedPlanId"] == value
        assert events[-1]["payload"]["planFile"] == value and events[-1]["payload"]["selectedPlanId"] == value
        rows.append({"plan": value, "started": started, "receipt": receipt, "event": events[-1]})
    legacy = agent.action_receipt_fields("run-quality-gate", request())
    assert legacy == agent.action_operation_fields(request()), "other action entry points retain compatibility"
    out.update(rows=rows, calls=calls)
elif scenario == "invalid":
    agent.check_output_contract_action = lambda *args: (_ for _ in ()).throw(AssertionError("invalid request reached report IO"))
    invalid = [None, 0, True, [], {}, "/a.yaml", "C:/a.yaml", "a\\b.yaml", "a//b.yaml", "a/../b.yaml", "a/./b.yaml", "a\na.yaml", "中" * 1366]
    for key in ["planFile", "plan_file", "plan", "selectedPlanId", "selected_plan_id"]:
        for value in invalid + [plan.strip(), plan.lower()]:
            reject(lambda key=key, value=value: agent.output_contract_receipt(base, request(**{key: value}), "op", "cmd"))
    for value in [None, [], {}, 1, "r2", " r1", "r1 "]:
        reject(lambda value=value: agent.output_contract_receipt(base, request(plan_revision=value), "op", "cmd"))
    for value in [[], "invalid", 1, {"plan": plan.strip()}, {"planRevision": "r2"}]:
        reject(lambda value=value: agent.output_contract_receipt(base, request(options=value), "op", "cmd"))
    for value in [None, [], "invalid"]:
        reject(lambda value=value: agent.output_contract_receipt(base, value, "op", "cmd"))
    out.update(events=len(events), writes=len(writes))
elif scenario == "physical":
    root = workspace("physical")
    body = request()
    receipt = agent.output_contract_receipt(root, body, "operation", "command")
    assert receipt["planFile"] == plan and receipt["selectedPlanId"] == plan
    assert receipt["contractReport"]["planFile"] == plan and receipt["unparseableFiles"] == [file]
    assert receipt["status"] == "failed" and receipt["contractIssueType"] == "unparseable_result"
    assert len(writes) == 2 and writes[0][1]["planFile"] == plan
    for alias in [plan.strip(), plan.lower(), plan.replace("É", "E\u0301")]:
        reject(lambda alias=alias: agent.output_contract_receipt(root, request(alias), "bad", "bad"))
    target = agent.os.path.join(root, *plan.split("/"))
    original = agent.os.lstat
    for mode in [stat.S_IFLNK, stat.S_IFIFO]:
        with patch.object(agent.os, "lstat", lambda name, mode=mode: os.stat_result((mode, 1, 1, 1, 1, 1, 0, 0, 0, 0)) if name == target else original(name)):
            reject(lambda: agent.output_contract_receipt(root, body, "bad", "bad"))
    out.update(plan=plan, receipt=receipt, events=events, reportPath=writes[0][1]["path"])
elif scenario == "jobs":
    selected = "experiments/plans/A.yaml"
    root = workspace("jobs", selected, "", "suite: demo\nmode: test\n")
    columns = ["planFile", "plan_file", "suite", "result_csv"]
    rows = [[selected, "", "demo", "outputs/owned/bad.json"],
            ["", "", "demo", "outputs/anonymous/bad.json"],
            [selected.lower(), "", "demo", "outputs/case/bad.json"],
            [selected + " ", "", "demo", "outputs/space/bad.json"],
            ["other/" + selected, "", "demo", "outputs/foreign/bad.json"],
            [selected, selected.lower(), "demo", "outputs/conflict/bad.json"]]
    buffer = io.StringIO(); writer = csv.writer(buffer); writer.writerow(columns); writer.writerows(rows)
    write(root, "experiments/results/jobs.csv", buffer.getvalue())
    for row in rows:
        write(root, row[-1], '{"status":"done"}\n')
        parent = row[-1].rsplit("/", 1)[0]
        write(root, parent + "/env_snapshot.json", '{}\n'); write(root, parent + "/config_snapshot.yaml", "seed: 42\n")
    assert agent.job_result_candidates(root, plan=selected, strict_plan=True) == [rows[0][-1]]
    assert rows[1][-1] in agent.job_result_candidates(root, plan=selected), "non-strict legacy suite lookup retained"
    receipt = agent.output_contract_receipt(root, request(selected), "operation", "command")
    assert receipt["contractReport"]["resultFiles"] == [rows[0][-1]]
    assert receipt["unparseableFiles"] == [rows[0][-1]]
    out.update(plan=selected, receipt=receipt)
elif scenario == "keys":
    plans = [plan, plan.strip(), plan.lower(), plan.replace("É", "E\u0301"), plan.replace(" A", "%20A"), "nested/" + plan]
    paths = []
    for index, value in enumerate(plans):
        root = workspace("key-" + str(index), value)
        receipt = agent.output_contract_receipt(root, request(value), "op", "cmd")
        paths.append(receipt["contractReportPath"])
        assert receipt["contractReportPath"] == "simple_cluster/contracts/contract_check_reports/by_plan/" + agent.result_plan_directory_key(value) + "/latest.json"
    assert len(set(paths)) == len(plans)
    out.update(plans=plans, paths=paths)
elif scenario == "formats":
    rows = []
    for kind, filename, data in [("csv", "metrics_summary.csv", "experiment_id,metric,value\nrun-1,AUC,0.91\n"),
                                 ("json", "metrics.json", '{"metrics":{"AUC":0.92},"seed":0}\n'),
                                 ("text", "summary.txt", "AUC: 0.93\nloss=0.2\n")]:
        value = "experiments/plans/" + kind + ".yaml"
        result = "outputs/" + kind + "/" + filename
        root = workspace("format-" + kind, value, "", "suite: " + kind + "\nmode: test\nresult_csv: " + result + "\n")
        write(root, result, data)
        parent = result.rsplit("/", 1)[0]
        write(root, parent + "/env_snapshot.json", '{}\n'); write(root, parent + "/config_snapshot.yaml", "seed: 42\n")
        receipt = agent.output_contract_receipt(root, request(value), "op", "cmd")
        assert receipt["status"] == "completed" and receipt["contractReport"]["parseableResultCount"] > 0
        assert receipt["contractReport"]["resultFiles"] == [result] and receipt["unparseableFiles"] == []
        rows.append({"plan": value, "receipt": receipt})
    out.update(rows=rows)
elif scenario == "report":
    for report in [{"planFile":plan.strip()}, {"planFile":plan,"plan_file":plan.strip()},
                   {"planFile":plan,"planRevision":"r2"}, {"planFile":None}, [], None]:
        agent.check_output_contract_action = lambda *args, report=report: report
        reject(lambda: agent.output_contract_receipt(base, request(), "op", "cmd"))
    out.update(events=len(events), writes=len(writes))
else:
    raise AssertionError("unknown scenario")
out["passed"] = True
print(json.dumps(out, ensure_ascii=False))
