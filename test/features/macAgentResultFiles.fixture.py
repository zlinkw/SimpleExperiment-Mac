"""Actual generated Agent functions over retained files; no remote actions or module entry."""
import copy
import csv
import io
import json
import os
import pathlib
import stat
import sys
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
from posixRuntimeFixture import bind_posix_runtime

scenario, runtime, base = sys.argv[1:4]
agent = extract_runtime_functions(runtime, ["output_contract_receipt", "output_contract_expand", "output_contract_plan",
                                           "parse_result_file", "output_contract_read_snapshot", "action_receipt_fields"])
base = os.path.abspath(base)
if os.name == "nt" and not base.startswith("\\\\?\\"):
    base = "\\\\?\\" + base
os.makedirs(base, exist_ok=True)
native, virtual = bind_posix_runtime(agent, base)
events, writes = [], []
agent.append_event = lambda root, event: events.append(copy.deepcopy(event))
agent.atomic_write = lambda file, report: writes.append((file, copy.deepcopy(report)))
plan = "Plans 中文/ 计划 É.yaml "
policy = {"metricAliases": {}, "csvColumnMapping": {}}


def save(root, relative, data):
    target = os.path.join(native(root), *relative.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "xb") as stream:
        stream.write(data.encode("utf-8") if isinstance(data, str) else data)
    return target


def workspace(name, text):
    root = os.path.join(base, name)
    os.makedirs(root)
    root = virtual(root)
    save(root, plan, text)
    return root


def snapshots(root, directory):
    save(root, directory + "/env_snapshot.json", '{}\n')
    save(root, directory + "/config_snapshot.yaml", "seed: 42\n")


def receipt(root):
    return agent.output_contract_receipt(root, {"planFile": plan, "selectedPlanId": plan, "planRevision": "r1"}, "operation", "command")


def reject(callback):
    before = len(events), len(writes)
    try:
        callback()
    except (ValueError, OSError, UnicodeError):
        pass
    else:
        raise AssertionError("Invalid input or changed identity accepted")
    assert (len(events), len(writes)) == before


out = {"scenario": scenario, "remoteOperations": 0}
if scenario == "paths":
    rows = []
    for index, source in enumerate(["outputs/研究/A.json", "outputs/研究/a.json", "outputs/研究/ A.json ",
                                    "outputs/研究/E\u0301.json", "outputs/研究/É.json", "outputs/研究/literal%20.json",
                                    "outputs/研究/quote'#, file.json ", "Outputs/研究/mixed.json"]):
        root = workspace("path-" + str(index), "suite: demo\nresult_json: " + json.dumps(source, ensure_ascii=False) + "\n")
        save(root, source, '{"status":"done"}\n')
        snapshots(root, source.rsplit("/", 1)[0])
        contract = agent.output_contract_plan(root, plan)
        assert contract["candidates"] == [source]
        result = receipt(root)
        assert result["contractReport"]["resultFiles"] == [source] and result["unparseableFiles"] == [source]
        rows.append({"plan": plan, "source": source, "receipt": result})
        reject(lambda: agent.output_contract_read_snapshot(root, source + " "))
    for value in [None, {}, [], 4, "/outputs/a.csv", "outputs//a.csv", "outputs/./a.csv", "outputs/../a.csv",
                  "C:/outputs/a.csv", "outputs\\a.csv", "outputs/a\n.csv"]:
        assert agent.output_contract_candidate(value) == ""
    out["rows"] = rows
elif scenario == "yaml":
    names = ["outputs/demo/quoted'#, first.json ", "outputs/demo/literal%20.json", "outputs/demo/runner.json ", "outputs/demo/command.json "]
    text = ("suite: demo\nmode: test\nbase: &base {path: " + json.dumps(names[0]) + "}\n"
            "expectedResults: [*base, " + json.dumps(names[1]) + "]\n"
            "runner: {outputs: [{path: " + json.dumps(names[2]) + "}]}\n"
            "test_command: >-\n  python evaluate.py\n  --result-json '" + names[3] + "'\n"
            "command: python train.py --result-json outputs/demo/ignored.json\n")
    root = workspace("yaml", text)
    for source in names:
        save(root, source, '{"status":"done"}\n')
    snapshots(root, "outputs/demo")
    assert agent.output_contract_plan(root, plan)["candidates"] == sorted(names)
    result = receipt(root)
    assert result["unparseableFiles"] == sorted(names)
    out.update(plan=plan, receipt=result, sources=sorted(names))
elif scenario == "jobs":
    root = workspace("jobs", "suite: demo\nmode: test\n")
    source = "outputs/job/ 原始 'É%20.json "
    names = [source, "outputs/job/repaired.json"]
    buffer = io.StringIO(); writer = csv.writer(buffer); writer.writerow(["planFile", "plan_file", "result_json", "output_dir"])
    writer.writerows([[plan, "", source, ""], [plan, "", "outputs/job/../repaired.json", ""],
                      [plan, plan.lower(), names[1], ""], ["", "", names[1], ""], [plan, "", "C:/outputs/job/repaired.json", ""]])
    save(root, "experiments/results/jobs.csv", buffer.getvalue())
    for item in names:
        save(root, item, '{"status":"done"}\n')
    snapshots(root, "outputs/job")
    assert agent.job_result_candidates(root, plan=plan, strict_plan=True) == [source]
    result = receipt(root); assert result["unparseableFiles"] == [source]
    out.update(plan=plan, receipt=result, sources=[source])
