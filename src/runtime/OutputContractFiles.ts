/** Read-only POSIX input boundary for explicit Plan output-contract checks.
 * Included in the Agent; other actions retain their established entry points.
 */
export const OUTPUT_CONTRACT_FILES_PYTHON = String.raw`
def result_io_relative_path(value, label):
    if (not isinstance(value, str) or not value or len(value.encode("utf-8")) > 4096
            or value.startswith("/") or ":" in value or chr(92) in value
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise ValueError(label + " 必须是保留真实拼写的项目内规范相对 POSIX 路径")
    return value

def result_io_path(value, label, allow_absolute=False, allow_empty=False):
    if value == "" and allow_empty:
        return value
    if allow_absolute and isinstance(value, str) and value.startswith("/") and not value.startswith("//"):
        result_io_relative_path(value[1:], label)
        return value
    return result_io_relative_path(value, label)

def result_io_project_path(root, value, require_file=False, directory=False):
    result_io_path(value, "Worker Plan 路径", allow_absolute=True)
    root_abs = os.path.abspath(root)
    real_root = os.path.realpath(root_abs)
    if not stat.S_ISDIR(os.stat(root_abs).st_mode):
        raise ValueError("Worker 项目根目录不是现有目录")
    full = os.path.abspath(os.path.join(root_abs, value))
    relative = os.path.relpath(full, root_abs)
    result_io_relative_path(relative, "Worker 项目内路径")
    if os.path.commonpath([real_root, os.path.realpath(full)]) != real_root:
        raise ValueError("Worker Plan 路径越出项目")
    current = root_abs
    parts = relative.split(os.sep)
    for index, part in enumerate(parts):
        names = os.listdir(current)
        target = os.path.join(current, part)
        try:
            info = os.lstat(target)
        except FileNotFoundError:
            if require_file:
                raise
            return full
        if part not in names or stat.S_ISLNK(info.st_mode):
            raise ValueError("Worker Plan 路径条目拼写不一致或包含符号链接")
        want_directory = directory or index < len(parts) - 1
        if not (stat.S_ISDIR(info.st_mode) if want_directory else stat.S_ISREG(info.st_mode)):
            raise ValueError("Worker Plan 路径文件类型不符")
        current = target
    return full

def output_contract_request_identity(payload):
    if not isinstance(payload, dict):
        raise ValueError("输出契约请求必须是对象")
    owners = [payload]
    if payload.get("options") is not None:
        if not isinstance(payload["options"], dict):
            raise ValueError("输出契约 options 类型无效")
        owners.append(payload["options"])
    fields = {}
    for keys, target in ((["planFile", "plan_file", "plan", "selectedPlanId", "selected_plan_id"], "planFile"),
                         (["planRevision", "plan_revision"], "planRevision")):
        values = [owner[key] for owner in owners for key in keys if key in owner and owner[key] != ""]
        if any(not isinstance(value, str) or value == "-" or len(value.encode("utf-8")) > 4096
               or any(ord(char) < 32 or ord(char) == 127 for char in value) for value in values):
            raise ValueError("输出契约 " + target + " 类型或内容无效")
        if len(set(values)) > 1:
            raise ValueError("输出契约 " + target + " 别名不一致")
        if values:
            fields[target] = result_io_relative_path(values[0], "输出契约 Plan") if target == "planFile" else values[0]
    if fields.get("planFile"):
        fields["selectedPlanId"] = fields["planFile"]
    return fields

def output_contract_receipt(root, payload, operation_id, op_id):
    identity = output_contract_request_identity(payload)
    plan = identity.get("planFile") or ""
    report = check_output_contract_action(root, plan or None)
    report_identity = output_contract_request_identity(report)
    if (report_identity.get("planFile", "") != plan
            or report_identity.get("planRevision") and identity.get("planRevision")
            and report_identity["planRevision"] != identity["planRevision"]):
        raise ValueError("输出契约报告的 Plan 与请求不一致")
    status = "failed" if report.get("status") == "failed" else "completed"
    details = {"contractReport": report, "contractReportPath": report.get("path") or "simple_cluster/contracts/contract_check_reports/latest.json",
               "contractIssueType": report.get("issueType") or "", "missingCount": len(report.get("missing") or []),
               "missingFiles": report.get("missing") or [], "unparseableCount": len(report.get("unparseableFiles") or []),
               "unparseableFiles": report.get("unparseableFiles") or [], "unparseable": report.get("unparseable") or [],
               "parseableResultCount": int(report.get("parseableResultCount") or 0), **identity, "planFile": plan}
    return terminal_action(root, "check-output-contract", operation_id, op_id, status,
                           report.get("message") or report.get("status"), details, request=payload)

RESULT_READ_ACTIONS = ("check-output-contract", "run-quality-gate", "run-statistics", "export-paper-table", "check-claim-evidence", "parse-case-level", "run-leakage-check", "run-subgroup-analysis", "export-case-analysis")

def action_receipt_fields(action, request=None):
    identity = result_parse_request({} if request is None else request)[0] if action in RESULT_PARSE_ACTIONS else output_contract_request_identity({} if request is None else request) if action in RESULT_READ_ACTIONS else {}
    return {**action_operation_fields(request), **identity}


def output_contract_path(root, relative, directory=False):
    result_io_relative_path(relative, "输出契约来源")
    if any(part in (".ssh", "id_rsa", "id_ed25519", "known_hosts") or part.endswith(".pem") for part in relative.split("/")):
        raise ValueError("输出契约来源包含受保护路径")
    return result_io_project_path(root, relative, require_file=True, directory=directory)

def output_contract_file_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def output_contract_verify_snapshot(root, relative, snapshot):
    full = output_contract_path(root, relative)
    if full != snapshot["path"] or output_contract_file_identity(os.lstat(full)) != snapshot["identity"]:
        raise ValueError("输出契约来源文件身份或内容发生变化")
    for directory, identity in snapshot["directories"]:
        info = os.stat(directory)
        if not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino) != identity:
            raise ValueError("输出契约来源目录身份发生变化")
    if "sha256" in snapshot:
        # Same-size writes plus restored mtime can share one filesystem clock
        # tick. Reopen through the same bounded descriptor checks and bind bytes.
        current = output_contract_read_snapshot(root, relative, snapshot["identity"][2])
        if (current["identity"] != snapshot["identity"] or current["sha256"] != snapshot["sha256"]
                or current["directories"] != snapshot["directories"]):
            raise ValueError("输出契约来源文件内容或目录身份发生变化")

def output_contract_read_snapshot(root, relative, max_bytes=5 * 1024 * 1024):
    full = output_contract_path(root, relative)
    directories = []
    current = os.path.abspath(root)
    for part in [None, *relative.split("/")[:-1]]:
        if part is not None:
            current = os.path.join(current, part)
        info = os.stat(current)
        directories.append((current, (info.st_dev, info.st_ino)))
    before = os.lstat(full)
    if not stat.S_ISREG(before.st_mode) or before.st_size > max_bytes:
        raise ValueError("输出契约来源不是预算内普通文件")
    snapshot = {"path": full, "identity": output_contract_file_identity(before), "directories": directories}
    descriptor = os.open(full, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or output_contract_file_identity(opened) != snapshot["identity"]:
            raise ValueError("输出契约来源在打开前发生变化")
        chunks, size = [], 0
        while size <= max_bytes:
            chunk = os.read(descriptor, min(65536, max_bytes + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        if size != before.st_size or size > max_bytes or output_contract_file_identity(os.fstat(descriptor)) != snapshot["identity"]:
            raise ValueError("输出契约来源在读取期间发生变化或超限")
        output_contract_verify_snapshot(root, relative, snapshot)
        data = b"".join(chunks)
        snapshot["sha256"] = hashlib.sha256(data).hexdigest()
        snapshot["text"] = data.decode("utf-8-sig", errors="strict")
        return snapshot
    finally:
        os.close(descriptor)

def output_contract_read_text(root, relative):
    return output_contract_read_snapshot(root, relative)["text"]

def output_contract_candidate(value, pattern=False):
    try:
        result_io_relative_path(value, "输出契约候选")
        candidate = re.sub(r"\{[^}]+\}", "*", value) if pattern else value
        result_io_relative_path(candidate, "输出契约候选")
    except (ValueError, UnicodeError):
        return ""
    parts = candidate.split("/")
    lower = [part.lower() for part in parts]
    base = lower[-1].strip()
    if not re.search(r"\.(csv|json|txt|log|out)$", base):
        return ""
    eligible = (base in RESULT_ROOT_FILES or tuple([*lower[:-1], base]) in RESULT_EXACT_PAIRS or lower[:2] == ["experiments", "runs"]
                or len(parts) >= 2 and (lower[0] in RESULT_TOP_DIRS or tuple(lower[:2]) in RESULT_PREFIX_PAIRS))
    if (not eligible or candidate.lower() in IGNORED_RESULT_FILES or base in NON_RESULT_METADATA_FILES
            or candidate.lower().startswith("simple_cluster/results/")
            or re.search(r"(?:_snapshot|_manifest|_status|_state|_progress)\.json$", base)):
        return ""
    return candidate

def output_contract_directory(value):
    try:
        result_io_relative_path(value, "输出契约目录")
        return value
    except (ValueError, UnicodeError):
        return ""

def output_contract_pattern_matches(pattern, candidate):
    patterns, parts = pattern.split("/"), candidate.split("/")
    if len(patterns) > 64 or len(parts) > 64:
        raise ValueError("输出契约 glob 超出路径层级预算")
    memo = {}
    def match(left, right):
        key = (left, right)
        if key not in memo:
            if left == len(patterns):
                memo[key] = right == len(parts)
            elif patterns[left] == "**":
                memo[key] = match(left + 1, right) or right < len(parts) and match(left, right + 1)
            else:
                memo[key] = right < len(parts) and fnmatch.fnmatchcase(parts[right], patterns[left]) and match(left + 1, right + 1)
        return memo[key]
    return match(0, 0)

def output_contract_walk(root, directory, max_dirs=4000, max_depth=64):
    base = output_contract_path(root, directory, directory=True) if directory else os.path.abspath(root)
    started, count = time.monotonic(), 0
    for current, dirs, files in os.walk(base, followlinks=False):
        count += 1
        if count > max_dirs or time.monotonic() - started > 6.0:
            raise ValueError("输出契约候选扫描超出目录或时间预算")
        relative = os.path.relpath(current, root)
        if relative != ".":
            output_contract_path(root, relative, directory=True)
        depth = 0 if current == base else len(os.path.relpath(current, base).split(os.sep))
        if depth >= max_depth:
            dirs[:] = []
        else:
            safe_dirs = []
            for name in sorted(dirs):
                if name in (".git", "__pycache__", "checkpoints", "weights", "datasets", "features") or name.startswith("."):
                    continue
                child = os.path.relpath(os.path.join(current, name), root)
                try:
                    output_contract_path(root, child, directory=True)
                    safe_dirs.append(name)
                except (ValueError, OSError):
                    continue
            dirs[:] = safe_dirs
        for name in sorted(files):
            candidate = os.path.relpath(os.path.join(current, name), root)
            if not output_contract_candidate(candidate):
                continue
            try:
                file = output_contract_path(root, candidate)
                if os.lstat(file).st_size <= 5 * 1024 * 1024:
                    yield candidate
            except (ValueError, OSError):
                continue

def output_contract_expand(root, candidates, limit=240, patterns=True):
    out = []
    for raw in candidates or []:
        pattern = output_contract_candidate(raw)
        if not pattern:
            continue
        if patterns and any(char in pattern for char in "*?["):
            prefix = []
            for part in pattern.split("/"):
                if any(char in part for char in "*?["):
                    break
                prefix.append(part)
            try:
                matches = output_contract_walk(root, "/".join(prefix))
                for candidate in matches:
                    if output_contract_pattern_matches(pattern, candidate) and candidate not in out:
                        out.append(candidate)
                    if len(out) >= limit:
                        return sorted(out)
            except FileNotFoundError:
                continue
        else:
            try:
                file = output_contract_path(root, pattern)
                if os.lstat(file).st_size <= 5 * 1024 * 1024 and pattern not in out:
                    out.append(pattern)
            except (ValueError, OSError):
                continue
        if len(out) >= limit:
            break
    return sorted(out)

def output_contract_plan(root, plan, limit=240):
    snapshot = output_contract_read_snapshot(root, plan)
    try:
        import yaml
    except ImportError as exc:
        raise ValueError("检查输出契约需要当前科研 Python 环境安装 PyYAML") from exc
    try:
        for index, _token in enumerate(yaml.scan(snapshot["text"])):
            if index >= 8192:
                raise ValueError("输出契约 Plan YAML 超出 token 预算")
        document = yaml.safe_load(snapshot["text"])
    except yaml.YAMLError as exc:
        raise ValueError("输出契约 Plan YAML 无效：" + str(exc)) from exc
    if not isinstance(document, dict):
        raise ValueError("输出契约 Plan YAML 必须是对象")
    suite = document.get("suite", "")
    if suite is None:
        suite = ""
    if not isinstance(suite, str):
        raise ValueError("输出契约 Plan suite 必须是字符串")
    direct = {"result_csv", "resultCsv", "results_csv", "resultsCsv", "metrics_csv", "metricsCsv", "summary_csv", "summaryCsv",
              "output_csv", "outputCsv", "result_json", "resultJson", "metrics_json", "metricsJson", "summary_txt", "summaryTxt", "log_file", "logFile"}
    expected = {"expectedResults", "expected_results", "resultFiles", "result_files", "outputFiles", "output_files", "candidateCsv", "candidateJson", "consoleLogs", "textLogs"}
    out, active, visits = [], set(), [0]
    def add(value):
        if isinstance(value, str):
            escaped_suite = "".join({"*": "[*]", "?": "[?]", "[": "[[]"}.get(char, char) for char in suite)
            value = re.sub(r"\{([^}]+)\}", lambda match: escaped_suite if match.group(1) == "suite" and suite else "*", value)
            candidate = output_contract_candidate(value)
            if candidate and candidate not in out and len(out) < limit:
                out.append(candidate)
        elif isinstance(value, list):
            for child in value:
                add(child)
        elif isinstance(value, dict):
            for key, child in value.items():
                if key in direct or key in ("path", "file", "result", "resultFile", "result_file", "output", "outputFile", "output_file", "log"):
                    add(child)
    def visit(value, depth=0):
        visits[0] += 1
        if visits[0] > 8192 or depth > 64 or id(value) in active:
            raise ValueError("输出契约 Plan YAML 循环或超出结构预算")
        if not isinstance(value, (dict, list)):
            return
        active.add(id(value))
        if isinstance(value, dict):
            mode = normalized_experiment_mode(value.get("mode", document.get("mode", "train_test")))
            commands = ("command", "train_command", "trainCommand") if mode == "train" else ("test_command", "testCommand") if mode == "test" else ("command", "train_command", "trainCommand", "test_command", "testCommand")
            for key, child in value.items():
                visit(child, depth + 1)
                if key in direct or key in expected or key == "outputs" and isinstance(child, (list, dict)):
                    add(child)
                elif key in commands and isinstance(child, str):
                    for candidate in plan_command_result_candidates(child, strict_paths=True):
                        add(candidate)
        else:
            for child in value:
                visit(child, depth + 1)
        active.remove(id(value))
    visit(document)
    output_contract_verify_snapshot(root, plan, snapshot)
    return {"plan": plan, "suite": suite, "candidates": sorted(out), "snapshot": snapshot, "document": document}

def output_contract_discover_candidates(root, contract, limit=120):
    directories, out = [], []
    for candidate in contract["candidates"]:
        if any(char in candidate for char in "*?["):
            continue
        parent = "/".join(candidate.split("/")[:-1])
        if parent and contract["suite"] and contract["suite"] in parent.split("/") and parent not in directories:
            directories.append(parent)
    for directory in directories[:24]:
        try:
            for candidate in output_contract_walk(root, directory, max_dirs=80, max_depth=3):
                if candidate not in out:
                    out.append(candidate)
                if len(out) >= limit:
                    return sorted(out)
        except FileNotFoundError:
            continue
    return sorted(out)
`;
