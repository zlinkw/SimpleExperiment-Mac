"""Isolated actual Agent parser, retained local inputs and captured publications only."""
import copy
import ast
import csv
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
agent = extract_runtime_functions(runtime, ["parse_results_action", "result_parse_request", "action_receipt_fields",
                                           "read_results_summary", "read_current_results_summary", "result_plan_directory_key", "terminal_action"])
base = os.path.abspath(base)
if os.name == "nt" and not base.startswith("\\\\?\\"):
    base = "\\\\?\\" + base
os.makedirs(base, exist_ok=True)
native, virtual = bind_posix_runtime(agent, base)
events, writes, csv_outputs = [], [], []
agent.agent_dir = lambda root: "/fixture/state/" + root.rsplit("/", 1)[-1]
agent.append_event = lambda root, event: events.append(copy.deepcopy(event))
agent.atomic_write = lambda file, value: writes.append((file, copy.deepcopy(value)))
agent.write_atomic_csv = lambda file, header, rows: csv_outputs.append((file, list(header), copy.deepcopy(rows)))
agent.write_atomic_text = lambda file, text: None
agent.publish_dataset_outputs = lambda root, outputs: csv_outputs.extend(copy.deepcopy(outputs))
agent.apply_final_evidence_summary = lambda root, summary: summary.update(finalResultCount=0, pendingReviewCount=len(summary["results"]))
agent.final_analysis_results = lambda root, summary: []
agent.evaluate_claim_evidence = lambda root, summary: {"status": "needs_experiment", "claims": []}
agent.apply_claim_evidence_summary = lambda summary, report: None
# Project-level table merging and archival evidence are separate boundaries; keep Plan seed/CSV/registry writers real.
agent.write_project_seed_aggregate = lambda root, summary: []
agent.write_project_final_summary = lambda root, summary: []
plan = "experiments/Plans 中文 / 计划 É.yaml "

def save(root, relative, data):
    target = os.path.join(native(root), *relative.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "xb") as stream:
        stream.write(data.encode("utf-8") if isinstance(data, str) else data)
    return target

def workspace(name, text, plan_file=None):
    root = virtual(os.path.join(base, name)); os.makedirs(native(root))
    save(root, plan_file or plan, text)
    return root

def parsed(root, selected=None, plan_file=None):
    result = agent.parse_results_action(root, selected, plan_file or plan, " revision ", {"topologyMode": "single_worker", "resultOwnerWorkerId": "worker"})
    assert result["planFile"] == (plan_file or plan) and result["planRevision"] == " revision "
    assert result["resultPathIdentity"] == "posix-v1"
    key = agent.result_plan_directory_key(plan_file or plan)
    assert result["summaryPath"] == "simple_cluster/results/by_plan/" + key + "/summary.json"
    assert events[-1]["payload"]["planFile"] == (plan_file or plan)
    return result

def reject(callback):
    before = len(events), len(writes), len(csv_outputs)
    try:
        callback()
    except (ValueError, OSError, UnicodeError):
        pass
    else:
        raise AssertionError("Invalid identity accepted")
    assert (len(events), len(writes), len(csv_outputs)) == before

def csv_text(header, rows):
    buffer = io.StringIO(); writer = csv.writer(buffer); writer.writerow(header); writer.writerows(rows); return buffer.getvalue()

out = {"scenario": scenario, "remoteOperations": 0}
if scenario == "receipt":
    # Compile only the exact result branch from the generated handler; no other actions or module entry points.
    tree = ast.parse(pathlib.Path(runtime).read_text(encoding="utf-8"))
    handler = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "handle_action")
    branch = next(node for node in handler.body if isinstance(node, ast.If) and '"parse-results"' in ast.unparse(node.test).replace("'", '"'))
    handler.name = "isolated_parse_branch"; handler.body = [branch]; handler.decorator_list = []
    exec(compile(ast.Module(body=[handler], type_ignores=[]), runtime, "exec"), agent.__dict__)
    receipts = []
    for index, action in enumerate(agent.RESULT_PARSE_ACTIONS):
        source = "outputs/中文/ metric.json "
        root = workspace("receipt-" + str(index), "suite: demo\nresult_json: " + json.dumps(source, ensure_ascii=False) + "\n")
        save(root, source, '{"metrics":{"AUC":0.9}}')
        payload = {"planFile": plan, "options": {"plan_file": plan, "planRevision": " revision ", "remotePath": source}}
        result = agent.isolated_parse_branch(root, action, payload, "operation-" + str(index), "command-" + str(index))
        assert result["status"] == "completed" and result["action"] == action
        assert result["planFile"] == result["selectedPlanId"] == plan and result["planRevision"] == " revision "
        assert result["summaryPath"] == agent.plan_results_summary_relpath(plan, strict_plan=True)
        assert events[-1]["payload"]["planFile"] == plan and events[-1]["payload"]["planRevision"] == " revision "
        receipts.append(result)
    out.update(plan=plan, receipts=receipts)