elif scenario == "glob":
    root = workspace("glob", 'suite: demo\nexpectedResults: ["outputs/demo/**/A*.json "]\n')
    names = ["outputs/demo/A.json ", "outputs/demo/sub/A two.json ", "outputs/demo/sub/a lower.json ", "outputs/demo/sub/A.json"]
    for source in names:
        save(root, source, '{"status":"done"}\n')
    snapshots(root, "outputs/demo")
    declared = agent.output_contract_plan(root, plan)["candidates"]
    expected = sorted(names[:2]); assert agent.output_contract_expand(root, declared) == expected
    assert not agent.output_contract_pattern_matches("outputs/*/A.json", "outputs/demo/sub/A.json")
    assert agent.output_contract_pattern_matches("outputs/**/A.json", "outputs/demo/sub/A.json")
    assert agent.output_contract_expand(root, [names[0]], patterns=False) == [names[0]]
    result = receipt(root); assert result["unparseableFiles"] == expected
    out.update(plan=plan, receipt=result, sources=expected, rawCandidates=declared)
elif scenario == "formats":
    rows = []
    for kind, suffix, data, expected in [("csv", ".csv ", "metric,value\nAUC,0.91\n", 0.91),
                                          ("json", ".json ", '{"metrics":{"AUC":0.92}}\n', 0.92),
                                          ("text", ".txt ", "AUC: 0.93\n", 0.93)]:
        source = "outputs/" + kind + "/metric" + suffix
        root = workspace("format-" + kind, "suite: " + kind + "\nresult_csv: " + json.dumps(source) + "\n")
        save(root, source, data); snapshots(root, "outputs/" + kind)
        records = agent.parse_result_file(root, source, policy, strict_paths=True)
        assert len(records) == 1 and next(iter(records[0]["metrics"].values()))["value"] == expected
        assert records[0]["sourceFiles"][0]["path"] == source and records[0]["provenance"]["artifactKey"] == source
        assert records[0]["sourceFiles"][0]["type"] == ("log" if kind == "text" else kind)
        result = receipt(root); assert result["status"] == "completed" and result["contractReport"]["resultFiles"] == [source]
        rows.append({"plan": plan, "source": source, "receipt": result})
    out["rows"] = rows
elif scenario == "snapshots":
    source = "outputs/demo/原始.json "
    root = workspace("snapshots", "suite: demo\nresult_json: " + json.dumps(source, ensure_ascii=False) + "\n")
    file = save(root, source, '{"metrics":{"AUC":0.94}}\r\n')
    first = agent.output_contract_read_snapshot(root, source)
    assert first["text"].endswith("\r\n") and first["identity"][2] == os.path.getsize(file)
    original = agent.os.read
    with patch.object(agent.os, "read", lambda descriptor, count: original(descriptor, min(count, 3))):
        assert agent.output_contract_read_snapshot(root, source)["text"] == first["text"], "short reads must be completed"
    calls = [0]
    def changed_read(descriptor, count):
        data = original(descriptor, count)
        if not calls[0]:
            with open(file, "ab") as stream:
                stream.write(b"changed")
        calls[0] += 1
        return data
    with patch.object(agent.os, "read", changed_read):
        reject(lambda: agent.output_contract_read_snapshot(root, source))
    reject(lambda: agent.output_contract_verify_snapshot(root, source, first))
    for mode in [stat.S_IFLNK, stat.S_IFIFO]:
        original_lstat = agent.os.lstat
        target = agent.os.path.join(root, *source.split("/"))
        with patch.object(agent.os, "lstat", lambda value, mode=mode: os.stat_result((mode, 1, 1, 1, 1, 1, 0, 0, 0, 0)) if value == target else original_lstat(value)):
            reject(lambda: agent.output_contract_read_snapshot(root, source))
    out.update(events=len(events), writes=len(writes), descriptorRead=True, changedInputRejected=True)
elif scenario == "limits":
    for index, text in enumerate(["[]\n", "suite: 7\n", "loop: &loop [*loop]\n", "!!python/object/apply:os.system ['false']\n", "values: [" + ",".join("x" for _ in range(9000)) + "]\n"]):
        root = workspace("yaml-limit-" + str(index), text)
        try:
            agent.output_contract_plan(root, plan)
        except Exception:
            pass
        else:
            raise AssertionError("Malformed or oversized Plan accepted")
    root = workspace("binary", "suite: demo\n")
    save(root, "outputs/bad.json", b"\xff\xfe")
    reject(lambda: agent.output_contract_read_snapshot(root, "outputs/bad.json"))
    save(root, "outputs/large.json", b"x" * (5 * 1024 * 1024 + 1))
    reject(lambda: agent.output_contract_read_snapshot(root, "outputs/large.json"))
    out.update(events=len(events), writes=len(writes), budgets=True, fatalUtf8=True)
else:
    raise AssertionError("Unknown scenario")
out["passed"] = True
print(json.dumps(out, ensure_ascii=False))
