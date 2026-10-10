/** Recompute Plan analysis from bounded, checked inputs, without running experiments. */
export const PLAN_ANALYSIS_READ_PYTHON = String.raw`
def analysis_current_records(root, summary, snapshots, policy=None, require_complete=False):
    plan, revision = archive_evidence_identity(summary)
    durable_plan_path(plan, "分析 Plan")
    records = summary.get("results", [])
    if not isinstance(records, list) or len(records) > 50000:
        raise ValueError("分析结果列表类型或数量无效")
    wanted = set(claim_evidence_record_key(record) for record in final_analysis_results(root, summary, snapshots))
    sources = sorted({source for paths, _ in wanted for source in paths})
    if len(sources) > 240:
        raise ValueError("分析来源数量超出预算")
    if not sources:
        if wanted and require_complete:
            raise ValueError("已归档结果缺少原始来源，请重新解析当前 Plan")
        return []
    contract = output_contract_plan(root, plan)
    snapshots.append((plan, contract["snapshot"]))
    policy = dict(policy if policy is not None else read_project_metric_policy(root, strict_paths=True, snapshots=snapshots))
    jobs = result_parse_jobs(root, plan, [], snapshots)
    policy.update(_strictResultIdentity=True, _strictResultPlan=plan, _strictResultSuite=contract["suite"],
                  _strictPlanContract=contract, _strictResultSnapshots=snapshots)
    checked = []
    for source in sources:
        policy["_strictResultRequireOwner"] = not (source in jobs or any(output_contract_pattern_matches(pattern, source) for pattern in contract["candidates"]))
        for record in parse_result_file(root, source, policy, strict_paths=True, snapshots=snapshots):
            if not result_parse_row_matches(record, plan, contract["suite"]):
                continue
            record = {**record, "planFile": plan, "provenance": {**(record.get("provenance") or {}), "planFile": plan}}
            if require_complete or claim_evidence_record_key(record) in wanted:
                checked.append(record)
            if len(checked) > 50000:
                raise ValueError("分析重解析结果超出数量预算")
    child = {"planFile": plan, "planRevision": revision, "resultPathIdentity": "posix-v1", "results": checked}
    checked = final_analysis_results(root, child, snapshots)
    if require_complete and set(claim_evidence_record_key(record) for record in checked) != wanted:
        raise ValueError("已归档结果与当前原始来源不一致，请重新解析当前 Plan")
    return checked

def plan_analysis_context(root, plan, revision):
    identity = output_contract_request_identity({"planFile": plan, "planRevision": revision})
    summary = read_current_results_summary(root, plan, revision)
    summary_plan, summary_revision = archive_evidence_identity(summary)
    if (summary.get("resultPathIdentity") != "posix-v1" or summary_plan != identity["planFile"]
            or identity.get("planRevision") and summary_revision != identity["planRevision"]):
        raise ValueError("分析摘要与原始 Plan/revision 不一致")
    snapshots = ProjectAggregateSnapshots()
    relative = plan_results_summary_relpath(plan, strict_plan=True)
    snapshot = output_contract_read_snapshot(root, relative)
    if json.loads(snapshot["text"]) != summary:
        raise ValueError("分析摘要读取期间发生变化")
    snapshots.append((relative, snapshot))
    contract = output_contract_plan(root, plan)
    snapshots.append((plan, contract["snapshot"]))
    optional = ["experiments/simple_project.yaml", "experiments/results/jobs.csv",
                "simple_cluster/archive_state/by_plan/" + result_plan_directory_key(plan) + ".json",
                archive_state_relpath(plan), "simple_cluster/archive_state.json"]
    missing = []
    for candidate in dict.fromkeys(optional):
        try:
            output_contract_path(root, candidate)
        except FileNotFoundError:
            missing.append(candidate)
    policy = read_project_metric_policy(root, strict_paths=True, snapshots=snapshots)
    records = analysis_current_records(root, summary, snapshots, policy, require_complete=True)
    fresh = {claim_evidence_record_key(record): record for record in records}
    summary["results"] = [fresh.get(claim_evidence_record_key(record), record) for record in summary["results"]]
    apply_final_evidence_summary(root, summary, snapshots)
    context = {"summary": summary, "policy": policy, "records": records, "snapshots": snapshots, "missing": missing}
    plan_analysis_verify(root, context)
    return context

def plan_analysis_verify(root, context):
    for relative, snapshot in context["snapshots"]:
        output_contract_verify_snapshot(snapshot.get("root", root), relative, snapshot)
    for relative in context["missing"]:
        try:
            output_contract_path(root, relative)
        except FileNotFoundError:
            continue
        raise ValueError("分析读取期间出现新的输入：" + relative)

def plan_analysis_publish_report(root, report, filename):
    relative = plan_results_artifact_relpath(report["planFile"], filename, strict_plan=True)
    report.update(path=relative, resultPathIdentity="posix-v1")
    for target in (relative, "simple_cluster/results/" + filename):
        full = worker_plan_project_path(root, target)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        atomic_write(full, report)
`;