elif scenario == "request":
    request = {"planFile": plan, "options": {"selectedPlanId": plan, "planRevision": " revision ", "selectedRunKeys": [" run:1 "]},
               "selectedTaskTargets": [{"plan_file": plan, "path": "outputs/中文/metric.json "}]}
    identity, selected = agent.result_parse_request(request)
    assert identity["planFile"] == plan and selected == [{"kind": "path", "value": "outputs/中文/metric.json "}, {"kind": "key", "value": " run:1 "}]
    for action in agent.RESULT_PARSE_ACTIONS:
        assert agent.action_receipt_fields(action, request)["planFile"] == plan
    for bad in [{"planFile": plan, "plan_file": plan.lower()}, {"planFile": 5}, {"planFile": None}, {"options": []},
                {"planFile": plan, "selectedRunKeys": [None]}, {"planFile": plan, "remotePath": "outputs/../foreign.csv"},
                {"planFile": plan, "selectedTaskTargets": [{"planFile": plan.lower(), "path": "outputs/a.csv"}]},
                {"planFile": plan, "selectedTaskTargets": [5]}, {"planFile": plan, "planRevision": "r", "options": {"plan_revision": "R"}}]:
        reject(lambda bad=bad: agent.result_parse_request(bad))
    out.update(plan=plan, identity=identity, selected=selected, io=0)
elif scenario == "paths":
    summaries = []
    for index, suffix in enumerate(["A.yaml", "a.yaml", " É.yaml ", "E\u0301.yaml", "literal%20.yaml", "quote'#, space.yaml "]):
        current = "experiments/Plans 中文 /" + suffix
        source = "outputs/中文/ metric É%20.json "
        root = workspace("paths-" + str(index), "suite: demo\nresult_json: " + json.dumps(source, ensure_ascii=False) + "\n", current)
        save(root, source, '{"metrics":{"AUC":0.91},"case":"same","seed":42,"method":"fixture"}\n')
        summary = parsed(root, plan_file=current)
        assert summary["sources"] == [source] and summary["resultCount"] == 1
        assert summary["results"][0]["sourceFiles"][0]["path"] == source and summary["results"][0]["provenance"]["planFile"] == current
        summaries.append(summary)
    assert len({item["summaryPath"] for item in summaries}) == len(summaries)
    out["summaries"] = summaries
elif scenario == "selection":
    root = workspace("selection", 'suite: demo\nresult_json: outputs/demo/default.json\n')
    source = "outputs/job/ metric '[].json "
    save(root, source, '{"metrics":{"AUC":0.93}}\n'); save(root, "outputs/demo/default.json", '{"metrics":{"AUC":0.94}}\n')
    save(root, "experiments/results/jobs.csv", csv_text(["planFile", "plan_file", "runKey", "result_json"],
         [[plan, plan, " run:1 ", source], [plan.lower(), "", " run:1 ", "outputs/demo/default.json"], ["", "", " run:1 ", "outputs/demo/default.json"]]))
    summaries = [parsed(root, [" run:1 "]), parsed(root, [{"kind": "path", "value": source}]), parsed(root, ["run:1"])]
    assert summaries[0]["sources"] == summaries[1]["sources"] == [source]
    assert summaries[2]["sources"] == [] and summaries[2]["resultCount"] == 0, "missing explicit selection must not broaden to Plan defaults"
    out["summaries"] = summaries
elif scenario == "rows":
    root = workspace("rows", "suite: demo\nresult_csv: outputs/demo/raw.csv \n")
    # YAML plain scalars discard syntactic trailing spaces; quoted declarations preserve real file spaces.
    source = "outputs/demo/raw.csv"
    save(root, source, csv_text(["planFile", "plan_file", "case", "seed", "metric", "value"],
         [[plan, plan, "same", 1, "AUC", .81], [plan.lower(), "", "same", 1, "AUC", .99], [plan, plan.lower(), "same", 1, "AUC", .98], ["", "", "other", 2, "AUC", .82]]))
    summary = parsed(root)
    assert summary["resultCount"] == 2
    assert sorted(next(iter(item["metrics"].values()))["value"] for item in summary["results"]) == [.81, .82]
    assert all(item["planFile"] == item["provenance"]["planFile"] == plan for item in summary["results"])
    out["summaries"] = [summary]
