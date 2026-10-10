"""Actual generated case functions over retained native files; only publishers captured."""
import ast
import copy
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
agent = extract_runtime_functions(runtime, ["parse_case_level_action", "run_leakage_check_action", "run_subgroup_analysis_action", "export_case_analysis_action", "output_contract_request_identity", "action_plan_file"])
base = os.path.abspath(base)
if os.name == "nt" and not base.startswith("\\\\?\\"):
    base = "\\\\?\\" + base
os.makedirs(base, exist_ok=True)
native, virtual = bind_posix_runtime(agent, base)
plan, revision = "experiments/Plans 中文 / 计划 É.yaml ", " revision "
source = "experiments/runs/ 中文 É / metrics_case %20.csv "
writes, csv_outputs = [], []
agent.agent_dir = lambda root: "/fixture/state/" + root.rsplit("/", 1)[-1]
agent.atomic_write = lambda file, value: writes.append((file, copy.deepcopy(value)))

def capture_file(file, writer):
    buffer = io.StringIO(newline="")
    writer(buffer)
    csv_outputs.append((file, buffer.getvalue()))
agent.atomic_write_file = capture_file

def save(root, relative, value, replace=False):
    file = os.path.join(native(root), *relative.split("/"))
    os.makedirs(os.path.dirname(file), exist_ok=True)
    data = value if isinstance(value, bytes) else value.encode("utf-8") if isinstance(value, str) else json.dumps(value, ensure_ascii=False).encode("utf-8")
    with open(file, "wb" if replace else "xb") as stream:
        stream.write(data)
    return file

def csv_text(rows, headers=None):
    buffer = io.StringIO(newline="")
    csv.writer(buffer).writerows([headers or ["plan", "planRevision", "case_id", "patient_id", "split", "sex", "accuracy"], *rows])
    return buffer.getvalue()

def workspace(name, owner=plan, path=source, rows=None, declaration=None):
    root = virtual(os.path.join(base, name)); os.makedirs(native(root))
    save(root, owner, 'suite: demo\nresult_csv: ' + json.dumps(declaration or path, ensure_ascii=False) + '\n')
    if rows is None:
        rows = [[owner, revision, "甲", "病人 1", "train", "F", .6], [owner, revision, "乙", "病人 1", "test", "F", .8]]
    save(root, path, csv_text(rows))
    save(root, "experiments/simple_project.yaml", "primaryMetric: accuracy\n")
    writes.clear(); csv_outputs.clear()
    return root

def reject(callback):
    before = len(writes), len(csv_outputs)
    try:
        callback()
    except (ValueError, OSError, UnicodeError, csv.Error):
        pass
    else:
        raise AssertionError("Invalid case input accepted")
    assert (len(writes), len(csv_outputs)) == before

def subgroup(root, owner=plan):
    exported = agent.export_case_analysis_action(root, owner, revision)
    report = agent.run_subgroup_analysis_action(root, owner, revision)
    assert exported["caseCount"] == report["caseCount"] and exported["rows"] == len(report["rows"])
    assert exported["planFile"] == owner and exported["planRevision"] == revision
    assert exported["path"] == "paper/tables/simple_case_analysis__" + agent.result_plan_directory_key(owner) + ".csv"
    assert exported["sourceFiles"] == report["sourceFiles"]
    matrix = list(csv.reader(io.StringIO(csv_outputs[-2][1], newline="")))
    assert matrix[0] == ["group", "count", "metrics"] and len(matrix) == exported["rows"] + 1
    assert csv_outputs[-2][1] == csv_outputs[-1][1]
    assert csv_outputs[-2][0] == agent.os.path.join(root, exported["path"])
    for row, values in zip(report["rows"], matrix[1:]):
        assert values[:2] == [row["group"], str(row["count"])] and json.loads(values[2]) == row["metrics"]
    return report

