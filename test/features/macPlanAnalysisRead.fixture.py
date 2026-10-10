"""Actual generated claim/input/parse functions; publishers captured, no remote operations."""
import copy
import csv
import io
import json
import os
import pathlib
import sys
from unittest.mock import patch
from urllib.parse import quote
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
from posixRuntimeFixture import bind_posix_runtime

scenario, runtime, base = sys.argv[1:4]
agent = extract_runtime_functions(runtime, ["run_quality_gate_action", "compute_statistics_action", "export_paper_table_action", "parse_results_action"])
base = os.path.abspath(base)
if os.name == "nt" and not base.startswith("\\\\?\\"):
    base = "\\\\?\\" + base
os.makedirs(base, exist_ok=True)
native, virtual = bind_posix_runtime(agent, base)
plan, revision = "experiments/Plans 中文 / 计划 É.yaml ", " revision "
source = "experiments/runs/ 中文 É / 指标 %20.csv "
writes, outputs, events = [], [], []
agent.agent_dir = lambda root: "/fixture/state/" + root.rsplit("/", 1)[-1]
agent.atomic_write = lambda file, value: writes.append((file, copy.deepcopy(value)))
agent.append_event = lambda root, event: events.append(copy.deepcopy(event))
agent.publish_dataset_outputs = lambda root, values: outputs.extend(copy.deepcopy(values))
agent.write_atomic_csv = lambda *args: None
agent.write_atomic_text = lambda *args: None
agent.write_project_seed_aggregate = lambda *args: []
agent.write_project_final_summary = lambda *args: []
actual_evaluate = agent.evaluate_claim_evidence

def save(root, relative, value, replace=False):
    file = os.path.join(native(root), *relative.split("/"))
    os.makedirs(os.path.dirname(file), exist_ok=True)
    data = value if isinstance(value, bytes) else value.encode("utf-8") if isinstance(value, str) else json.dumps(value, ensure_ascii=False).encode("utf-8")
    with open(file, "wb" if replace else "xb") as stream:
        stream.write(data)
    return file

def archive(root, path=source, owner=plan, rev=revision, archived=True):
    relative = "simple_cluster/archive_state/by_plan/" + agent.result_plan_directory_key(plan) + ".json"
    return save(root, relative, {"planFile": owner, "planRevision": rev, "entries": {path: {"path": path, "planFile": owner, "planRevision": rev, "status": "archived" if archived else "excluded"}}}, replace=agent.os.path.exists(agent.os.path.join(root, relative)))

def workspace(name, path=source, owner=plan, archived=True):
    root = virtual(os.path.join(base, name)); os.makedirs(native(root))
    save(root, owner, 'suite: demo\nseeds: [1, 2]\ncases: [{case: same}]\nresult_csv: ' + json.dumps(path, ensure_ascii=False) + '\n')
    buffer = io.StringIO(newline="")
    csv.writer(buffer).writerows([["plan", "experiment_id", "run_key", "case", "seed", "dataset", "accuracy"],
                                [owner, "Case-A", "Run-A", "same", 1, "BUS", .6], [owner, "Case-A", "Run-A", "same", 2, "BUS", .8]])
    save(root, path, buffer.getvalue())
    if archived:
        relative = "simple_cluster/archive_state/by_plan/" + agent.result_plan_directory_key(owner) + ".json"
        save(root, relative, {"planFile": owner, "planRevision": revision, "entries": {path: {"path": path, "planFile": owner, "planRevision": revision, "archived": True}}})
    with patch.object(agent, "evaluate_claim_evidence", lambda *args: {"status": "needs experiment", "claims": []}):
        summary = agent.parse_results_action(root, None, owner, revision, {"topologyMode": "single_worker", "resultOwnerWorkerId": "fixture-worker"})
    scoped = agent.plan_results_summary_relpath(owner, strict_plan=True)
    value = next(value for file, value in reversed(writes) if file == agent.os.path.join(root, scoped))
    save(root, scoped, value)
    save(root, "experiments/simple_project.yaml", "taskType: classification\nprimaryMetric: accuracy\nsecondaryMetrics: [AUC]\n")
    writes.clear(); outputs.clear(); events.clear()
    return root, summary

def claims(root, text, replace=False):
    return save(root, "paper/claims.md", text, replace)

