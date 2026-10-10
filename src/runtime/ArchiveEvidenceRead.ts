/** Plan-scoped, read-only compatibility boundary for existing archive evidence. */
export const ARCHIVE_EVIDENCE_READ_PYTHON = String.raw`
def archive_evidence_identity(record):
    if not isinstance(record, dict):
        raise ValueError("归档身份必须是对象")
    plan = result_parse_row_identity(record)
    owners = [record]
    if record.get("provenance") is not None:
        owners.append(record["provenance"])
    revisions = [owner[key] for owner in owners for key in ("planRevision", "plan_revision") if key in owner and owner[key] != ""]
    if any(not isinstance(value, str) for value in revisions) or len(set(revisions)) > 1:
        raise ValueError("归档 revision 类型或别名冲突")
    revision = output_contract_request_identity({"planRevision": revisions[0]}).get("planRevision", "") if revisions else ""
    return plan, revision

def archive_evidence_key(value):
    if (not isinstance(value, str) or not value or len(value.encode("utf-8")) > 4096
            or value.startswith("/") or chr(92) in value or re.match(r"^[A-Za-z]:/", value)
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or len(value.split("/")) > 64 or any(part in ("", ".", "..") for part in value.split("/"))):
        raise ValueError("归档产物键必须保留原始身份")
    return value

def archive_evidence_state(entry):
    for field in ("archived", "excluded"):
        if field in entry and not isinstance(entry[field], bool):
            raise ValueError("归档标记必须是布尔值")
    statuses = [entry[field] for field in ("status", "state") if field in entry and entry[field] != ""]
    if any(not isinstance(value, str) for value in statuses) or len(set(statuses)) > 1:
        raise ValueError("归档状态类型或别名冲突")
    status = statuses[0] if statuses else ""
    archived = entry.get("archived", False) or status == "archived"
    excluded = entry.get("excluded", False) or status == "excluded"
    if archived and excluded:
        raise ValueError("归档与排除状态冲突")
    return "archived" if archived else "excluded" if excluded else "pending_review"

def read_plan_archive_evidence(root, plan, revision="", snapshots=None):
    plan = durable_plan_path(plan, "归档证据 Plan")
    identity = output_contract_request_identity({"planFile": plan, "planRevision": revision})
    plan, revision = identity["planFile"], identity.get("planRevision", "")
    paths = ["simple_cluster/archive_state/by_plan/" + result_plan_directory_key(plan) + ".json",
             archive_state_relpath(plan), "simple_cluster/archive_state.json"]
    bindings = []
    for relative in dict.fromkeys(paths):
        try:
            snapshot = output_contract_read_snapshot(root, relative)
        except FileNotFoundError:
            continue
        bindings.append((relative, snapshot))
        state = json.loads(snapshot["text"])
        if not isinstance(state, dict) or not isinstance(state.get("entries", {}), dict):
            raise ValueError("归档状态或 entries 类型无效")
        state_plan, state_revision = archive_evidence_identity(state)
        entries = state.get("entries", {})
        if len(entries) > 4000:
            raise ValueError("归档条目超出数量预算")
        out = {}
        if (not state_plan or state_plan == plan) and (not revision or not state_revision or state_revision == revision):
            for raw_key, entry in entries.items():
                key = archive_evidence_key(raw_key)
                entry_plan, entry_revision = archive_evidence_identity(entry)
                for field in ("path", "artifactKey", "artifact_key", "archiveKey", "archive_key"):
                    if field in entry and entry[field] != "" and archive_evidence_key(entry[field]) != key:
                        raise ValueError("归档条目路径与产物键不一致")
                archive_evidence_state(entry)
                # An anonymous/global parent never lends Plan or revision to an entry.
                if entry_plan == plan and (not revision or entry_revision == revision):
                    out[key] = entry
        for path, binding in bindings:
            output_contract_verify_snapshot(root, path, binding)
        if snapshots is not None:
            snapshots.extend(bindings)
        # An existing scoped file, including empty/foreign state, is authoritative.
        return out
    return {}

def raw_result_evidence_keys(record):
    if not isinstance(record, dict):
        raise ValueError("结果归档证据必须是对象")
    values = [record[field] for field in ("resultId", "result_id", "id", "artifactPath", "artifact_path", "hub_job_dir", "worker_job_dir", "native_job_dir", "archiveKey", "archive_key", "sourceFile", "source", "resultPath", "result_path", "results_csv", "result_csv", "runKey", "run_key", "run_id", "experimentId", "experiment_id") if field in record and record[field] != ""]
    sources = record.get("sourceFiles", [])
    if not isinstance(sources, list) or len(sources) > 240:
        raise ValueError("结果来源列表类型或数量无效")
    for item in sources:
        if not isinstance(item, dict):
            raise ValueError("结果来源必须是对象")
        if "path" in item and item["path"] != "":
            values.append(item["path"])
    provenance = record.get("provenance") or {}
    if not isinstance(provenance, dict):
        raise ValueError("结果 provenance 类型无效")
    values.extend(provenance[field] for field in ("artifactKey", "artifactPath", "sourceFile") if field in provenance and provenance[field] != "")
    return sorted(dict.fromkeys(archive_evidence_key(value) for value in values))

def plan_archive_evidence_index(entries):
    states = {"archived": set(), "excluded": set()}
    for key, entry in entries.items():
        state = archive_evidence_state(entry)
        if state in states:
            states[state].add(key)
    return states

def plan_archive_evidence_decision(record, entries, plan, revision="", states=None):
    try:
        record_plan, record_revision = archive_evidence_identity(record)
        if record_plan != plan or revision and record_revision and record_revision != revision:
            raise ValueError("结果行不属于当前 Plan/revision")
        keys = raw_result_evidence_keys(record)
    except (ValueError, UnicodeError):
        return {"state": "pending_review", "eligibleForFinalAnalysis": False, "reason": "结果行原始身份无效或不属于当前 Plan；请重新解析。", "matchedKeys": [], "evidenceKeys": []}
    states = states if states is not None else plan_archive_evidence_index(entries)
    matched = {state: [key for key in keys if any("/".join(key.split("/")[:depth]) in states[state] for depth in range(1, len(key.split("/")) + 1))] for state in ("archived", "excluded")}
    state = "archived" if matched["archived"] else "excluded" if matched["excluded"] else "pending_review"
    return {"state": state, "eligibleForFinalAnalysis": state == "archived",
            "reason": "已核对当前 Plan 的原始归档证据。" if state == "archived" else "已排除结果。" if state == "excluded" else "缺少当前 Plan/revision 的明确归档证据；保留预览，不进入最终统计。",
            "matchedKeys": matched.get(state, [])[:8], "evidenceKeys": keys[:12]}
`;
