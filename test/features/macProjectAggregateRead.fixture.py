"""Actual Plan producer and checked project reader; retain local files, capture publishers."""
import copy
import csv
import io
import json
import math
import os
import pathlib
import sys
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
from posixRuntimeFixture import bind_posix_runtime

scenario, runtime, base = sys.argv[1:4]
agent = extract_runtime_functions(runtime, ["parse_results_action", "write_project_seed_aggregate", "write_project_final_summary", "_write_dataset_seed_aggregate"])
base = os.path.abspath(base)
if os.name == "nt" and not base.startswith("\\\\?\\"):
    base = "\\\\?\\" + base
os.makedirs(base, exist_ok=True)
native, virtual = bind_posix_runtime(agent, base)
project_seed, project_final = agent.write_project_seed_aggregate, agent.write_project_final_summary
agent.write_project_seed_aggregate = lambda root, summary: []
agent.write_project_final_summary = lambda root, summary: []
agent.agent_dir = lambda root: "/fixture/state/" + root.rsplit("/", 1)[-1]
agent.evaluate_claim_evidence = lambda root, summary: {"status": "needs_experiment", "claims": []}
agent.apply_claim_evidence_summary = lambda summary, report: None
captured, atomic, events = [], [], []
agent.publish_dataset_outputs = lambda root, outputs: captured.extend(copy.deepcopy(outputs))
agent.atomic_write = lambda path, value: atomic.append((path, copy.deepcopy(value)))
agent.write_atomic_csv = lambda path, header, rows: None
agent.write_atomic_text = lambda path, value: None
agent.append_event = lambda root, event: events.append(copy.deepcopy(event))
plan_a, plan_b, revision = "experiments/Plans A/ 计划 É.yaml ", "experiments/Plans B/计划.yaml", " revision "