elif scenario == "policy":
    root = workspace("policy", "suite: demo\n")
    source = "outputs/policy/ 原始.json "
    save(root, "experiments/simple_project.yaml", 'outputs:\n  candidateJson: [' + json.dumps(source, ensure_ascii=False) + ']\n')
    save(root, source, json.dumps({"results": [{"planFile": plan, "metrics": {"AUC": .81}}, {"metrics": {"AUC": .99}}, {"suite": "demo", "metrics": {"AUC": .82}}, {"suite": "Demo", "metrics": {"AUC": .98}}]}, ensure_ascii=False))
    summary = parsed(root); assert summary["resultCount"] == 2 and summary["sources"] == [source]
    state = agent.agent_dir(root); save(state, "result_policy.json", json.dumps({"candidateJson": [source]}, ensure_ascii=False))
    second = parsed(root); assert second["resultCount"] == 2
    bad = workspace("bad-policy", "suite: demo\n"); save(agent.agent_dir(bad), "result_policy.json", '{"candidateJson":[5]}')
    reject(lambda: parsed(bad))
    out["summaries"] = [summary, second]
elif scenario == "snapshots":
    root = workspace("snapshots", "suite: demo\nresult_json: outputs/demo/raw.json\n")
    source = "outputs/demo/raw.json"; file = save(root, source, '{"metrics":{"AUC":.9}}'.replace('.9','0.9'))
    original = agent.parse_result_file
    def changed(*args, **kwargs):
        records = original(*args, **kwargs)
        with open(file, "ab") as stream: stream.write(b" ")
        return records
    with patch.object(agent, "parse_result_file", changed):
        reject(lambda: parsed(root))
    out.update(events=len(events), writes=len(writes), changedInputRejected=True)
elif scenario == "aggregate":
    source = "outputs/中文/ metrics.csv "
    root = workspace("aggregate", 'suite: demo\nseeds: [1, 2]\ncases: [{case: same}]\nresult_csv: ' + json.dumps(source, ensure_ascii=False) + '\n')
    save(root, source, "case,seed,method,dataset,accuracy\r\nsame,1,fixture,Chinese,.6\r\nsame,2,fixture,Chinese,.8\r\n")
    summary = parsed(root)
    assert summary["aggregateStatus"] == "ready" and summary["rawResultCsvPath"] == source
    assert summary["columnMappingPreview"]["source"] == source
    assert agent.result_plan_directory_key(plan) in summary["aggregateCsvPath"]
    aggregate = next(item for item in csv_outputs if len(item) == 4 and item[0] == "csv" and item[1] == summary["aggregateCsvPath"])
    assert aggregate[3][0][0] == plan and abs(aggregate[3][0][aggregate[2].index("accuracy_mean")] - .7) < 1e-10
    out["summaries"] = [summary]
elif scenario == "summary":
    root = workspace("summary", "suite: demo\nresult_json: outputs/demo/raw.json\n")
    save(root, "outputs/demo/raw.json", '{"metrics":{"AUC":0.9}}')
    summary = parsed(root); save(root, summary["summaryPath"], json.dumps(summary, ensure_ascii=False))
    assert agent.read_current_results_summary(root, plan, " revision ") == summary
    foreign = workspace("foreign-summary", "suite: demo\n")
    save(foreign, summary["summaryPath"], json.dumps({**summary, "planFile": plan.lower()}, ensure_ascii=False))
    reject(lambda: agent.read_results_summary(foreign, plan))
    legacy = workspace("legacy-summary", "suite: demo\n")
    legacy_summary = {key: value for key, value in summary.items() if key != "resultPathIdentity"}
    old_path = agent.plan_results_summary_relpath(agent.normalize_result_candidate(plan))
    save(legacy, old_path, json.dumps(legacy_summary, ensure_ascii=False))
    assert agent.read_results_summary(legacy, plan) == legacy_summary
    legacy_foreign = workspace("legacy-foreign", "suite: demo\n")
    save(legacy_foreign, old_path, json.dumps({**legacy_summary, "planFile": plan.lower()}, ensure_ascii=False))
    assert agent.read_results_summary(legacy_foreign, plan)["results"] == []
    # Existing default helper and unscoped writer entry points remain available.
    assert agent.plan_summary_slug("experiments/plans/a.yaml") == "experiments_plans_a.yaml"
    out["summaries"] = [summary]
else:
    raise AssertionError("Unknown scenario")
out["passed"] = True
print(json.dumps(out, ensure_ascii=False))
