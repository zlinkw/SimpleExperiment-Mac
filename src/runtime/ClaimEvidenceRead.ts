/** Read claims and current Plan evidence from checked inputs; retain legacy entry points. */
export const CLAIM_EVIDENCE_READ_PYTHON = String.raw`
def claim_evidence_reference(value):
    durable_plan_path(value, "claim 证据引用")
    return (value == "experiments/results.csv" or value in ("experiments/runs", "experiments/results")
            or value.startswith(("experiments/runs/", "experiments/results/")))

def claim_evidence_refs(text):
    refs, covered = [], []
    def add(value, uri=False):
        if uri:
            parsed = urlparse(value)
            if parsed.scheme or parsed.netloc:
                return
            value = parsed.path
            if re.search(r"%(?![0-9A-Fa-f]{2})", value):
                raise ValueError("claim Markdown 引用的百分号编码无效")
            value = unquote(value, encoding="utf-8", errors="strict")
        if value.startswith(("experiments/", "paper/")) or "/experiments/" in value:
            durable_plan_path(value, "claim 证据引用")
            if value not in refs:
                refs.append(value)
                if len(refs) > 240:
                    raise ValueError("claim 引用数量超出预算")
    for match in re.finditer(r"\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s()]+))(?:[ \t]+(?:\"[^\"\n]*\"|'[^'\n]*'))?[ \t]*\)", text):
        add(match.group(1) if match.group(1) is not None else match.group(2), uri=True)
        covered.append(match.span())
        if len(covered) > 240:
            raise ValueError("claim Markdown 数量超出预算")
    for match in re.finditer(r"(?P<ticks>" + chr(96) + r"+)(?P<value>[^" + chr(96) + r"\n]*?)(?P=ticks)", text):
        if not any(left <= match.start() < right for left, right in covered):
            add(match.group("value"))
            covered.append(match.span())
            if len(covered) > 240:
                raise ValueError("claim Markdown 数量超出预算")
    for match in re.finditer(r"(?<![\w/])(?:experiments/(?:runs|results)(?:/[^\s\x60\])},;，。；]+|\.csv)?|paper/claims\.md)(?![A-Za-z0-9_./%-])", text):
        if not any(left <= match.start() < right for left, right in covered):
            add(match.group().rstrip(".,;，。；)]）"))
    if len(refs) > 240:
        raise ValueError("claim 引用数量超出预算")
    return refs

def claim_evidence_record_key(record):
    sources = record.get("sourceFiles", [])
    if not isinstance(sources, list) or len(sources) > 240:
        raise ValueError("claim 结果来源列表无效")
    paths = []
    for source in sources:
        if not isinstance(source, dict) or "path" not in source:
            raise ValueError("claim 结果来源缺少路径")
        paths.append(durable_plan_path(source["path"], "claim 原始结果来源"))
    identifier = record.get("resultId", "")
    if not isinstance(identifier, str) or not identifier or len(identifier.encode("utf-8")) > 4096:
        raise ValueError("claim 结果缺少原始 resultId")
    return tuple(sorted(dict.fromkeys(paths))), identifier

def claim_evidence_catalog(root, summary, snapshots):
    plan, revision = archive_evidence_identity(summary)
    durable_plan_path(plan, "claim Plan")
    records = summary.get("results", [])
    if not isinstance(records, list) or len(records) > 50000:
        raise ValueError("claim 结果列表类型或数量无效")
    wanted = set(claim_evidence_record_key(record) for record in final_analysis_results(root, summary, snapshots))
    sources = sorted({source for paths, _ in wanted for source in paths})
    if len(sources) > 240:
        raise ValueError("claim 来源数量超出预算")
    if not sources:
        return {"sources": [], "keys": []}
    contract = output_contract_plan(root, plan)
    snapshots.append((plan, contract["snapshot"]))
    policy = read_project_metric_policy(root, strict_paths=True, snapshots=snapshots)
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
            if claim_evidence_record_key(record) in wanted:
                checked.append(record)
            if len(checked) > 50000:
                raise ValueError("claim 重解析结果超出数量预算")
    catalog_sources, keys = set(), set()
    child = {"planFile": plan, "planRevision": revision, "resultPathIdentity": "posix-v1", "results": checked}
    for record in final_analysis_results(root, child, snapshots):
        paths, _ = claim_evidence_record_key(record)
        evidence = [source for source in paths if claim_evidence_reference(source)]
        if not evidence:
            continue
        catalog_sources.update(evidence)
        for field in ("resultId", "experimentId", "runKey"):
            value = record.get(field, "")
            if not isinstance(value, str) or len(value.encode("utf-8")) > 4096 or any(ord(char) < 32 or ord(char) == 127 for char in value):
                raise ValueError("claim 原始证据 ID 类型或内容无效")
            if value:
                keys.add(value)
                if len(keys) > 4000:
                    raise ValueError("claim 证据 ID 数量超出预算")
    return {"sources": sorted(catalog_sources), "keys": sorted(keys)}

def claim_evidence_ref_is_current(root, ref, catalog, directories):
    if not claim_evidence_reference(ref):
        return False
    if ref in catalog["sources"]:
        return True  # Bound ordinary UTF8 source descriptors were read by the actual parser.
    if not any(source.startswith(ref + "/") for source in catalog["sources"]):
        return False
    directory = output_contract_path(root, ref, directory=True)
    info = os.stat(directory)
    directories.append((ref, (info.st_dev, info.st_ino)))
    return True

def claim_evidence_key_matches(text, catalog):
    keys, matches, count = set(catalog["keys"]), set(), 0
    labels = r"(?<![A-Za-z0-9_])(?i:runkey|run key|result[ _]?id|experiment[ _]?id|evidence|运行编号|任务编号|实验编号|结果id|证据)(?![A-Za-z0-9_])[:： \t]*"
    for match in re.finditer(labels, text):
        count += 1
        if count > 240:
            raise ValueError("claim ID 引用数量超出预算")
        suffix = text[match.end():match.end() + 4097]
        if suffix.startswith(chr(96)):
            close = suffix.find(chr(96), 1)
            value = suffix[1:close] if close > 0 else ""
        else:
            token = re.match(r"[^\s" + chr(96) + r"\[\]{}]+", suffix)
            value = token.group().rstrip(".,;，。；)]）") if token else ""
        if len(value) >= 4 and value in keys:
            matches.add(value)
    return sorted(matches)

def claim_evidence_verify(root, snapshots, directories, missing=False):
    for relative, snapshot in snapshots:
        output_contract_verify_snapshot(snapshot.get("root", root), relative, snapshot)
    for relative, identity in directories:
        directory = output_contract_path(root, relative, directory=True)
        info = os.stat(directory)
        if identity != (info.st_dev, info.st_ino):
            raise ValueError("claim 引用目录身份发生变化")
    if missing:
        try:
            output_contract_path(root, "paper/claims.md")
        except FileNotFoundError:
            return
        raise ValueError("claim 文件在核验期间出现")

def checked_claim_evidence(root, summary):
    plan, revision = archive_evidence_identity(summary)
    durable_plan_path(plan, "claim Plan")
    snapshots, directories, missing = ProjectAggregateSnapshots(), [], False
    try:
        snapshot = output_contract_read_snapshot(root, "paper/claims.md")
    except FileNotFoundError:
        missing = True
    else:
        snapshots.append(("paper/claims.md", snapshot))
    catalog = {"sources": [], "keys": []} if missing else claim_evidence_catalog(root, summary, snapshots)
    rows = []
    if not missing:
        claims = parse_claim_lines(snapshot["text"])
        if len(claims) > 4000:
            raise ValueError("claim 行数超出预算")
        for claim in claims:
            text = claim["text"]
            if len(claim["raw"].encode("utf-8")) > 16384:
                raise ValueError("claim 单行超出预算")
            refs = claim_evidence_refs(claim["raw"])
            existing = [ref for ref in refs if claim_evidence_ref_is_current(root, ref, catalog, directories)]
            keys = claim_evidence_key_matches(claim["raw"], catalog)
            lowered = text.lower()
            if re.search(r"\b(needs?\s+experiment|todo|tbd|unsupported)\b|待实验|需要实验|缺证据|未支持", lowered):
                status = "needs experiment" if any(word in lowered for word in ("need", "todo", "tbd", "待实验", "需要实验")) else "unsupported"
            else:
                status = "supported" if existing or keys else "unsupported" if refs or catalog["sources"] else "needs experiment"
            rows.append({"claimId": sha256_text(str(claim["line"]) + ":" + text)[:16], "line": claim["line"], "text": text,
                         "status": status, "evidenceRefs": existing, "missingRefs": [ref for ref in refs if ref not in existing], "matchedKeys": keys})
    counts = {status: sum(row["status"] == status for row in rows) for status in ("supported", "unsupported", "needs experiment")}
    status = "needs_claims_file" if missing else "passed" if rows and counts["supported"] == len(rows) else "needs experiment" if counts["needs experiment"] else "unsupported" if counts["unsupported"] else "empty"
    relative = plan_results_artifact_relpath(plan, "claim_evidence.json", strict_plan=True)
    report = {"schemaVersion": 1, "status": status, "message": "claim 证据关联已核验，不代表科学结论已验证。" if status == "passed" else "缺少当前可信 claim 证据，请核对原始路径、Plan 与归档。",
              "generatedAt": now_iso(), "claimsPath": "paper/claims.md", "claimCount": len(rows), "supportedCount": counts["supported"],
              "unsupportedCount": counts["unsupported"], "needsExperimentCount": counts["needs experiment"], "claims": rows,
              "evidenceSources": catalog["sources"], "planFile": plan, "planRevision": revision, "resultPathIdentity": "posix-v1", "path": relative}
    claim_evidence_verify(root, snapshots, directories, missing)
    for target in (relative, "simple_cluster/results/claim_evidence.json"):
        full = worker_plan_project_path(root, target)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        atomic_write(full, report)
    return report
`;