def reject(callback):
    before = len(writes), len(outputs), len(events)
    try:
        callback()
    except (ValueError, OSError, UnicodeError):
        pass
    else:
        raise AssertionError("Invalid analysis input accepted")
    assert (len(writes), len(outputs), len(events)) == before

def evaluate(root, summary, text):
    claims(root, text, replace=agent.os.path.exists(agent.os.path.join(root, "paper/claims.md")))
    return actual_evaluate(root, summary)


def summary_file(root):
    return agent.plan_results_summary_relpath(plan, strict_plan=True)

def reports(root):
    quality = agent.run_quality_gate_action(root, plan, revision)
    stats = agent.compute_statistics_action(root, plan, revision)
    paper = agent.export_paper_table_action(root, plan, revision)
    return quality, stats, paper

def latest_summary():
    return next(value for _, value in reversed(writes) if value.get("summaryPath"))

out = {"scenario": scenario, "remoteOperations": 0, "archiveMutations": 0}
if scenario == "workflow":
    root, summary = workspace("workflow")
    claims(root, "fixture needs experiment")
    quality, stats, paper = reports(root)
    assert quality["status"] == "passed" and quality["primaryMetric"] == "accuracy"
    assert stats["resultCount"] == quality["resultCount"] == paper["resultCount"] == 2
    metric = stats["rows"][0]["metrics"]["accuracy"]
    assert metric["n"] == 2 and abs(metric["mean"] - .7) < 1e-12 and abs(metric["std"] - .14142135623730953) < 1e-12
    assert all(r["planFile"] == plan and r["planRevision"] == revision and r["resultPathIdentity"] == "posix-v1" for r in [quality, stats])
    assert stats["path"] == agent.plan_results_artifact_relpath(plan, "statistics.json", strict_plan=True)
    table = paper["paperDatasetTables"][0]
    assert agent.result_plan_directory_key(plan) in table["paperTablePath"]
    assert any(agent.result_plan_directory_key(plan) in relative and "0.7" in text for _, relative, text in outputs)
    out.update(summary=latest_summary(), report=stats)
elif scenario == "paths":
    plans = [plan, plan.lower(), plan.rstrip(), plan.replace("É", "E\u0301"), plan.replace(" ", "%20"), plan.replace("计划", "'计划'")]
    out["planKeys"] = []
    for index, owner in enumerate(plans):
        root, summary = workspace(str(index), owner=owner)
        stats = agent.compute_statistics_action(root, owner, revision)
        assert stats["planFile"] == owner and stats["path"] == agent.plan_results_artifact_relpath(owner, "statistics.json", strict_plan=True)
        table, files = agent.paper_dataset_output(root, stats, {"metricPriority": ["accuracy"]}, "BUS", owner)
        assert agent.result_plan_directory_key(owner) in table["paperTablePath"]
        out["planKeys"].append({"plan": owner, "key": agent.result_plan_directory_key(owner)})
    assert len({item["key"] for item in out["planKeys"]}) == len(plans)
elif scenario == "fresh":
    root, summary = workspace("fresh")
    cached = copy.deepcopy(summary)
    for record in cached["results"]:
        record["metrics"]["accuracy"]["value"] = .99
    save(root, summary_file(root), cached, True)
    stats = agent.compute_statistics_action(root, plan, revision)
    assert abs(stats["rows"][0]["metrics"]["accuracy"]["mean"] - .7) < 1e-12
    data = pathlib.Path(native(agent.os.path.join(root, source))).read_text(encoding="utf-8")
    save(root, source, data.replace("0.6", "0.4").replace("0.8", "0.6"), True)
    stats = agent.compute_statistics_action(root, plan, revision)
    assert abs(stats["rows"][0]["metrics"]["accuracy"]["mean"] - .5) < 1e-12
    save(root, source, data.replace("Run-A", "Run-B"), True)
    reject(lambda: agent.compute_statistics_action(root, plan, revision))
    reject(lambda: agent.run_quality_gate_action(root, plan, revision))
    reject(lambda: agent.export_paper_table_action(root, plan, revision))
    buffer = io.StringIO(newline="")
    csv.writer(buffer).writerow([plan, "Case-A", "Run-A", "same", 3, "BUS", .9])
    save(root, source, data + buffer.getvalue(), True)
    reject(lambda: agent.compute_statistics_action(root, plan, revision))
