/** Read-only dependency inspection. Never imports project modules or reads model/data contents. */
export const PLAN_CODE_SCOPE_PYTHON = String.raw`
def plan_scope_path(root, relative):
    relative = str(relative or "").replace("\\", "/")
    if not relative or relative.startswith("/") or re.match(r"^[a-zA-Z]:", relative) or any(p in ("", ".", "..") for p in relative.split("/")):
        raise ValueError("PLAN_SOURCE_PATH_INVALID: " + relative)
    current = os.path.realpath(root)
    for part in relative.split("/"):
        current = os.path.join(current, part)
        if os.path.islink(current):
            raise ValueError("PLAN_SOURCE_LINK: " + relative)
    if os.path.commonpath([os.path.realpath(root), os.path.realpath(current)]) != os.path.realpath(root):
        raise ValueError("PLAN_SOURCE_ESCAPE: " + relative)
    return current

def plan_scope_generated(relative):
    parts = relative.lower().split("/")
    excluded = {"__pycache__", ".cache", "cache", "feature_cache", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".git", "node_modules", "clean_dir", "work_dir", "work_dirs", "results", "result", "runs", "logs", "log", "outputs", "output", "tmp", "temp", "wandb", "tensorboard", "raw", "processed", "patients", "subjects", "images", "features", "weights", "checkpoints"}
    return any(p in excluded for p in parts[:-1]) or relative.lower().endswith((".pyc", ".pyo", ".pending", ".writing", ".log"))

def plan_source_scope(root, plan_file, revision, inventory=()):
    import ast
    import itertools
    plan_path = plan_scope_path(root, plan_file)
    if os.path.getsize(plan_path) > 2 * 1024 * 1024:
        raise ValueError("PLAN_SOURCE_FILE_TOO_LARGE: " + plan_file)
    data = pathlib.Path(plan_path).read_bytes()
    if hashlib.sha256(data).hexdigest() != revision:
        raise ValueError("PLAN_SOURCE_CHANGED: " + plan_file)
    files, pending, tokens, conservative, total_bytes = set(), [plan_file], set(), set(), 0
    declared_outputs = set()
    config_suffixes = (".yaml", ".yml", ".json", ".toml", ".ini", ".cfg")
    def add(relative, required=False):
        relative = relative.replace("\\", "/")
        if relative in declared_outputs:
            if required: raise ValueError("PLAN_SOURCE_OUTPUT_OVERLAP: " + relative)
            return
        if plan_scope_generated(relative) and not required:
            return
        full = plan_scope_path(root, relative)
        if os.path.isfile(full) and relative not in files and relative not in pending:
            pending.append(relative)
    def module(name):
        if not name or not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", name):
            return
        parts = name.split(".")
        for i in range(1, len(parts)):
            add("/".join(parts[:i]) + "/__init__.py", True)
        add("/".join(parts) + ".py", True)
        add("/".join(parts) + "/__init__.py", True)
    # Config inheritance and commands are resolved before Python dynamic imports.
    while pending:
        relative = pending.pop(0)
        if relative in files:
            continue
        if len(files) >= 4096:
            raise ValueError("PLAN_SOURCE_SCOPE_TOO_LARGE")
        full = plan_scope_path(root, relative)
        if os.path.getsize(full) > 2 * 1024 * 1024:
            raise ValueError("PLAN_SOURCE_FILE_TOO_LARGE: " + relative)
        raw = pathlib.Path(full).read_bytes()
        total_bytes += len(raw)
        if total_bytes > 32 * 1024 * 1024:
            raise ValueError("PLAN_SOURCE_SCOPE_BYTES_LIMIT")
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("PLAN_SOURCE_FILE_TOO_LARGE: " + relative)
        text = raw.decode("utf-8-sig")
        files.add(relative)
        if relative.endswith(config_suffixes):
            for value in re.findall(r"[A-Za-z_][A-Za-z0-9_.-]*", text):
                if len(tokens) < 256: tokens.add(value)
            sections, input_lines, input_paths = [], [], []
            for line in text.splitlines():
                indent = len(line) - len(line.lstrip())
                key = re.match(r"\s*([A-Za-z_][\w.-]*)\s*:", line)
                if key:
                    while sections and sections[-1][0] >= indent: sections.pop()
                    sections.append((indent, key.group(1).lower()))
                output_keys = {"naming", "paper", "expectedresults", "expected_results", "outputs", "results", "logging", "logs", "output_dir", "output_path", "result_csv", "result_file", "results_csv", "metrics_csv", "log_dir", "log_path", "artifact_manifest", "operation_manifest", "checkpoint_path", "weights_path"}
                output = any(key in output_keys or key.startswith(("output_", "result_", "log_")) for _,key in sections)
                if output:
                    if relative == plan_file:
                        declared_outputs.update(re.findall(r"[A-Za-z_][A-Za-z0-9_./-]*\.(?:yaml|yml|json|csv|log)\b", line))
                else:
                    input_lines.append(line)
                    if sections and (sections[-1][1] == "command" or sections[-1][1].endswith("_command")):
                        input_paths.extend(re.findall(r"[A-Za-z_][A-Za-z0-9_./-]*\.(?:py|sh)\b", line))
                        input_paths.extend(re.findall(r"--(?:config|cfg|config-file)(?:=|\s+)[\"']?([A-Za-z_][A-Za-z0-9_./-]*\.(?:yaml|yml|json|toml|cfg|ini))\b", line))
                    else:
                        input_paths.extend(re.findall(r"[A-Za-z_][A-Za-z0-9_./-]*\.(?:yaml|yml|json|toml|ini|cfg|py|sh)\b", line))
            inputs = "\n".join(input_lines)
            for candidate in input_paths:
                if not os.path.isfile(os.path.join(root, candidate)):
                    candidate = os.path.relpath(os.path.join(os.path.dirname(full), candidate), root).replace(os.sep, "/")
                if not candidate.startswith("../"): add(candidate, True)
            for name in re.findall(r"(?:^|\s)-m\s+([A-Za-z_][A-Za-z0-9_.]*)", inputs): module(name)
        if not relative.endswith(".py"):
            continue
        tree = ast.parse(text, filename=relative)
        package = relative.split("/")[:-1]
        assignments = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name): assignments.setdefault(target.id, []).append(node.value)
        def strings(node, seen=()):
            if isinstance(node, ast.Constant) and isinstance(node.value, str): return [node.value]
            if isinstance(node, ast.Name):
                if node.id == "__file__": return [relative]
                return [] if node.id in seen else [v for item in assignments.get(node.id, []) for v in strings(item, seen + (node.id,))]
            if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Div, ast.Add)):
                left, right = strings(node.left,seen), strings(node.right,seen)
                if len(left)*len(right) <= 256:
                    return [os.path.normpath(os.path.join(a,b)).replace(os.sep,"/") if isinstance(node.op,ast.Div) else a+b for a in left for b in right]
            if isinstance(node, ast.Attribute) and node.attr == "parent":
                return [os.path.dirname(v) for v in strings(node.value,seen)]
            if isinstance(node, ast.Subscript) and isinstance(node.value,ast.Attribute) and node.value.attr == "parents" and isinstance(node.slice,ast.Constant) and isinstance(node.slice.value,int) and 0 <= node.slice.value < 12:
                values = strings(node.value.value,seen)
                for _ in range(node.slice.value+1): values=[os.path.dirname(v) for v in values]
                return values
            if isinstance(node, ast.Call):
                called = node.func.attr if isinstance(node.func,ast.Attribute) else node.func.id if isinstance(node.func,ast.Name) else ""
                if called in ("Path","str","resolve","absolute","as_posix"):
                    return strings(node.args[0],seen) if node.args else strings(node.func.value,seen) if isinstance(node.func,ast.Attribute) else []
            if isinstance(node, ast.JoinedStr):
                choices = [[part.value] if isinstance(part, ast.Constant) else sorted(tokens) for part in node.values]
                if len([part for part in node.values if not isinstance(part, ast.Constant)]) <= 1:
                    return ["".join(v) for v in itertools.product(*choices)]
            return []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names: module(alias.name)
            elif isinstance(node, ast.ImportFrom):
                base = package[:len(package)-node.level+1] if node.level else []
                base += node.module.split(".") if node.module else []
                module(".".join(base))
                for alias in node.names:
                    if alias.name != "*": module(".".join(base + [alias.name]))
            elif isinstance(node, ast.Call) and node.args:
                name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ""
                if name in ("import_module", "__import__", "spec_from_file_location"):
                    values = strings(node.args[1] if name == "spec_from_file_location" and len(node.args)>1 else node.args[0])
                    if values:
                        for value in values:
                            if name == "spec_from_file_location":
                                if os.path.isabs(value): value=os.path.relpath(value,root).replace(os.sep,"/")
                                add(value, True)
                            else: module(value)
                    else:
                        # An unresolved dynamic loader cannot silently omit executable code.
                        prefix = relative.split("/")[0] + "/" if "/" in relative else ""
                        conservative.add(relative)
                        for item in inventory:
                            if item.startswith(prefix) and item.endswith(".py"): add(item)
                        roots = [prefix.rstrip("/")] if prefix else sorted({p.split("/")[0] for p in inventory if "/" in p and p.endswith(".py")})
                        if not prefix:
                            for item in pathlib.Path(root).glob("*.py"): add(item.name)
                        for directory in roots:
                            for base, dirs, names in os.walk(plan_scope_path(root, directory), followlinks=False):
                                relbase = os.path.relpath(base, root).replace(os.sep, "/")
                                dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(base,d)) and not plan_scope_generated(relbase + "/" + d + "/child")]
                                for name in names:
                                    if name.endswith(".py"): add(relbase + "/" + name)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                value = node.value
                if value.endswith(config_suffixes) and "{" not in value and "$" not in value and not value.startswith(("/", "../")):
                    add(value)
    return sorted(files), sorted(conservative)

def plan_source_digest(manifest):
    return hashlib.sha256(json.dumps([[key, {"size": manifest[key]["size"], "sha256": manifest[key]["sha256"]}] for key in sorted(manifest)], separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()

def verify_plan_execution_source(root, row, source):
    manifest = source.get("manifest") if isinstance(source, dict) else None
    if not isinstance(manifest, dict) or not manifest or len(manifest) > 4096 or plan_source_digest(manifest) != source.get("digest"):
        raise ValueError("PLAN_SOURCE_BASELINE_INVALID")
    if len(json.dumps(source, ensure_ascii=False).encode("utf-8")) > 65536:
        raise ValueError("PLAN_SOURCE_WINDOW_INPUT_LIMIT")
    if manifest.get(row["planFile"], {}).get("sha256") != row["planRevision"]:
        raise ValueError("PLAN_SOURCE_REVISION_MISMATCH")
    paths, conservative = plan_source_scope(root, row["planFile"], row["planRevision"], manifest)
    if set(paths) != set(manifest):
        raise ValueError("PLAN_SOURCE_DEPENDENCIES_CHANGED: " + ", ".join(sorted(set(paths) ^ set(manifest))[:12]))
    for relative in paths:
        _code_sync_stat_record(root, relative, manifest[relative], verify_content=True)
    return {"schemaVersion": 1, "files": [{"path": key, **manifest[key]} for key in paths], "fileCount": len(paths), "conservative": conservative}

def inspect_plan_code_scope(root, request):
    row = {key: str(request.get(key) or "") for key in ("projectId", "planFile", "planRevision", "codeFingerprint")}
    if not all(row.values()):
        raise ValueError("PLAN_SOURCE_IDENTITY_REQUIRED")
    source = request.get("executionSource")
    if not source:
        proofs = code_sync_proof_document(root).get("proofs", {})
        proof = next((p for p in reversed(list(proofs.values())) if p.get("projectId") == row["projectId"] and p.get("codeFingerprint") == row["codeFingerprint"]), None)
        if not proof:
            windows = task_inventory(root) if "task_inventory" in globals() else []
            original = next((p.get("executionSource") for p in windows if p.get("projectId") == row["projectId"] and p.get("planFile") == row["planFile"] and p.get("planRevision") == row["planRevision"] and p.get("codeFingerprint") == row["codeFingerprint"] and p.get("executionSource")), None)
            if original:
                checked = verify_plan_execution_source(root, row, original)
                return {"ok": True, "compatible": True, "readOnly": True, **row, "executionSource": original, "fileCount": checked["fileCount"], "conservative": checked["conservative"], "queriedAt": now_iso()}
            raise ValueError("PLAN_SOURCE_ORIGINAL_HASH_UNAVAILABLE")
        original = {item["path"]: {"size": item["size"], "sha256": item["sha256"]} for item in proof["files"]}
        if durable_code_manifest_digest(original) != row["codeFingerprint"]:
            raise ValueError("PLAN_SOURCE_ORIGINAL_HASH_INVALID")
        paths, _ = plan_source_scope(root, row["planFile"], row["planRevision"], original)
        if any(key not in original for key in paths):
            raise ValueError("PLAN_SOURCE_ORIGINAL_DEPENDENCY_MISSING")
        manifest = {key: original[key] for key in paths}
        source = {"manifest": manifest, "digest": plan_source_digest(manifest)}
    checked = verify_plan_execution_source(root, row, source)
    return {"ok": True, "compatible": True, "readOnly": True, **row, "executionSource": source,
            "fileCount": checked["fileCount"], "conservative": checked["conservative"], "queriedAt": now_iso()}
`;
