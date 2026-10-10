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
agent = extract_runtime_functions(runtime, ["evaluate_claim_evidence", "parse_results_action", "apply_claim_evidence_summary"])
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
        raise AssertionError("Invalid claim input accepted")
    assert (len(writes), len(outputs), len(events)) == before

def evaluate(root, summary, text):
    claims(root, text, replace=agent.os.path.exists(agent.os.path.join(root, "paper/claims.md")))
    return actual_evaluate(root, summary)

out = {"scenario": scenario, "remoteOperations": 0, "archiveMutations": 0}
if scenario == "workflow":
    root, summary = workspace("workflow")
    text = "# claim fixtures\n" + "\n".join([
        "- 关联本地 fixture 原始证据 `" + source + "`",
        "- 关联 Markdown fixture [来源](" + quote(source, safe="/") + '#row "fixture title")',
        "- 关联目录 fixture `experiments/runs/ 中文 É `",
        "- 关联编号 fixture evidence Run-A",
        "- 关联编号 fixture result id " + summary["results"][0]["resultId"],
        "- 待实验 fixture needs experiment `" + source + "`",
        "- 未支持 fixture unsupported `" + source + "`",
        "```text\nignored code `" + source + "`\n```"])
    report = evaluate(root, summary, text)
    assert (report["claimCount"], report["supportedCount"], report["needsExperimentCount"], report["unsupportedCount"]) == (7, 5, 1, 1)
    assert report["claims"][0]["evidenceRefs"] == report["claims"][1]["evidenceRefs"] == [source]
    assert report["evidenceSources"] == [source]
    assert report["planFile"] == plan and report["planRevision"] == revision
    assert report["path"] == agent.plan_results_artifact_relpath(plan, "claim_evidence.json", strict_plan=True)
    assert len(writes) == 2 and all(value["planFile"] == plan for _, value in writes)
    agent.apply_claim_evidence_summary(summary, report); out.update(summary=summary, report=report)
    plain, plain_summary = workspace("results-csv", "experiments/results.csv")
    assert evaluate(plain, plain_summary, "关联 fixture `experiments/results.csv`")["supportedCount"] == 1
elif scenario == "paths":
    variants = [source, source.lower(), source.rstrip(), source.replace("É", "E\u0301"), source.replace("%20", "%2520"), source.replace("指标", "'指标'")]
    plans = [plan, plan.lower(), plan.rstrip(), plan.replace("É", "E\u0301"), plan.replace(" ", "%20"), plan.replace("计划", "'计划'")]
    for index, path in enumerate(variants):
        root, summary = workspace(str(index), path, plans[index])
        report = evaluate(root, summary, "关联 fixture `" + path + "`\n关联 fixture [来源](" + quote(path, safe="/") + ")")
        assert report["supportedCount"] == 2 and report["evidenceSources"] == [path]
        for other in variants:
            if other != path:
                assert evaluate(root, summary, "关联 fixture `" + other + "`")["supportedCount"] == 0
    out["planKeys"] = [{"plan": value, "key": agent.result_plan_directory_key(value)} for value in plans]
elif scenario == "references":
    root, summary = workspace("references")
    report = evaluate(root, summary, "\n".join(["错误 fixture `" + source.lower() + "`", "错误 fixture evidence run-a", "错误 fixture evidence " + source.rsplit("/", 1)[-1],
        "错误 fixture `paper/claims.md`", "错误 fixture `experiments/runs/Other/ 指标 %20.csv `", "错误 fixture experiments/runs2/raw.csv",
        "错误 fixture [引用](experiments/runs/%E4%B8%AD%E6%96%87%20%C3%89%20/%20%E6%8C%87%E6%A0%87%20%20.csv%20)"]))
    assert report["claimCount"] == 7 and report["supportedCount"] == 0
    for ref in ["experiments/runs/../raw.csv", "experiments/runs\\raw.csv", "/experiments/runs/raw.csv"]:
        claims(root, "错误 fixture `" + ref + "`", True); reject(lambda: actual_evaluate(root, summary))
    for ref in ["experiments/runs/%2E%2E/raw.csv", "experiments/runs/%FF.csv", "experiments/runs/%GG.csv"]:
        claims(root, "错误 fixture [引用](" + ref + ")", True); reject(lambda: actual_evaluate(root, summary))
    report = evaluate(root, summary, "正确 fixture evidence Run-A\n错误 fixture evidence Run-AA")
    assert [row["status"] for row in report["claims"]] == ["supported", "unsupported"]