def write(root, relative, value, replace=False):
    target = os.path.join(native(root), *relative.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    data = value if isinstance(value, bytes) else value.encode("utf-8") if isinstance(value, str) else json.dumps(value, ensure_ascii=False).encode("utf-8")
    with open(target, "wb" if replace else "xb") as stream:
        stream.write(data)
    return target

def text(root, relative):
    with open(os.path.join(native(root), *relative.split("/")), encoding="utf-8", newline="") as stream:
        return stream.read()

def csv_text(headers, rows):
    buffer = io.StringIO(newline=""); csv.writer(buffer).writerows([headers, *rows]); return buffer.getvalue()

def scope(plan, name):
    return "simple_cluster/results/by_plan/" + agent.result_plan_directory_key(plan) + "/" + name

def persist(root, outputs, values, replace=False):
    for output in outputs:
        write(root, output[1], csv_text(output[2], output[3]) if output[0] == "csv" else output[2], replace=replace)
    for absolute, value in values:
        relative = agent.os.path.relpath(absolute, root)
        if "/by_plan/" in relative and relative.endswith(("summary.json", "dataset-index.json")):
            write(root, relative, value, replace=replace)

def make_plan(root, plan, name, datasets=("BUS",), archived=True, plain_source=False):
    source = "outputs/" + name + ("/metrics.csv" if plain_source else "/ 指标 É.csv ")
    write(root, plan, 'suite: demo\nseeds: [1, 2]\ncases: [{case: same}]\nresult_csv: ' + json.dumps(source, ensure_ascii=False) + '\n')
    rows = [[plan, "same", seed, "fixture", dataset, value] for dataset in datasets for seed, value in [(1, .6), (2, .8)]]
    write(root, source, csv_text(["plan", "case", "seed", "method", "dataset", "accuracy"], rows))
    if archived:
        write(root, agent.archive_state_relpath(plan), {"planFile": plan, "planRevision": revision, "entries": {source: {"path": source, "planFile": plan, "planRevision": revision, "archived": True, "status": "archived"}}})
    begin, start = len(captured), len(atomic)
    summary = agent.parse_results_action(root, None, plan, revision, {"topologyMode": "single_worker", "resultOwnerWorkerId": "fixture-worker"})
    persist(root, captured[begin:], atomic[start:])
    return summary

def workspace(name, two=True, datasets=("BUS",), archived=True):
    root = virtual(os.path.join(base, name)); os.makedirs(native(root))
    one = make_plan(root, plan_a, "A", datasets, archived)
    two_summary = make_plan(root, plan_b, "B", ("BUS",), archived) if two else None
    captured.clear()
    return root, one, two_summary

def reject(callback):
    count = len(captured), len(atomic), len(events)
    try:
        callback()
    except (ValueError, OSError, UnicodeError):
        pass
    else:
        raise AssertionError("Invalid project aggregate source accepted")
    assert (len(captured), len(atomic), len(events)) == count

def project_csvs():
    return [{"path": output[1], "text": csv_text(output[2], output[3])} for output in captured if output[0] == "csv"]

out = {"scenario": scenario, "remoteOperations": 0, "archiveMutations": 0}
if scenario == "workflow":
    root, one, two = workspace("workflow", datasets=("BUS", "PAD"))
    write(root, "simple_cluster/results/by_plan/.DS_Store", b"ignored Mac metadata")
    seed_tables = project_seed(root, two); final_tables = project_final(root, two)
    assert {row["dataset"] for row in seed_tables} == {"BUS", "PAD"} == {row["dataset"] for row in final_tables}
    final = next(output for output in captured if output[0] == "csv" and output[1].endswith("BUS/project_final.csv"))
    assert len(final[3]) == 2 and {row[final[2].index("plan_file")] for row in final[3]} == {plan_a, plan_b}
    assert all(abs(float(row[final[2].index("accuracy_mean")]) - .7) < 1e-12 for row in final[3])
    assert all(abs(float(row[final[2].index("accuracy_sd")]) - math.sqrt(.02)) < 1e-12 for row in final[3])
    out.update(csvs=project_csvs(), plans=[plan_a, plan_b], tables=final_tables)
elif scenario == "paths":
    variants = [plan_a, plan_a.lower(), plan_a.rstrip(), plan_a.replace("É", "E\u0301"), plan_a.replace(" ", "%20"), plan_a.replace("计划", "'计划'")]
    keys = []
    for index, plan in enumerate(variants):
        root = virtual(os.path.join(base, str(index))); os.makedirs(native(root))
        summary = make_plan(root, plan, str(index)); captured.clear()
        tables = project_final(root, summary)
        assert len(tables) == 1 and tables[0]["rowCount"] == 1
        key = agent.result_plan_directory_key(plan); keys.append({"plan": plan, "key": key})
        foreign = {**summary, "datasetResultTables": [{**summary["datasetResultTables"][0], "aggregateCsvPath": scope(plan + "x", "datasets/BUS/seed_mean_std.csv")} ]}
        reject(lambda: project_seed(root, foreign))
    out["planKeys"] = keys
elif scenario == "metadata":
    root, one, two = workspace("metadata")
    index_path = scope(plan_a, "dataset-index.json"); original = json.loads(text(root, index_path))
    changes = [{"plan_file": plan_a.lower()}, {"planFile": False}, {"datasetResultTables": {}},
               {"datasetResultTables": [{**original["datasetResultTables"][0], "plan": plan_b}]},
               {"datasetResultTables": [{**original["datasetResultTables"][0], "datasetKey": "bus"}]},
               {"datasetResultTables": [{**original["datasetResultTables"][0], "finalCsvPath": False}]},
               {"planRevision": revision.strip()}]
    for change in changes:
        write(root, index_path, {**original, **change}, replace=True)
        reject(lambda: project_final(root, two))
    write(root, index_path, {"aggregateStatus": "ready", "datasetResultTables": original["datasetResultTables"]}, replace=True)
    write(root, scope(plan_a, "summary.json"), {"aggregateStatus": "ready", "datasetResultTables": original["datasetResultTables"]}, replace=True)
    assert project_final(root, two)[0]["rowCount"] == 1
    assert next(output for output in captured if output[0] == "csv")[3][0][0] == plan_b
elif scenario == "rows":
    root, one, two = workspace("rows")
    path = one["aggregateCsvPath"]; original = text(root, path)
    for replacement in [original.replace(plan_a, plan_b), original.replace("BUS", "PAD"), original.replace("0.7", "0.9"), original.replace("plan_file,", "plan_file,plan_file,")]:
        assert replacement != original
        write(root, path, replacement, replace=True)
        reject(lambda: project_seed(root, two))
    write(root, path, original, replace=True)
    assert project_seed(root, two)[0]["rowCount"] == 2
elif scenario == "archive":
    root, one, _ = workspace("unarchived", two=False, archived=False)
    assert one["aggregateStatus"] == "ready" and one["finalRowCount"] == 0
    assert project_seed(root, one)[0]["rowCount"] == 1 and project_final(root, one) == []
    root, one, _ = workspace("changed-archive", two=False)
    state_path = agent.archive_state_relpath(plan_a); state = json.loads(text(root, state_path))
    for entry in state["entries"].values():
        entry.update(archived=False, excluded=True, status="excluded")
    write(root, state_path, state, replace=True)
    reject(lambda: project_final(root, one))
    assert project_seed(root, one)[0]["rowCount"] == 1
elif scenario == "snapshots":
    root, one, two = workspace("snapshots")
    original_formatter = agent.project_dataset_table_outputs_from_groups
    source = one["rawResultCsvPath"]
    def changed(root, groups, kind, before_publish=None):
        full = os.path.join(native(root), *source.split("/")); old = os.stat(full)
        with open(full, "r+b") as stream:
            data = stream.read(); stream.seek(0); stream.write(data.replace(b"0.6", b"0.9"))
        os.utime(full, ns=(old.st_atime_ns, old.st_mtime_ns))
        return original_formatter(root, groups, kind, before_publish=before_publish)
    with patch.object(agent, "project_dataset_table_outputs_from_groups", changed):
        reject(lambda: project_final(root, two))
    root, one, two = workspace("inventory")
    def added(root, groups, kind, before_publish=None):
        write(root, scope(plan_a, "late.json"), {})
        return original_formatter(root, groups, kind, before_publish=before_publish)
    with patch.object(agent, "project_dataset_table_outputs_from_groups", added):
        reject(lambda: project_seed(root, two))
    root = virtual(os.path.join(base, "producer")); os.makedirs(native(root))
    original_final = agent.write_plan_final_summary
    def producer_changed(root, *args, **kwargs):
        result = original_final(root, *args, **kwargs)
        source = "outputs/producer/ 指标 É.csv "
        full = os.path.join(native(root), *source.split("/"))
        with open(full, "r+b") as stream:
            data = stream.read(); stream.seek(0); stream.write(data.replace(b"0.6", b"0.9"))
        return result
    with patch.object(agent, "write_plan_final_summary", producer_changed):
        reject(lambda: make_plan(root, plan_a, "producer"))
    out.update(changedInputRejected=True, changedInventoryRejected=True, changedProducerInputRejected=True)
elif scenario == "legacy":
    root = virtual(os.path.join(base, "legacy")); os.makedirs(native(root))
    plan = "experiments/plans/demo.yaml"; summary = make_plan(root, plan, "legacy", archived=False, plain_source=True)
    legacy = {key: value for key, value in summary.items() if key != "resultPathIdentity"}
    policy = agent.read_project_metric_policy(root)
    outputs = []; agent._write_dataset_seed_aggregate(root, legacy, policy, "BUS", outputs)
    final = next(output for output in outputs if output[1].endswith("/final.csv"))
    assert len(final[3]) == 1 and abs(final[3][0][final[2].index("accuracy_mean")] - .7) < 1e-12
    for output in outputs:
        write(root, output[1], csv_text(output[2], output[3]) if output[0] == "csv" else output[2], replace=True)
    captured.clear()
    assert project_final(root, legacy)[0]["rowCount"] == 1
    out["legacyEntryPreserved"] = True
elif scenario == "budget":
    root, one, _ = workspace("budget", two=False)
    target = one["aggregateCsvPath"]
    write(root, target, b" " * (5 * 1024 * 1024 + 1), replace=True)
    reject(lambda: project_seed(root, one))
    root, one, _ = workspace("directories", two=False)
    parent = os.path.join(native(root), "simple_cluster", "results", "by_plan")
    for index in range(500):
        os.makedirs(os.path.join(parent, "empty-" + str(index)))
    reject(lambda: project_seed(root, one))
    out["noSilentTruncation"] = True
else:
    raise AssertionError("Unknown scenario")
out.update(passed=True, publicationExecutorsInvoked=False, capturedPublicationsOnly=True)
print(json.dumps(out, ensure_ascii=False))