out = {"scenario": scenario, "remoteOperations": 0, "archiveMutations": 0}
if scenario == "workflow":
    root = workspace("workflow")
    index = agent.parse_case_level_action(root, plan, revision)
    leak = agent.run_leakage_check_action(root, plan, revision)
    report = subgroup(root)
    assert index["caseCount"] == report["caseCount"] == leak["caseCount"] == 2
    assert leak["status"] == "failed" and leak["issues"][0]["patientId"] == "病人 1"
    assert leak["issues"][0]["splits"] == ["test", "train"]
    assert abs(report["rows"][0]["metrics"]["accuracy"]["mean"] - .7) < 1e-12
    assert report["rows"][0]["metrics"]["accuracy"]["n"] == 2
    for value, filename in [(index, "case_level_index.json"), (leak, "leakage_check.json"), (report, "subgroup_analysis.json")]:
        assert value["planFile"] == plan and value["planRevision"] == revision and value["resultPathIdentity"] == "posix-v1"
        assert value["sourceFiles"] == [source]
        assert value["path"] == agent.plan_results_artifact_relpath(plan, filename, strict_plan=True)
        assert any(saved == value for _, saved in writes)
    out.update(report=report, index=index, leakage=leak)
    group = '女,"中文\nÉ'
    save(root, source, csv_text([[plan, revision, "甲", "p", "test", group, .6], [plan, revision, "乙", "q", "test", group, .8]]), True)
    assert subgroup(root)["rows"][0]["group"] == group
    assert group in list(csv.reader(io.StringIO(csv_outputs[-2][1], newline="")))[1]
elif scenario == "paths":
    plans = [plan, plan.lower(), plan.rstrip(), plan.replace("É", "E\u0301"), plan.replace(" ", "%20"), plan.replace("计划", "'计划'")]
    paths = [source, source.lower(), source.rstrip(), source.replace("É", "E\u0301"), source.replace("中文 É", "%20中文%20É"), source.replace("中文", "'中文'")]
    out["planKeys"] = []
    for index, (owner, path) in enumerate(zip(plans, paths)):
        root = workspace(str(index), owner=owner, path=path)
        report = subgroup(root, owner)
        assert report["planFile"] == owner and report["sourceFiles"] == [path]
        out["planKeys"].append({"plan": owner, "key": agent.result_plan_directory_key(owner)})
    assert len({item["key"] for item in out["planKeys"]}) == len(plans)
elif scenario == "ownership":
    root = workspace("ownership", rows=[["", "", "anonymous", "p", "test", "F", .6], [plan.lower(), revision, "foreign", "p", "train", "F", .9], [plan, revision.strip(), "stale", "p", "train", "F", .9]])
    sibling = source.rsplit("/", 1)[0] + "/prediction.csv"
    save(root, sibling, csv_text([["", "", "unowned", "p", "train", "F", .99], [plan, revision, "owned", "q", "test", "M", .8]]))
    index = agent.parse_case_level_action(root, plan, revision)
    assert {row["caseId"] for row in index["cases"]} == {"anonymous", "owned"}
    job_source = "experiments/runs/job/metrics_case.csv"
    save(root, job_source, csv_text([["", revision, "from-job", "q", "test", "M", .5]]))
    save(root, "experiments/results/jobs.csv", csv_text([[plan, job_source], [plan.lower(), sibling]], ["plan", "result_csv"]))
    assert {row["caseId"] for row in agent.parse_case_level_action(root, plan, revision)["cases"]} == {"anonymous", "owned", "from-job"}
    assert agent.export_case_analysis_action(root, plan, revision)["caseCount"] == 3
    for index, text in enumerate(["plan,plan_file,case_id\n" + csv_text([[plan, plan.lower(), "conflict"]], ["unused"]).split("\n", 1)[1], 'plan,planRevision,plan_revision,case_id\n' + csv_text([[plan, revision, revision.strip(), "conflict"]], ["unused"]).split("\n", 1)[1]]):
        bad = workspace("aliases" + str(index)); save(bad, source, text, True)
        reject(lambda: subgroup(bad))