elif scenario == "archive":
    for index, state in enumerate(["excluded", "foreign", "revision"]):
        root, summary = workspace(state)
        archive(root, archived=state != "excluded", owner=plan.lower() if state == "foreign" else plan, rev=revision.strip() if state == "revision" else revision)
        quality = agent.run_quality_gate_action(root, plan, revision)
        assert quality["status"] == "failed" and quality["resultCount"] == 0
        assert quality["parsedResultCount"] == 2
        reject(lambda: agent.compute_statistics_action(root, plan, revision))
        reject(lambda: agent.export_paper_table_action(root, plan, revision))
elif scenario == "identity":
    for index, change in enumerate([{ "plan_file": plan.lower()}, {"planRevision": []}, {"plan_revision": revision.strip()}]):
        root, summary = workspace(str(index)); summary.update(change)
        save(root, summary_file(root), summary, True)
        reject(lambda: agent.compute_statistics_action(root, plan, revision))
    root, summary = workspace("invalid-plan")
    for invalid in [plan.replace("/", "\\"), "../" + plan, "/" + plan, 1]:
        reject(lambda: agent.run_quality_gate_action(root, invalid, revision))
    stats = agent.compute_statistics_action(root, plan, revision)
    reject(lambda: agent.paper_dataset_output(root, stats, {}, "BUS", plan.strip()))
elif scenario == "snapshots":
    for index, target in enumerate([source, plan, summary_file(""), "experiments/simple_project.yaml", "experiments/results/jobs.csv", "simple_cluster/archive_state/by_plan/" + agent.result_plan_directory_key(plan) + ".json"]):
        root, summary = workspace(str(index))
        original = agent.now_iso
        def mutate():
            if target == "experiments/results/jobs.csv":
                save(root, target, "plan,path\n")
            else:
                file = pathlib.Path(native(agent.os.path.join(root, target)))
                save(root, target, file.read_bytes() + b" ", True)
            return original()
        with patch.object(agent, "now_iso", mutate):
            reject(lambda: agent.run_quality_gate_action(root, plan, revision))
    root, summary = workspace("paper-change")
    original = agent.paper_dataset_output
    def mutate_output(*args):
        result = original(*args)
        file = pathlib.Path(native(agent.os.path.join(root, source)))
        save(root, source, file.read_bytes() + b"\n", True)
        return result
    with patch.object(agent, "paper_dataset_output", mutate_output):
        reject(lambda: agent.export_paper_table_action(root, plan, revision))
elif scenario == "inputs":
    for index, target in enumerate([source, "experiments/simple_project.yaml", summary_file(""), plan]):
        root, summary = workspace(str(index)); save(root, target, b"\xff", True)
        reject(lambda: agent.compute_statistics_action(root, plan, revision))
    root, summary = workspace("large"); save(root, source, b"x" * (5 * 1024 * 1024 + 1), True)
    reject(lambda: agent.compute_statistics_action(root, plan, revision))
    root, summary = workspace("claims-invalid"); claims(root, b"\xff")
    reject(lambda: agent.export_paper_table_action(root, plan, revision))
elif scenario == "legacy":
    root = virtual(os.path.join(base, "legacy")); os.makedirs(native(root))
    summary = {"results": [{"resultId": "legacy", "runKey": "Legacy", "suite": "demo", "dimensions": {"method": "Legacy", "dataset": "BUS"}, "metrics": {"accuracy": {"value": .75}}, "finalEvidenceState": "archived", "eligibleForFinalAnalysis": True}], "planFile": "legacy.yaml"}
    save(root, "simple_cluster/results/summary.json", summary)
    save(root, "experiments/simple_project.yaml", "primaryMetric: accuracy\n")
    save(root, agent.archive_state_relpath("legacy.yaml"), {"entries": {"legacy": {"archived": True}}})
    # Actual unmarked reader/statistics entry retains its original archive format.
    stats = agent.compute_statistics_action(root)
    assert stats["resultCount"] == 1 and stats["rows"][0]["metrics"]["accuracy"]["mean"] == .75
    assert stats.get("resultPathIdentity") is None
else:
    raise AssertionError("Unknown scenario")
out.update(passed=True, capturedPublicationsOnly=True, publicationExecutorsInvoked=False)
print(json.dumps(out, ensure_ascii=False))
