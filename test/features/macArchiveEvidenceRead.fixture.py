"""Actual generated read/annotation/parse functions; no archive or deletion executors."""
import copy
import io
import json
import os
import pathlib
import sys
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
from posixRuntimeFixture import bind_posix_runtime

scenario, runtime, base = sys.argv[1:4]
agent = extract_runtime_functions(runtime, ["read_plan_archive_evidence", "annotate_final_evidence", "apply_final_evidence_summary",
                                           "final_analysis_results", "parse_results_action", "result_parse_row_identity", "read_current_results_summary"])
base = os.path.abspath(base)
if os.name == "nt" and not base.startswith("\\\\?\\"):
    base = "\\\\?\\" + base
os.makedirs(base, exist_ok=True)
native, virtual = bind_posix_runtime(agent, base)
plan, revision = "experiments/Plans 中文 / 计划 É.yaml ", " revision "
writes, events, csv_outputs = [], [], []
agent.agent_dir = lambda root: "/fixture/state/" + root.rsplit("/", 1)[-1]
agent.atomic_write = lambda file, value: writes.append((file, copy.deepcopy(value)))
agent.append_event = lambda root, event: events.append(copy.deepcopy(event))
agent.write_atomic_csv = lambda file, headers, rows: csv_outputs.append((file, list(headers), copy.deepcopy(rows)))
agent.write_atomic_text = lambda file, value: None
agent.publish_dataset_outputs = lambda root, outputs: csv_outputs.extend(copy.deepcopy(outputs))
agent.write_project_seed_aggregate = lambda root, summary: []
agent.write_project_final_summary = lambda root, summary: []
agent.evaluate_claim_evidence = lambda root, summary: {"status": "needs_experiment", "claims": []}
agent.apply_claim_evidence_summary = lambda summary, report: None