elif scenario == "fresh":
    root = workspace("fresh")
    save(root, "simple_cluster/results/case_level_index.json", {"planFile": plan.lower(), "cases": [{"patientId": "cached", "split": "train", "metrics": {"accuracy": .99}}]})
    report = subgroup(root)
    assert abs(report["rows"][0]["metrics"]["accuracy"]["mean"] - .7) < 1e-12
    save(root, source, csv_text([[plan, revision, "new", "p", "test", "M", .4]]), True)
    report = subgroup(root)
    assert report["caseCount"] == 1 and report["rows"][0]["metrics"]["accuracy"]["mean"] == .4
    save(root, source, csv_text([[plan.lower(), revision, "foreign", "p", "train", "F", .99]]), True)
    leak = agent.run_leakage_check_action(root, plan, revision)
    assert leak["status"] == "warning" and leak["issues"][0]["type"] == "no_verified_cases"
    assert subgroup(root)["status"] == "empty"
elif scenario == "identity":
    root = workspace("identity")
    for bad in [plan.replace("/", "\\"), "../" + plan, "/" + plan, 1, False]:
        reject(lambda: subgroup(root, bad))
    for bad in [[], 7, "revision\n"]:
        reject(lambda: agent.parse_case_level_action(root, plan, bad))
    glob_root = workspace("glob", declaration=source.rsplit("/", 1)[0] + "/*metrics_case*.csv ")
    report = subgroup(glob_root)
    assert report["caseCount"] == 2, (report, agent.output_contract_plan(glob_root, plan)["candidates"])
elif scenario == "snapshots":
    for index, target in enumerate([source, plan, "experiments/simple_project.yaml", "experiments/results/jobs.csv", source.rsplit("/", 1)[0] + "/prediction_new.csv"]):
        root = workspace(str(index)); original = agent.now_iso
        changed = [False]
        def mutate():
            if not changed[0]:
                changed[0] = True
                file = pathlib.Path(native(agent.os.path.join(root, target)))
                save(root, target, file.read_bytes() + b" " if file.exists() else "plan,path\n", file.exists())
            return original()
        with patch.object(agent, "now_iso", mutate):
            reject(lambda: subgroup(root))
    root = workspace("missing-source", declaration=source.rsplit("/", 1)[0] + "/metrics_case_missing.csv")
    original = agent.now_iso
    def appear():
        missing = source.rsplit("/", 1)[0] + "/metrics_case_missing.csv"
        if not agent.os.path.exists(agent.os.path.join(root, missing)):
            save(root, missing, csv_text([]))
        return original()
    with patch.object(agent, "now_iso", appear):
        reject(lambda: subgroup(root))
    root = workspace("missing-policy"); original = agent.now_iso
    def appear_policy():
        state_root = agent.agent_dir(root)
        if not agent.os.path.exists(agent.os.path.join(state_root, "result_policy.json")):
            save(state_root, "result_policy.json", {})
        return original()
    with patch.object(agent, "now_iso", appear_policy):
        reject(lambda: subgroup(root))
    root = workspace("serialization-change")
    original = agent.json.dumps
    def mutate_while_serializing(*args, **kwargs):
        result = original(*args, **kwargs)
        file = pathlib.Path(native(agent.os.path.join(root, source)))
        with open(file, "ab") as stream:
            stream.write(b"\n")
        return result
    with patch.object(agent.json, "dumps", mutate_while_serializing):
        reject(lambda: agent.export_case_analysis_action(root, plan, revision))
elif scenario == "inputs":
    for index, data in enumerate([b"\xff", b"case_id,case_id\na,b\n", b"case_id,accuracy\na\n", b'case_id,accuracy\n"unterminated', b"x" * (5 * 1024 * 1024 + 1), b"case_id,accuracy\n" + b"a,1\n" * 50001]):
        root = workspace(str(index)); save(root, source, data, True)
        reject(lambda: subgroup(root))
    root = workspace("config"); save(root, "experiments/simple_project.yaml", b"\xff", True)
    reject(lambda: subgroup(root))
    for index, target in enumerate(["paper/tables/simple_case_analysis.csv", "paper/tables/simple_case_analysis__" + agent.result_plan_directory_key(plan) + ".csv", agent.plan_results_artifact_relpath(plan, "subgroup_analysis.json", strict_plan=True)]):
        root = workspace("bad-target" + str(index))
        os.makedirs(native(agent.os.path.join(root, target)))
        reject(lambda: agent.export_case_analysis_action(root, plan, revision))
    root = workspace("many")
    parent = source.rsplit("/", 1)[0]
    for index in range(241):
        save(root, parent + "/prediction_" + str(index) + ".csv", csv_text([]))
    reject(lambda: subgroup(root))
    root = workspace("not-file", path="experiments/runs/metrics_case.csv")
    other = "experiments/runs/prediction_directory.csv"
    os.makedirs(native(agent.os.path.join(root, other)))
    save(root, plan, 'suite: demo\nresult_csv: ' + json.dumps(other) + '\n', True)
    reject(lambda: subgroup(root))
