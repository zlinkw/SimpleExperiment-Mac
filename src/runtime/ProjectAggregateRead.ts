/** Checked project table inputs; reuse the actual Plan producer without publishing it. */
export const PROJECT_AGGREGATE_READ_PYTHON = String.raw`
class ProjectAggregateSnapshots(list):
    def __init__(self):
        super().__init__()
        self.byte_count = 0

    def extend(self, values):
        values = list(values)
        size = sum(snapshot["identity"][2] for _, snapshot in values)
        if self.byte_count + size > 128 * 1024 * 1024:
            raise ValueError("项目聚合输入总大小超出预算")
        super().extend(values)
        self.byte_count += size

    def append(self, value):
        self.extend([value])

def project_result_seed_groups(records, group_keys):
    groups = {}
    for record in records:
        dimensions = record.get("dimensions") or {}
        key = tuple(str(dimensions.get(name) if dimensions.get(name) is not None else "") for name in group_keys)
        seed = result_seed_key(dimensions.get("seed"))
        values = groups.setdefault(key, {}).setdefault(seed, {})
        for metric, payload in (record.get("metrics") or {}).items():
            value = coerce_metric_value(payload.get("value") if isinstance(payload, dict) else payload)
            if is_number(value) and math.isfinite(float(value)):
                values[str(metric)] = float(value)
    return groups

def project_aggregate_inventory(root, relative, inventories):
    try:
        directory = output_contract_path(root, relative, directory=True)
    except FileNotFoundError:
        inventories.append((relative, None, None))
        return []
    info = os.stat(directory)
    names = sorted(os.listdir(directory))
    if sum(len(item[2] or []) for item in inventories) + len(names) > 8192:
        raise ValueError("项目聚合目录集合超出预算")
    inventories.append((relative, (info.st_dev, info.st_ino), names))
    return names

def project_aggregate_verify(root, snapshots, inventories):
    if sum(snapshot["identity"][2] for _, snapshot in snapshots) > 128 * 1024 * 1024:
        raise ValueError("项目聚合输入总大小超出预算")
    for relative, snapshot in snapshots:
        output_contract_verify_snapshot(snapshot.get("root", root), relative, snapshot)
    for relative, identity, names in inventories:
        try:
            directory = output_contract_path(root, relative, directory=True)
        except FileNotFoundError:
            if identity is None:
                continue
            raise ValueError("项目聚合目录消失")
        info = os.stat(directory)
        if identity != (info.st_dev, info.st_ino) or names != sorted(os.listdir(directory)):
            raise ValueError("项目聚合目录或文件集合发生变化")

def project_aggregate_catalog(root, current_summary, snapshots, inventories):
    current_plan, current_revision = archive_evidence_identity(current_summary)
    durable_plan_path(current_plan, "项目聚合当前 Plan")
    parent = "simple_cluster/results/by_plan"
    names = project_aggregate_inventory(root, parent, inventories)
    saved_by_plan = {}
    directory_count = 0
    for slug in names:
        durable_plan_path(slug, "项目聚合目录项")
        directory = output_contract_path(root, parent, directory=True)
        info = os.lstat(os.path.join(directory, slug))
        if stat.S_ISREG(info.st_mode):
            continue
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("项目聚合目录项不是普通目录")
        directory_count += 1
        if directory_count > 500:
            raise ValueError("项目聚合 Plan 目录超出数量预算")
        children = project_aggregate_inventory(root, parent + "/" + slug, inventories)
        for name in ("summary.json", "dataset-index.json"):
            if name not in children:
                continue
            relative = parent + "/" + slug + "/" + name
            snapshot = output_contract_read_snapshot(root, relative)
            snapshots.append((relative, snapshot))
            saved = json.loads(snapshot["text"])
            try:
                plan, revision = archive_evidence_identity(saved)
            except (ValueError, UnicodeError) as exc:
                raise ValueError("项目聚合元数据 " + relative + ": " + str(exc)) from exc
            if not plan:
                continue
            if slug not in (result_plan_directory_key(plan), plan_summary_slug(plan)):
                raise ValueError("项目聚合目录与原始 Plan 不一致")
            if plan == current_plan:
                continue
            priority = (4 if slug == result_plan_directory_key(plan) else 0) + (2 if name == "dataset-index.json" else 1)
            previous = saved_by_plan.get(plan)
            if previous:
                previous_revision = archive_evidence_identity(previous[1])[1]
                if revision and previous_revision and revision != previous_revision:
                    raise ValueError("项目聚合索引与摘要 revision 冲突，请重新解析 Plan: " + plan)
                if previous[0] > priority:
                    continue
                if not revision and previous_revision:
                    saved = {**saved, "planRevision": previous_revision}
            saved_by_plan[plan] = (priority, saved)
    saved_by_plan[current_plan] = (99, current_summary)
    return {plan: item[1] for plan, item in saved_by_plan.items()}

def project_aggregate_checked_table(root, plan, saved, table, kind, snapshots):
    if not isinstance(table, dict):
        raise ValueError("项目聚合表必须是对象")
    table_plan, table_revision = archive_evidence_identity(table)
    revision = archive_evidence_identity(saved)[1]
    if table_plan and table_plan != plan or table_revision and table_revision != revision:
        raise ValueError("项目聚合表的 Plan/revision 不一致")
    dataset = table.get("dataset", "")
    if not isinstance(dataset, str):
        raise ValueError("项目聚合 dataset 必须是字符串")
    dataset_key = dataset_path_key(dataset)
    if "datasetKey" in table and table["datasetKey"] != dataset_key:
        raise ValueError("项目聚合 datasetKey 与原始数据集不一致")
    field, filename = ("aggregateCsvPath", "seed_mean_std.csv") if kind == "seed" else ("finalCsvPath", "final.csv")
    relative = table.get(field, "")
    if relative == "":
        return None
    durable_plan_path(relative, "项目聚合表路径")
    if relative != dataset_plan_artifact_path(plan, dataset, filename):
        raise ValueError("项目聚合表路径与原始 Plan/数据集不一致")
    source = table.get("rawResultCsvPath", saved.get("rawResultCsvPath", ""))
    durable_plan_path(source, "项目聚合原始 CSV")
    contract = output_contract_plan(root, plan)
    snapshots.append((plan, contract["snapshot"]))
    policy = read_project_metric_policy(root, strict_paths=True, snapshots=snapshots)
    policy.update(_strictResultIdentity=True, _strictResultPlan=plan, _strictResultSuite=contract["suite"],
                  _strictPlanContract=contract, _strictResultSnapshots=snapshots)
    records = parse_result_file(root, source, policy, strict_paths=True, snapshots=snapshots)
    checked = []
    for record in records:
        if not result_parse_row_matches(record, plan, contract["suite"]):
            continue
        record = {**record, "planFile": plan, "provenance": {**(record.get("provenance") or {}), "planFile": plan}}
        if str((record.get("dimensions") or {}).get("dataset") or "").strip() == dataset:
            checked.append(record)
    child = {"planFile": plan, "planRevision": revision, "resultPathIdentity": "posix-v1", "results": checked}
    outputs = []
    _write_dataset_seed_aggregate(root, child, policy, dataset, outputs)
    if child.get("aggregateStatus") != "ready" or child.get(field) != relative:
        raise ValueError("项目聚合表缺少当前 Plan 的真实逐 seed 来源")
    expected = next((output for output in outputs if output[0] == "csv" and output[1] == relative), None)
    if expected is None:
        raise ValueError("项目聚合未产生对应表")
    snapshot = output_contract_read_snapshot(root, relative)
    snapshots.append((relative, snapshot))
    actual_rows = list(csv.reader(io.StringIO(snapshot["text"], newline="")))
    buffer = io.StringIO(newline="")
    csv.writer(buffer).writerows([expected[2], *expected[3]])
    expected_rows = list(csv.reader(io.StringIO(buffer.getvalue(), newline="")))
    if actual_rows != expected_rows:
        raise ValueError("项目聚合表与当前受检来源/归档证据不一致，请重新解析 Plan: " + plan + "；表: " + relative + "；来源: " + source)
    if not actual_rows or len(set(actual_rows[0])) != len(actual_rows[0]) or len(actual_rows) > 50001:
        raise ValueError("项目聚合 CSV 表头或行数无效")
    return actual_rows

def checked_project_dataset_table_outputs(root, current_summary, kind):
    if kind not in ("seed", "final"):
        raise ValueError("项目聚合类型无效")
    snapshots, inventories, groups, total = ProjectAggregateSnapshots(), [], {}, 0
    saved_by_plan = project_aggregate_catalog(root, current_summary, snapshots, inventories)
    for plan, saved in sorted(saved_by_plan.items()):
        if saved.get("aggregateStatus") != "ready":
            continue
        tables = saved.get("datasetResultTables", [saved])
        if not isinstance(tables, list) or len(tables) > 240:
            raise ValueError("项目聚合 datasetResultTables 类型或数量无效")
        seen = set()
        for table in tables:
            matrix = project_aggregate_checked_table(root, plan, saved, table, kind, snapshots)
            if matrix is None:
                continue
            dataset = table.get("dataset", "")
            if dataset in seen:
                raise ValueError("项目聚合同一 Plan 数据集表重复")
            seen.add(dataset)
            headers = matrix[0]
            for values in matrix[1:]:
                total += 1
                if total > 50000:
                    raise ValueError("项目聚合总行数超出预算")
                row = dict(zip(headers, values))
                if row.get("dataset", "") != dataset or row.get("plan_file", plan) != plan:
                    raise ValueError("项目聚合 CSV 行与 Plan/数据集归属不一致")
                group = groups.setdefault(dataset, {"headers": ["plan_file", "dataset"], "rows": []})
                for header in headers:
                    if header not in group["headers"]:
                        group["headers"].append(header)
                group["rows"].append({**row, "plan_file": plan, "dataset": dataset})
    return project_dataset_table_outputs_from_groups(root, groups, kind,
        before_publish=lambda: project_aggregate_verify(root, snapshots, inventories))
`;
