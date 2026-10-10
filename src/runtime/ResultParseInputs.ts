/** Strict input and identity helpers for Plan-scoped result parsing in the Agent. */
export const RESULT_PARSE_INPUTS_PYTHON = String.raw`
RESULT_PARSE_ACTIONS = ("refresh-results", "rescan-results", "parse-results")

def result_parse_selection(value, kind="auto"):
    if not isinstance(value, str) or not value or value == "-" or len(value.encode("utf-8")) > 4096 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("结果选择必须是预算内原始字符串")
    if kind == "auto":
        kind = "path" if "/" in value or chr(92) in value or output_contract_candidate(value) else "key"
    if kind == "path":
        durable_plan_path(value, "结果选择路径")
    return {"kind": kind, "value": value}

def result_parse_request(payload):
    identity = output_contract_request_identity(payload)
    selected = []
    paths = ("remotePath", "path")
    keys = ("selectedRunKeys", "selectedArchiveKeys", "selectedExperimentIds", "runKey", "archiveKey", "experimentId")
    for owner in [payload, payload.get("options") or {}]:
        for key in (*paths, *keys):
            if key not in owner or owner[key] == "":
                continue
            values = owner[key] if isinstance(owner[key], list) else [owner[key]]
            for value in values:
                item = result_parse_selection(value, "path" if key in paths else "key")
                if item not in selected:
                    selected.append(item)
        targets = owner.get("selectedTaskTargets", [])
        if not isinstance(targets, list):
            raise ValueError("结果 selectedTaskTargets 必须是列表")
        for target in targets:
            if not isinstance(target, dict):
                raise ValueError("结果选择任务必须是对象")
            target_identity = output_contract_request_identity(target)
            if target_identity.get("planFile") and target_identity.get("planFile") != identity.get("planFile"):
                raise ValueError("结果选择任务属于不同 Plan")
            if target_identity.get("planRevision") and identity.get("planRevision") and target_identity["planRevision"] != identity["planRevision"]:
                raise ValueError("结果选择任务 revision 不一致")
            for key in ("resultPath", "result_path", "archiveKey", "archive_key", "runKey", "run_key", "experimentId", "experiment_id", "taskUiKey", "task_ui_key", "logPath", "log_path", "remotePath", "path"):
                if key in target and target[key] != "":
                    kind = "path" if key in ("resultPath", "result_path", "logPath", "log_path", "remotePath", "path") else "key"
                    item = result_parse_selection(target[key], kind)
                    if item not in selected:
                        selected.append(item)
        if len(selected) > 240:
            raise ValueError("结果选择超出数量预算")
    return identity, selected

def result_parse_row_identity(row):
    owners = [row]
    if row.get("provenance") is not None:
        if not isinstance(row["provenance"], dict):
            raise ValueError("结果行 provenance 类型无效")
        owners.append(row["provenance"])
    values = [owner[key] for owner in owners for key in ("planFile", "plan_file", "selectedPlanId", "selected_plan_id") if key in owner and owner[key] != ""]
    if any(not isinstance(value, str) for value in values) or len(set(values)) > 1:
        raise ValueError("结果行 Plan 别名类型或身份冲突")
    return durable_plan_path(values[0], "结果行 Plan") if values else ""

def result_parse_row_matches(row, plan, suite="", anonymous=True):
    try:
        declared = result_parse_row_identity(row)
    except (ValueError, UnicodeError):
        return False
    if declared:
        return declared == plan
    if anonymous:
        return True
    declared_suite = row.get("suite")
    dimensions = row.get("dimensions")
    if declared_suite is None and isinstance(dimensions, dict):
        declared_suite = dimensions.get("suite")
    return bool(suite and isinstance(declared_suite, str) and declared_suite == suite)

def result_parse_jobs(root, plan, selected, snapshots, limit=240):
    try:
        snapshot = output_contract_read_snapshot(root, "experiments/results/jobs.csv")
    except FileNotFoundError:
        return []
    snapshots.append(("experiments/results/jobs.csv", snapshot))
    wanted = {item["value"] for item in selected if item["kind"] == "key"}
    out = []
    for row in read_csv_dicts(snapshot["text"]):
        if not result_parse_row_matches(row, plan, anonymous=False):
            continue
        row_keys = {row.get(key) for key in ("run_key", "runKey", "experiment_id", "experimentId", "case", "case_id", "id", "name", "archiveKey", "archive_key") if isinstance(row.get(key), str)}
        if selected and not row_keys.intersection(wanted):
            continue
        for key in ("result_csv", "resultCsv", "results_csv", "resultsCsv", "metrics_csv", "metricsCsv", "summary_csv", "summaryCsv", "output_csv", "outputCsv", "result_json", "resultJson", "metrics_json", "metricsJson", "summary_txt", "summaryTxt", "log_file", "logFile", "metrics_summary", "metricsSummary", "metrics_case", "metricsCase", "result_path", "resultPath", "output_path", "outputPath"):
            candidate = output_contract_candidate(row.get(key))
            if candidate and candidate not in out:
                out.append(candidate)
        for key in ("output_dir", "outputDir", "work_dir", "workDir", "result_dir", "resultDir", "results_dir", "resultsDir", "log_dir", "logDir"):
            out.extend(default_result_candidates_for_dir(row.get(key), strict_paths=True))
        if len(out) >= limit:
            break
    return sorted(dict.fromkeys(out))[:limit]

def result_parse_inputs(root, plan, selected, policy, snapshots):
    selections = []
    if selected is not None and not isinstance(selected, list):
        raise ValueError("结果选择必须是列表")
    for item in selected or []:
        if isinstance(item, dict) and set(item) == {"kind", "value"} and item["kind"] in ("key", "path"):
            selections.append(result_parse_selection(item["value"], item["kind"]))
        else:
            selections.append(result_parse_selection(item))
    if len(selections) > 240:
        raise ValueError("结果选择超出数量预算")
    contract = output_contract_plan(root, plan)
    snapshots.append((plan, contract["snapshot"]))
    jobs = result_parse_jobs(root, plan, selections, snapshots)
    if selections:
        files = output_contract_expand(root, jobs, patterns=False)
        for item in selections:
            if item["kind"] != "path":
                continue
            raw = item["value"]
            if output_contract_candidate(raw):
                files.extend(output_contract_expand(root, [raw], patterns=False))
            else:
                try:
                    files.extend(output_contract_walk(root, raw))
                except FileNotFoundError:
                    continue
        policy_only = set()
    else:
        declared = output_contract_expand(root, contract["candidates"])
        files = [*declared, *output_contract_expand(root, jobs, patterns=False), *output_contract_discover_candidates(root, contract)]
        values = [policy.get("summaryCsv"), policy.get("caseCsv"), *(policy.get("candidateCsv") or []), *(policy.get("candidateJson") or []), *(policy.get("consoleLogs") or []), *(policy.get("textLogs") or [])]
        configured = output_contract_expand(root, [value for value in values if output_contract_candidate(value)])
        policy_only = set(configured).difference(files)
        files.extend(configured)
    files = sorted(dict.fromkeys(file for file in files if file.rstrip().lower().endswith((".csv", ".json")) and file.rsplit("/", 1)[-1].strip().lower() not in STRUCTURED_RESULT_DIAGNOSTIC_LOGS))[:240]
    policy["_strictResultIdentity"] = True
    policy["_strictResultPlan"] = plan
    policy["_strictResultSuite"] = contract["suite"]
    policy["_strictPlanContract"] = contract
    policy["_strictResultSnapshots"] = snapshots
    return files, policy_only, contract["suite"]

def result_summary_plan(summary):
    raw = summary.get("planFile") or ""
    return durable_plan_path(raw, "结果摘要 Plan") if raw and summary.get("resultPathIdentity") == "posix-v1" else normalize_result_candidate(raw)
`;
