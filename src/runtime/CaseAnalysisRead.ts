/** Checked case inputs for explicit Plan actions; old unscoped entry points remain. */
export const CASE_ANALYSIS_READ_PYTHON = String.raw`
def case_analysis_is_csv(relative):
    return case_like_csv_path(relative.rstrip())

def case_analysis_scan(root, relative, inventories, max_depth=2, started=None):
    pending, out = [(relative, 0)], []
    started = time.monotonic() if started is None else started
    while pending:
        parent, depth = pending.pop()
        if len(inventories) > 4000 or time.monotonic() - started > 6:
            raise ValueError("样本级发现超出目录或时间预算")
        names = project_aggregate_inventory(root, parent, inventories)
        if not names:
            continue
        directory = output_contract_path(root, parent, directory=True)
        for name in names:
            if name in (".git", "node_modules", "__pycache__", "checkpoints", "weights", "datasets", "features", ".DS_Store"):
                continue
            child = parent + "/" + name
            info = os.lstat(os.path.join(directory, name))
            if stat.S_ISDIR(info.st_mode):
                output_contract_path(root, child, directory=True)
                if depth < max_depth:
                    pending.append((child, depth + 1))
            elif case_analysis_is_csv(child):
                output_contract_path(root, child)
                out.append(child)
                if len(set(out)) > 240:
                    raise ValueError("样本级来源数量超出预算")
            elif stat.S_ISLNK(info.st_mode):
                raise ValueError("样本级发现目录包含符号链接")
    return sorted(set(out))

def case_analysis_context(root, plan, revision=""):
    identity = output_contract_request_identity({"planFile": plan, "planRevision": revision})
    plan, revision = identity["planFile"], identity.get("planRevision", "")
    snapshots, inventories, missing = ProjectAggregateSnapshots(), [], []
    contract = output_contract_plan(root, plan)
    snapshots.append((plan, contract["snapshot"]))
    for relative in ("experiments/simple_project.yaml", "experiments/results/jobs.csv"):
        try:
            output_contract_path(root, relative)
        except FileNotFoundError:
            missing.append(relative)
    state_root, missing_external = agent_dir(root), []
    try:
        output_contract_path(state_root, "result_policy.json")
    except FileNotFoundError:
        missing_external.append((state_root, "result_policy.json"))
    policy = read_project_metric_policy(root, strict_paths=True, snapshots=snapshots)
    jobs = result_parse_jobs(root, plan, [], snapshots)
    declared = list(dict.fromkeys([*contract["candidates"], *jobs]))
    configured = [policy.get("caseCsv"), *(policy.get("candidateCsv") or [])]
    sources, owned, owned_parents = set(), set(), set()
    scans, started = {}, time.monotonic()
    def scan(relative, depth):
        key = (relative, depth)
        if key not in scans:
            scans[key] = case_analysis_scan(root, relative, inventories, depth, started)
        return scans[key]
    for raw in dict.fromkeys([*declared, *(value for value in configured if output_contract_candidate(value))]):
        if any(char in raw for char in "*?["):
            parts = []
            for part in raw.split("/"):
                if any(char in part for char in "*?["):
                    break
                parts.append(part)
            if not parts:
                raise ValueError("样本级模式缺少明确目录")
            candidates = [value for value in scan("/".join(parts), 64) if output_contract_pattern_matches(raw, value)]
        else:
            candidates = []
            if case_analysis_is_csv(raw):
                try:
                    output_contract_path(root, raw)
                except FileNotFoundError:
                    missing.append(raw)
                else:
                    candidates.append(raw)
            parent = "/".join(raw.split("/")[:-1])
            if raw in declared and parent:
                candidates.extend(scan(parent, 2))
                if contract["suite"] and contract["suite"] in parent.split("/"):
                    owned_parents.add(parent)
        for candidate in candidates:
            sources.add(candidate)
            if raw in declared and output_contract_pattern_matches(raw, candidate):
                owned.add(candidate)
        if len(sources) > 240:
            raise ValueError("样本级来源数量超出预算")
    rows, sources_with_rows = [], []
    for source in sorted(sources):
        snapshot = output_contract_read_snapshot(root, source)
        snapshots.append((source, snapshot))
        anonymous = source in owned or any(source.startswith(parent + "/") for parent in owned_parents)
        before = len(rows)
        reader = csv.DictReader(io.StringIO(snapshot["text"], newline=""), strict=True)
        if reader.fieldnames is None or len(reader.fieldnames) != len(set(reader.fieldnames)) or any(not name or len(name) > 4096 for name in reader.fieldnames):
            raise ValueError("样本级 CSV 表头为空或重复")
        for index, row in enumerate(reader):
            if index >= 50000 or None in row or any(value is None for value in row.values()):
                raise ValueError("样本级 CSV 行数超限或字段数量不符")
            row_plan = result_parse_row_identity(row)
            if row_plan and row_plan != plan:
                continue
            if not result_parse_row_matches(row, plan, contract["suite"], anonymous=anonymous):
                continue
            row_revision = archive_evidence_identity(row)[1]
            if revision and row_revision and row_revision != revision:
                continue
            metrics, metric = {}, metric_name(row.get("metric") or "")
            if metric:
                metrics[metric] = coerce_metric_value(row.get("value"))
            for key, value in row.items():
                name = metric_name(key)
                if name in KNOWN_METRICS and value not in (None, ""):
                    metrics[name] = coerce_metric_value(value)
            case_id = row.get("case_id") or row.get("caseId") or row.get("id") or str(index)
            rows.append({"schemaVersion": 1, "caseResultId": sha256_text(source + ":" + case_id + ":" + str(index) + ":" + plan)[:16],
                         "experimentId": row.get("experiment_id") or row.get("experimentId") or "", "caseId": case_id,
                         "patientId": row.get("patient_id") or row.get("patientId") or "", "dataset": row.get("dataset") or "",
                         "split": row.get("split") or "", "method": row.get("method") or "", "metrics": metrics,
                         "subgroup": {key: row[key] for key in ("subgroup", "sex", "age_group", "class_name", "site") if row.get(key)},
                         "sourceFile": source, "parsedAt": now_iso(), "planFile": plan, "planRevision": revision, "resultPathIdentity": "posix-v1"})
            if len(rows) > 50000:
                raise ValueError("样本级解析总行数超出预算")
        if len(rows) != before:
            sources_with_rows.append(source)
    index = {"schemaVersion": 1, "generatedAt": now_iso(), "cases": rows, "caseCount": len(rows), "failures": [],
             "status": "available" if rows else "empty", "planFile": plan, "planRevision": revision, "resultPathIdentity": "posix-v1",
             "sourceFiles": sources_with_rows, "path": plan_results_artifact_relpath(plan, "case_level_index.json", strict_plan=True)}
    context = {"index": index, "snapshots": snapshots, "inventories": inventories, "missing": missing, "missingExternal": missing_external}
    case_analysis_verify(root, context)
    return context

def case_analysis_verify(root, context):
    project_aggregate_verify(root, context["snapshots"], context["inventories"])
    plan_analysis_verify(root, context)
    for state_root, relative in context["missingExternal"]:
        try:
            output_contract_path(state_root, relative)
        except FileNotFoundError:
            continue
        raise ValueError("样本读取期间出现新的插件结果策略")

def checked_case_level_action(root, plan, revision=""):
    context = case_analysis_context(root, plan, revision)
    case_analysis_verify(root, context)
    plan_analysis_publish_report(root, context["index"], "case_level_index.json")
    return context["index"]
`;
