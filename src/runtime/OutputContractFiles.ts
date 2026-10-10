/** Read-only POSIX input boundary for explicit Plan output-contract checks.
 * Included in the Agent; other actions retain their established entry points.
 */
export const OUTPUT_CONTRACT_FILES_PYTHON = String.raw`
def output_contract_path(root, relative, directory=False):
    durable_plan_path(relative, "输出契约来源")
    if any(part in (".ssh", "id_rsa", "id_ed25519", "known_hosts") or part.endswith(".pem") for part in relative.split("/")):
        raise ValueError("输出契约来源包含受保护路径")
    return worker_plan_project_path(root, relative, require_file=True, directory=directory)

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
        snapshot["text"] = b"".join(chunks).decode("utf-8-sig", errors="strict")
        return snapshot
    finally:
        os.close(descriptor)

def output_contract_read_text(root, relative):
    return output_contract_read_snapshot(root, relative)["text"]

def output_contract_candidate(value, pattern=False):
    try:
        durable_plan_path(value, "输出契约候选")
        candidate = re.sub(r"\{[^}]+\}", "*", value) if pattern else value
        durable_plan_path(candidate, "输出契约候选")
    except (ValueError, UnicodeError):
        return ""
    parts = candidate.split("/")
    lower = [part.lower() for part in parts]
    base = lower[-1].strip()
    if not re.search(r"\.(csv|json|txt|log|out)$", base):
        return ""
    eligible = (base in RESULT_ROOT_FILES or tuple([*lower[:-1], base]) in RESULT_EXACT_PAIRS
                or len(parts) >= 2 and (lower[0] in RESULT_TOP_DIRS or tuple(lower[:2]) in RESULT_PREFIX_PAIRS))
    if (not eligible or candidate.lower() in IGNORED_RESULT_FILES or base in NON_RESULT_METADATA_FILES
            or candidate.lower().startswith("simple_cluster/results/")
            or re.search(r"(?:_snapshot|_manifest|_status|_state|_progress)\.json$", base)):
        return ""
    return candidate

def output_contract_directory(value):
    try:
        durable_plan_path(value, "输出契约目录")
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
    return {"plan": plan, "suite": suite, "candidates": sorted(out), "snapshot": snapshot}

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