elif scenario == "legacy":
    root = virtual(os.path.join(base, "legacy")); os.makedirs(native(root))
    save(root, "simple_cluster/results/case_level_index.json", {"cases": [{"caseId": "old", "patientId": "p", "split": "test", "metrics": {"accuracy": .75}, "subgroup": {"sex": "F"}}]})
    report = agent.run_subgroup_analysis_action(root)
    assert report["rows"][0]["metrics"]["accuracy"]["mean"] == .75 and report.get("resultPathIdentity") is None
    assert agent.run_leakage_check_action(root)["status"] == "ok"
    original_open, text_outputs = agent.open, {}
    class LegacyBuffer(io.StringIO):
        def __init__(self, file):
            super().__init__(newline=""); self.file = file
        def close(self):
            if not self.closed:
                text_outputs[self.file] = self.getvalue()
            super().close()
    def legacy_open(file, mode="r", *args, **kwargs):
        if "w" in mode:
            return LegacyBuffer(file)
        return io.StringIO(text_outputs[file]) if file in text_outputs else original_open(file, mode, *args, **kwargs)
    with patch.object(agent, "open", legacy_open):
        exported = agent.export_case_analysis_action(root)
    assert exported["path"] == "paper/tables/simple_case_analysis.csv" and exported["rows"] == 1
    assert exported.get("resultPathIdentity") is None
    matrix = list(csv.reader(io.StringIO(next(iter(text_outputs.values())))))
    assert matrix[0] == ["group", "count", "metrics"] and json.loads(matrix[1][2])["accuracy"]["mean"] == .75
else:
    raise AssertionError("Unknown scenario")

# Compile only the four actual routing branches, not handle_action or module entry points.
if scenario == "workflow":
    tree = ast.parse(pathlib.Path(runtime).read_text(encoding="utf-8"))
    actions = {"parse-case-level", "run-leakage-check", "run-subgroup-analysis", "export-case-analysis"}
    branches = [node for node in ast.walk(tree) if isinstance(node, ast.If) and isinstance(node.test, ast.Compare) and isinstance(node.test.left, ast.Name) and node.test.left.id == "action" and any(isinstance(value, ast.Constant) and value.value in actions for value in node.test.comparators)]
    assert len(branches) == 4
    wrapper = ast.FunctionDef(name="isolated_case_route", args=ast.arguments(posonlyargs=[], args=[ast.arg(arg=name) for name in ["root", "action", "payload", "operation_id", "op_id"]], kwonlyargs=[], kw_defaults=[], defaults=[]), body=branches, decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[wrapper], type_ignores=[])), runtime, "exec"), agent.__dict__)
    agent.terminal_action = lambda root, action, operation_id, op_id, status, message, payload, request=None: {"action": action, "status": status, "payload": payload, "planFile": request["options"]["planFile"], "planRevision": request["options"]["planRevision"]}
    out["receipts"] = [agent.isolated_case_route(root, action, {"options": {"planFile": plan, "planRevision": revision}}, "fixture", "fixture") for action in sorted(actions)]
    for action in actions:
        reject(lambda: agent.isolated_case_route(root, action, {"planFile": plan.lower(), "options": {"planFile": plan, "planRevision": revision}}, "fixture", "fixture"))
out.update(passed=True, capturedPublicationsOnly=True, publicationExecutorsInvoked=False, actualCaseExportChecked=True)
print(json.dumps(out, ensure_ascii=False))