elif scenario == "archive":
    root, summary = workspace("archive")
    summary["results"][0].update(experimentId="Forged-ID", runKey="Forged-ID", eligibleForFinalAnalysis=True)
    assert evaluate(root, summary, "伪造 fixture evidence Forged-ID")["supportedCount"] == 0
    assert evaluate(root, summary, "真实 fixture evidence Run-A")["supportedCount"] == 1
    for owner, rev, archived in [(plan.lower(), revision, True), (plan, revision.strip(), True), (plan, revision, False)]:
        archive(root, owner=owner, rev=rev, archived=archived)
        assert evaluate(root, summary, "错误 fixture `" + source + "`")["supportedCount"] == 0
    archive(root)
    file = os.path.join(native(root), *source.split("/"))
    with open(file, "rb") as stream: data = stream.read()
    save(root, source, data.replace(b"Run-A", b"Run-B"), True)
    report = evaluate(root, summary, "过期 fixture evidence Run-A\n新记录 fixture evidence Run-B")
    assert report["supportedCount"] == 0  # Cached result IDs do not select replacement rows.
elif scenario == "identity":
    root, summary = workspace("identity")
    claims(root, "关联 fixture `" + source + "`")
    for changes in [{"plan": plan.lower()}, {"planRevision": False}, {"results": False}, {"provenance": []}, {"planFile": ""}]:
        reject(lambda: actual_evaluate(root, {**summary, **changes}))
    old = {**summary}; old.pop("resultPathIdentity")
    assert actual_evaluate(root, old)["path"] == agent.plan_results_artifact_relpath(plan, "claim_evidence.json")
    missing, missing_summary = workspace("missing")
    report = actual_evaluate(missing, missing_summary)
    assert report["status"] == "needs_claims_file" and report["supportedCount"] == 0
elif scenario == "snapshots":
    root, summary = workspace("claims-changed")
    file = claims(root, "关联 fixture `" + source + "`")
    original = agent.parse_claim_lines; before = os.stat(file)
    def changed(text):
        save(root, "paper/claims.md", text.replace("关联", "变化"), True)
        os.utime(file, ns=(before.st_atime_ns, before.st_mtime_ns))
        return original(text)
    with patch.object(agent, "parse_claim_lines", changed): reject(lambda: actual_evaluate(root, summary))
    root, summary = workspace("archive-changed"); claims(root, "关联 fixture `" + source + "`")
    def changed_archive(text):
        archive(root, archived=False); return original(text)
    with patch.object(agent, "parse_claim_lines", changed_archive): reject(lambda: actual_evaluate(root, summary))
    root, summary = workspace("source-changed"); claims(root, "关联 fixture `" + source + "`")
    def changed_source(text):
        save(root, source, "changed", True); return original(text)
    with patch.object(agent, "parse_claim_lines", changed_source): reject(lambda: actual_evaluate(root, summary))
    root, summary = workspace("missing-appeared"); verify = agent.claim_evidence_verify
    def appeared(root, snapshots, directories, missing=False):
        claims(root, "出现 fixture evidence Run-A"); return verify(root, snapshots, directories, missing)
    with patch.object(agent, "claim_evidence_verify", appeared): reject(lambda: actual_evaluate(root, summary))
elif scenario == "inputs":
    for index, data in enumerate([b"\xff", b"x" * (5 * 1024 * 1024 + 1), "x" * 16385, "\n".join("claim fixture needs experiment" for _ in range(4001))]):
        root, summary = workspace(str(index)); claims(root, data); reject(lambda: actual_evaluate(root, summary))
    root, summary = workspace("invalid-source"); claims(root, "关联 fixture `" + source + "`")
    save(root, source, b"\xff", True); reject(lambda: actual_evaluate(root, summary))
    root, summary = workspace("directory-claims"); os.makedirs(os.path.join(native(root), "paper", "claims.md")); reject(lambda: actual_evaluate(root, summary))
    root, summary = workspace("wrong-case"); save(root, "paper/Claims.md", "wrong case fixture")
    if os.name == "nt":
        reject(lambda: actual_evaluate(root, summary))
    else:
        assert actual_evaluate(root, summary)["status"] == "needs_claims_file"
elif scenario == "handler":
    root, summary = workspace("handler")
    claims(root, "关联 fixture `" + source + "`\n关联 fixture evidence Run-A")
    summary = agent.parse_results_action(root, None, plan, revision, {"topologyMode": "single_worker", "resultOwnerWorkerId": "fixture-worker"})
    assert summary["resultCount"] == 2 and summary["finalResultCount"] == 2
    assert summary["claimEvidenceStatus"] == "passed" and summary["claimSupportedCount"] == 2
    report = next(value for _, value in writes if "claimsPath" in value)
    assert report["planFile"] == plan and report["resultPathIdentity"] == "posix-v1"
    assert events[-1]["payload"]["planFile"] == plan
    out.update(summary=summary, report=report)
else:
    raise AssertionError("Unknown scenario")
out.update(passed=True, capturedPublicationsOnly=True, publicationExecutorsInvoked=False)
print(json.dumps(out, ensure_ascii=False))