def save(root, relative, value):
    target = os.path.join(native(root), *relative.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    data = value if isinstance(value, bytes) else value.encode("utf-8") if isinstance(value, str) else json.dumps(value, ensure_ascii=False).encode("utf-8")
    with open(target, "xb") as stream:
        stream.write(data)
    return target

def workspace(name):
    root = virtual(os.path.join(base, name))
    os.makedirs(native(root))
    return root

def scoped_path(value=plan):
    return "simple_cluster/archive_state/by_plan/" + agent.result_plan_directory_key(value) + ".json"

def entry(key, value=plan, rev=revision, **extra):
    return {"path": key, "planFile": value, "planRevision": rev, "archived": True, "status": "archived", **extra}

def state(entries, value=plan, rev=revision):
    return {"planFile": value, "planRevision": rev, "entries": entries}

def record(key, value=plan, **extra):
    return {"planFile": value, "provenance": {"planFile": value, "artifactKey": key}, "sourceFiles": [{"path": key}], **extra}

def reject(callback):
    count = len(writes), len(events), len(csv_outputs)
    try:
        callback()
    except (ValueError, OSError, UnicodeError):
        pass
    else:
        raise AssertionError("Invalid archive evidence accepted")
    assert (len(writes), len(events), len(csv_outputs)) == count

out = {"scenario": scenario, "remoteOperations": 0}
if scenario == "plans":
    plans = [plan, plan.lower(), plan.rstrip(), plan.replace("É", "E\u0301"), plan.replace(" ", "%20"), plan.replace("计划", "'计划'")]
    for index, selected in enumerate(plans):
        root = workspace(str(index)); key = "outputs/ 原始 É.csv "
        save(root, scoped_path(selected), state({key: entry(key, selected)}, selected))
        assert list(agent.read_plan_archive_evidence(root, selected, revision)) == [key]
        for other in plans:
            if other != selected:
                assert agent.read_plan_archive_evidence(root, other, revision) == {}
    out["planKeys"] = [{"plan": value, "key": agent.result_plan_directory_key(value)} for value in plans]
elif scenario == "legacy":
    key = "outputs/demo/raw.csv"
    root = workspace("same"); save(root, agent.archive_state_relpath(plan), state({key: entry(key)}))
    assert list(agent.read_plan_archive_evidence(root, plan, revision)) == [key]
    alias = workspace("normalized"); normalized = agent.normalize_result_candidate(plan)
    save(alias, agent.archive_state_relpath(plan), state({key: entry(key, normalized)}, normalized))
    assert agent.read_plan_archive_evidence(alias, plan, revision) == {}
    anonymous = workspace("anonymous"); save(anonymous, "simple_cluster/archive_state.json", {"entries": {key: {"archived": True}}})
    assert agent.read_plan_archive_evidence(anonymous, plan, revision) == {}
    explicit = workspace("explicit-global"); save(explicit, "simple_cluster/archive_state.json", {"entries": {key: entry(key)}})
    assert list(agent.read_plan_archive_evidence(explicit, plan, revision)) == [key]
    empty = workspace("empty"); save(empty, scoped_path(), state({})); save(empty, "simple_cluster/archive_state.json", state({key: entry(key)}))
    assert agent.read_plan_archive_evidence(empty, plan, revision) == {}
elif scenario == "revision":
    root = workspace("revision")
    for invalid in ("", None, False, "../plan.yaml", "C:/plan.yaml"):
        reject(lambda: agent.read_plan_archive_evidence(root, invalid, revision))
    entries = {key: entry(key, rev=rev) for key, rev in [("exact", revision), ("trimmed", revision.strip()), ("missing", ""), ("other", "different")]}
    save(root, scoped_path(), state(entries))
    assert list(agent.read_plan_archive_evidence(root, plan, revision)) == ["exact"]
    assert len(agent.read_plan_archive_evidence(root, plan)) == 4
    wrong = workspace("wrong-parent"); save(wrong, scoped_path(), state({"exact": entry("exact")}, rev=revision.strip()))
    assert agent.read_plan_archive_evidence(wrong, plan, revision) == {}
    for index, changes in enumerate([{"plan_revision": revision.strip()}, {"planRevision": False}, {"plan": plan.lower()}, {"planFile": 1}, {"provenance": []}]):
        bad = workspace("bad" + str(index)); save(bad, scoped_path(), state({"exact": entry("exact", **changes)}))
        reject(lambda: agent.read_plan_archive_evidence(bad, plan, revision))
elif scenario == "keys":
    keys = ["outputs/É.csv ", "outputs/E\u0301.csv ", "outputs/é.csv ", "outputs/É.csv", "outputs/%20.csv", "run:1"]
    root = workspace("keys"); save(root, scoped_path(), state({key: entry(key) for key in keys}))
    records = [record(key) for key in keys]
    annotated = agent.annotate_final_evidence(root, records, plan, revision, strict_plan=True)
    assert [item["matchedArchiveKeys"] for item in annotated] == [[key] for key in keys]
    for index, key in enumerate(["/outputs/x", "outputs//x", "outputs/../x", "outputs\\x", "C:/x", "outputs/x/", "bad\nkey"]):
        bad = workspace("bad" + str(index)); save(bad, scoped_path(), state({key: entry(key)}))
        reject(lambda: agent.read_plan_archive_evidence(bad, plan, revision))
    bad = workspace("mismatch"); save(bad, scoped_path(), state({"outputs/a": entry("outputs/A")}))
    reject(lambda: agent.read_plan_archive_evidence(bad, plan, revision))
elif scenario == "decisions":
    root = workspace("decisions")
    save(root, scoped_path(), state({"outputs/A ": entry("outputs/A "), "outputs/excluded": entry("outputs/excluded", archived=False, status="excluded", excluded=True)}))
    rows = [record("outputs/A /raw.csv"), record("outputs/A/raw.csv"), record("outputs/A x/raw.csv"), record("outputs/excluded/raw.csv"), record("outputs/A /raw.csv", plan.lower()), record("outputs/A /raw.csv", plan_revision=revision.strip()), record("outputs/A /raw.csv", sourceFiles=[{"path": False}])]
    summary = {"planFile": plan, "planRevision": revision, "resultPathIdentity": "posix-v1", "results": rows}
    agent.apply_final_evidence_summary(root, summary)
    assert [item["finalEvidenceState"] for item in summary["results"]] == ["archived", "pending_review", "pending_review", "excluded", "pending_review", "pending_review", "pending_review"]
    assert (summary["finalResultCount"], summary["excludedResultCount"], summary["pendingReviewCount"]) == (1, 1, 5)
    for index, values in enumerate([{"archived": "false"}, {"archived": True, "excluded": True}, {"state": "excluded"}]):
        bad = workspace("flags" + str(index)); save(bad, scoped_path(), state({"key": entry("key", **values)}))
        reject(lambda: agent.read_plan_archive_evidence(bad, plan, revision))
elif scenario == "cache":
    root = workspace("cache"); key = "outputs/raw.csv"
    cached = record(key, finalEvidenceState="archived", eligibleForFinalAnalysis=True)
    strict = {"planFile": plan, "planRevision": revision, "resultPathIdentity": "posix-v1", "results": [cached]}
    assert agent.final_analysis_results(root, strict) == []
    legacy = {**strict}; legacy.pop("resultPathIdentity")
    assert agent.final_analysis_results(root, legacy) == [cached]
    save(root, scoped_path(), state({key: entry(key)}))
    assert len(agent.final_analysis_results(root, strict)) == 1
    old = workspace("old-scoped-cache")
    save(old, plan, 'suite: demo\nresult_csv: ' + key + '\n')
    save(old, key, "case,seed,accuracy\nsame,1,.8\n")
    save(old, agent.plan_results_summary_relpath(plan), legacy)
    assert agent.read_results_summary(old, plan) == legacy
    refreshed = agent.read_current_results_summary(old, plan, revision)
    assert refreshed["resultPathIdentity"] == "posix-v1" and refreshed["finalResultCount"] == 0
    for row in [{"plan": plan}, {"provenance": {"plan": plan}}]:
        assert agent.result_parse_row_identity(row) == plan
    for row in [{"plan": plan.lower(), "planFile": plan}, {"plan": False}, {"plan": plan, "provenance": {"plan": plan.lower()}}]:
        reject(lambda: agent.result_parse_row_identity(row))
elif scenario == "snapshots":
    root = workspace("changed"); key = "outputs/raw.csv"; file = save(root, scoped_path(), state({key: entry(key)}))
    original = agent.json.loads
    def changed(text, *args, **kwargs):
        decoded = original(text, *args, **kwargs)
        with open(file, "r+b") as stream:
            data = stream.read(); stream.seek(0); stream.write(data.replace(b'"archived": true', b'"archived": null'))
        return decoded
    with patch.object(agent.json, "loads", changed):
        reject(lambda: agent.read_plan_archive_evidence(root, plan, revision))
    for index, data in enumerate([b"\xff", b"[]", b'{"entries": []}', b"{" + b" " * (5 * 1024 * 1024)]):
        bad = workspace("bad" + str(index)); save(bad, scoped_path(), data)
        reject(lambda: agent.read_plan_archive_evidence(bad, plan, revision))
    out.update(events=len(events), writes=len(writes), changedEvidenceRejected=True)
elif scenario == "parser":
    root = workspace("parser"); source = "outputs/中文/ metrics.csv "
    save(root, plan, 'suite: demo\nseeds: [1, 2]\ncases: [{case: same}]\nresult_csv: ' + json.dumps(source, ensure_ascii=False) + '\n')
    save(root, source, "plan,case,seed,method,dataset,accuracy\r\n" + plan + ",same,1,fixture,Chinese,.6\r\n" + plan + ",same,2,fixture,Chinese,.8\r\n" + plan.lower() + ",same,1,fixture,Chinese,.99\r\n")
    save(root, agent.archive_state_relpath(plan), state({source: entry(source)}))
    summary = agent.parse_results_action(root, None, plan, revision, {"topologyMode": "single_worker", "resultOwnerWorkerId": "fixture-worker"})
    assert summary["resultCount"] == summary["finalResultCount"] == 2 and summary["aggregateStatus"] == "ready"
    assert all(row["planFile"] == plan and row["matchedArchiveKeys"] == [source] and row["finalEvidenceState"] == "archived" for row in summary["results"])
    assert summary["rawResultCsvPath"] == source and agent.result_plan_directory_key(plan) in summary["aggregateCsvPath"]
    assert events[-1]["payload"]["planFile"] == plan and events[-1]["payload"]["planRevision"] == revision
    out["summary"] = summary
else:
    raise AssertionError("Unknown scenario")
out.update(passed=True, archiveMutations=0, capturedWrites=len(writes))
print(json.dumps(out, ensure_ascii=False))
