/** Read-only code/config/input inspection. AST only; never imports project modules. */
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

def plan_scope_reason(relative, provenance):
    chain, seen, item = [], set(), relative
    while item and item not in seen:
        seen.add(item)
        parent, reason, _ = provenance.get(item, ("", "dependency", "input"))
        chain.append(item + " [" + reason + "]")
        item = parent
    return " -> ".join(reversed(chain))

def plan_scope_python_access(tree):
    import ast
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    frames = (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
    def enclosing(node):
        node = parents.get(node)
        while node is not None and not isinstance(node, frames): node = parents.get(node)
        return node
    names = {}
    def bind(frame, name, value): names.setdefault(frame, {}).setdefault(name, []).append(value)
    for node in ast.walk(tree):
        frame = enclosing(node)
        if isinstance(node, ast.Import):
            for alias in node.names: bind(frame, alias.asname or alias.name.split(".")[0], alias.name if alias.asname else alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names: bind(frame, alias.asname or alias.name, (node.module + "." + alias.name) if node.module and not node.level else None)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bind(frame, node.name, None)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs: bind(node, arg.arg, None)
            for arg in (node.args.vararg, node.args.kwarg):
                if arg: bind(node, arg.arg, None)
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr, ast.AugAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                for child in ast.walk(target):
                    if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store): bind(frame, child.id, node.value if isinstance(target, ast.Name) and not isinstance(node, ast.AugAssign) else None)
        elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
            for child in ast.walk(node.target):
                if isinstance(child, ast.Name): bind(frame, child.id, None)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars is not None:
                    for child in ast.walk(item.optional_vars):
                        if isinstance(child, ast.Name): bind(frame, child.id, None)
        elif isinstance(node, ast.ExceptHandler) and node.name: bind(frame, node.name, None)
    def lookup(node):
        frame = enclosing(node)
        while frame is not None:
            if node.id in names.get(frame, {}): return names[frame][node.id]
            frame = enclosing(frame)
            # Method globals do not resolve through a class's attribute namespace.
            while isinstance(frame, ast.ClassDef): frame = enclosing(frame)
        return None
    def symbol(node, seen=()):
        if node in seen: return None
        if isinstance(node, ast.Name):
            values = lookup(node)
            if values is None: return {"open": "builtins.open", "str": "builtins.str"}.get(node.id)
            resolved = [value if isinstance(value, str) else symbol(value, seen + (node,)) for value in values]
            return resolved[0] if resolved and all(value == resolved[0] for value in resolved) else None
        if isinstance(node, ast.Attribute):
            base = symbol(node.value, seen + (node,))
            return base + "." + node.attr if base else None
        return None
    def is_path(node, seen=()):
        if node in seen: return False
        seen = seen + (node,)
        if isinstance(node, ast.Name):
            values = lookup(node)
            return bool(values) and all(is_path(value, seen) for value in values)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div): return is_path(node.left, seen)
        if isinstance(node, ast.Attribute) and node.attr == "parent": return is_path(node.value, seen)
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute) and node.value.attr == "parents": return is_path(node.value.value, seen)
        if isinstance(node, ast.Call):
            if symbol(node.func) in ("pathlib.Path", "pathlib.PosixPath", "pathlib.WindowsPath"): return True
            return isinstance(node.func, ast.Attribute) and node.func.attr in ("resolve", "absolute", "expanduser", "joinpath", "with_name", "with_suffix") and is_path(node.func.value, seen)
        return False
    return symbol, is_path, lookup

def plan_source_scope(root, plan_file, revision, inventory=(), provenance=None):
    import ast
    import itertools
    import shlex
    import yaml
    provenance = provenance if provenance is not None else {}
    provenance[plan_file] = ("", "PLAN", "config")
    def fail(code, relative):
        raise ValueError(code + ": " + relative + "; dependency chain: " + plan_scope_reason(relative, provenance))
    plan_path = plan_scope_path(root, plan_file)
    if not os.path.isfile(plan_path): fail("PLAN_SOURCE_MISSING", plan_file)
    if os.path.getsize(plan_path) > 2 * 1024 * 1024:
        fail("PLAN_SOURCE_FILE_TOO_LARGE", plan_file)
    data = pathlib.Path(plan_path).read_bytes()
    if hashlib.sha256(data).hexdigest() != revision:
        fail("PLAN_SOURCE_CHANGED", plan_file)
    files, pending, tokens, conservative, total_bytes = set(), [(plan_file, "config")], set(), set(), 0
    processed, declared = {}, {"code": set(), "configs": set(), "inputs": set(), "integrity": set()}
    config_inputs = set()
    ranks = {"integrity": 0, "input": 1, "code": 2, "config": 2}
    python_contexts, python_access, resources_dirty, input_documents = {}, {}, True, {}
    declared_outputs = set()
    config_suffixes = (".yaml", ".yml", ".json", ".toml", ".ini", ".cfg")
    def add(relative, required=False, kind="code", parent=None, reason="import"):
        relative = relative.replace("\\", "/")
        if relative not in provenance or ranks[kind] > ranks[provenance[relative][2]]:
            provenance[relative] = (parent or plan_file, reason, kind)
        if relative in declared_outputs:
            if required: fail("PLAN_SOURCE_OUTPUT_OVERLAP", relative)
            return
        if plan_scope_generated(relative) and not required:
            return
        try:
            full = plan_scope_path(root, relative)
        except ValueError as exc:
            fail(str(exc).split(":", 1)[0], relative)
        if not os.path.isfile(full):
            if required: fail("PLAN_SOURCE_MISSING", relative)
            return
        if kind == "config": config_inputs.add(relative)
        if relative not in files or ranks[kind] > ranks[processed[relative]]:
            if (relative, kind) not in pending: pending.append((relative, kind))
    def reference(value, kind, parent, reason):
        if not isinstance(value, str) or not value:
            fail("PLAN_SOURCE_DEPENDENCY_INVALID", parent)
        if "{" in value or "$" in value:
            if not declared["inputs" if kind == "input" else "configs"]:
                fail("PLAN_SOURCE_DYNAMIC_DEPENDENCY_UNDECLARED (declare source_dependencies)", parent)
            conservative.add(parent + ": " + reason + " uses declared source_dependencies")
            return
        candidate = value.replace("\\", "/")
        if os.path.isabs(candidate):
            try: candidate = os.path.relpath(candidate, root).replace(os.sep, "/")
            except ValueError: fail("PLAN_SOURCE_PATH_INVALID", value)
        elif re.match(r"^[a-zA-Z]:", candidate):
            fail("PLAN_SOURCE_PATH_INVALID", value)
        elif not os.path.isfile(os.path.join(root, candidate)):
            candidate = os.path.normpath(os.path.join(os.path.dirname(parent), candidate)).replace(os.sep, "/")
        add(candidate, True, kind, parent, reason)
        return candidate
    def module(name, parent, reason, required=True):
        if not name or not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", name):
            return
        parts = name.split(".")
        for i in range(1, len(parts)):
            initial = "/".join(parts[:i]) + "/__init__.py"
            if os.path.isfile(os.path.join(root, initial)): add(initial, True, "code", parent, reason)
        local = "/".join(parts)
        candidates = [local + ".py", local + "/__init__.py"]
        found = [item for item in candidates if os.path.isfile(os.path.join(root, item))]
        for item in found: add(item, True, "code", parent, reason)
        if required and not found and not os.path.isdir(os.path.join(root, local)) and os.path.isdir(os.path.join(root, parts[0])):
            provenance.setdefault(candidates[0], (parent, reason, "code"))
            fail("PLAN_SOURCE_MISSING", candidates[0])
    def command(value, parent, reason):
        try: words = shlex.split(value) if isinstance(value, str) else list(value)
        except ValueError: fail("PLAN_SOURCE_COMMAND_INVALID", parent)
        for index, word in enumerate(words):
            if not isinstance(word, str): fail("PLAN_SOURCE_COMMAND_INVALID", parent)
            if word.endswith((".py", ".sh")) and not word.startswith("-"):
                reference(word, "code", parent, reason)
            if word == "-m" and index + 1 < len(words): module(words[index + 1], parent, reason)
            flag, separator, inline = word.partition("=")
            if flag in ("--config", "--cfg", "--config-file", "--config-path", "--input", "--input-file", "--data-manifest"):
                argument = inline if separator else words[index + 1] if index + 1 < len(words) else ""
                kind = "config" if flag in ("--config", "--cfg", "--config-file", "--config-path") else "input"
                if argument.startswith("{") and config_inputs and kind == "config": continue
                reference(argument, kind, parent, reason + " " + flag)
    def config_document(text, relative):
        if relative.endswith(".json"): return json.loads(text)
        if relative.endswith((".yaml", ".yml")): return yaml.safe_load(text)
        # Preserve the supported literal INI/TOML references, not arbitrary text paths.
        pairs = re.findall(r"(?m)^\s*([A-Za-z_][\w.-]*)\s*[=:]\s*(.+)$", text)
        return {key: yaml.safe_load(value) for key, value in pairs}
    output_keys = {"naming", "paper", "expectedresults", "expected_results", "outputs", "results", "logging", "logs", "output_dir", "output_path", "result_csv", "result_file", "results_csv", "metrics_csv", "log_dir", "log_path", "artifact_manifest", "operation_manifest", "checkpoint_path", "weights_path"}
    metadata_keys = {"metadata", "documentation", "publication", "report", "reports", "references", "design"}
    config_keys = {"base_config", "base_configs", "defaults_from", "_base_", "config", "config_file", "configs", "include", "includes", "extends"}
    input_keys = {"input", "inputs", "input_file", "input_files", "input_path", "input_paths", "data_manifest", "dataset_manifest"}
    def scalar_paths(value):
        if isinstance(value, str): return [value]
        if isinstance(value, list): return [item for child in value for item in scalar_paths(child)]
        return []
    def config_references(document, relative, active=()):
        if isinstance(document, (dict, list)) and id(document) in active:
            fail("PLAN_SOURCE_CONFIG_CYCLE", relative)
        active = active + (id(document),)
        if isinstance(document, list):
            for item in document: config_references(item, relative, active)
        elif isinstance(document, dict):
            for key, value in document.items():
                key = str(key).lower()
                if key == "source_dependencies": continue
                if key in output_keys or key.startswith(("output_", "result_", "log_")):
                    if relative == plan_file: declared_outputs.update(scalar_paths(value))
                    continue
                if key in metadata_keys: continue
                if key == "command" or key.endswith("_command"):
                    command(value, relative, key)
                elif key in config_keys or key.endswith(("_config", "_config_file")):
                    for candidate in scalar_paths(value): reference(candidate, "code" if candidate.endswith((".py", ".sh")) else "config", relative, "config field " + key)
                elif key in input_keys:
                    for candidate in scalar_paths(value): reference(candidate, "input", relative, "input field " + key)
                elif key in ("imports", "custom_imports"):
                    if isinstance(value, dict): config_references(value, relative, active)
                    else:
                        for name in scalar_paths(value): module(name, relative, "config import " + key)
                elif isinstance(value, (dict, list)): config_references(value, relative, active)
    def resource_reads():
        functions, bindings, effects = {}, {}, {}
        for file, (tree, evaluate, parents, assignments) in python_contexts.items():
            package = file.split("/")[:-1]
            names = {}
            for node in tree.body:
                if isinstance(node, ast.FunctionDef):
                    functions[(file, node.name)] = node
                    names[node.name] = (file, node.name)
                elif isinstance(node, ast.ImportFrom):
                    base = package[:len(package)-node.level+1] if node.level else []
                    base += node.module.split(".") if node.module else []
                    for alias in node.names: names[alias.asname or alias.name] = ".".join(base + [alias.name])
                elif isinstance(node, ast.Import):
                    for alias in node.names: names[alias.asname or alias.name.split(".")[0]] = alias.name if alias.asname else alias.name.split(".")[0]
            bindings[file] = names
        qualified = {}
        for key in functions:
            file, name = key
            prefix = file[:-3].replace("/", ".")
            if prefix.endswith(".__init__"): prefix = prefix[:-9]
            qualified[prefix + "." + name] = key
        def called(file, node):
            if isinstance(node, ast.Name): value = bindings[file].get(node.id)
            elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
                base = bindings[file].get(node.value.id)
                value = base + "." + node.attr if isinstance(base, str) else None
            else: value = None
            return qualified.get(value) if isinstance(value, str) else value
        def call_argument(node, index, function):
            if index < len(node.args): return node.args[index]
            parameters = function.args.posonlyargs + function.args.args
            if index < len(parameters):
                return next((keyword.value for keyword in node.keywords if keyword.arg == parameters[index].arg), None)
            return None
        def parameter(file, node, function, seen=()):
            if isinstance(node, ast.Name):
                parameters = function.args.posonlyargs + function.args.args
                direct = next((i for i, arg in enumerate(parameters) if arg.arg == node.id), None)
                if direct is not None or node.id in seen: return direct
                values = [item.value for item in ast.walk(function) if isinstance(item, ast.Assign) and any(isinstance(target, ast.Name) and target.id == node.id for target in item.targets)]
                forwarded = {parameter(file, value, function, seen + (node.id,)) for value in values}
                return next(iter(forwarded)) if len(forwarded) == 1 else None
            if isinstance(node, ast.Call):
                name = python_access[file][0](node.func)
                if name in ("pathlib.Path", "pathlib.PosixPath", "pathlib.WindowsPath", "builtins.str") and node.args: return parameter(file, node.args[0], function, seen)
            return None
        unknown_access = {}
        def reader(file, node):
            if not isinstance(node, ast.Call): return None
            if called(file, node.func) in functions: return None
            name = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ""
            symbol, is_path = python_access[file][:2]
            file_open = symbol(node.func) in ("builtins.open", "io.open")
            if not file_open and name not in ("open", "read_text", "read_bytes", "load_config", "read_config", "fromfile", "read_json", "read_csv"): return None
            bound = isinstance(node.func, ast.Attribute) and name in ("open", "read_text", "read_bytes") and is_path(node.func.value)
            evaluate, parents = python_contexts[file][1:3]
            kind, structured, cursor = ("config" if name in ("load_config", "read_config", "fromfile") else "input"), name in ("read_json", "read_csv"), node
            while cursor in parents and not isinstance(parents[cursor], ast.FunctionDef):
                cursor = parents[cursor]
                if isinstance(cursor, ast.Call):
                    outer = cursor.func.attr if isinstance(cursor.func, ast.Attribute) else cursor.func.id if isinstance(cursor.func, ast.Name) else ""
                    if outer in ("sha256", "sha512", "sha1", "md5", "blake2b", "blake2s"): kind = "integrity"
                    if outer in ("load", "loads", "safe_load"): structured = True
            if not file_open and name in ("open", "read_text", "read_bytes") and not bound:
                unknown_access[(file, node.lineno)] = (kind, "unresolved file API/receiver")
                return None
            path_keywords = ("file",) if file_open else ("file", "path", "filename", "config_file")
            input_node = node.func.value if bound else node.args[0] if node.args else next((keyword.value for keyword in node.keywords if keyword.arg in path_keywords), None)
            if file_open or name == "open":
                offset = 0 if bound else 1
                positional = node.args[offset] if len(node.args) > offset else None
                keyword = next((item.value for item in node.keywords if item.arg == "mode"), None)
                if positional is not None and keyword is not None or file_open and node.args and any(item.arg == "file" for item in node.keywords):
                    fail("PLAN_SOURCE_OPEN_ARGUMENT_INVALID (line " + str(node.lineno) + ")", file)
                dynamic_arguments = any(isinstance(arg, ast.Starred) for arg in node.args) or any(item.arg is None for item in node.keywords)
                mode = positional if positional is not None else keyword
                modes = [] if dynamic_arguments else evaluate(mode) if mode is not None else ["r"]
                if not modes:
                    unknown_access[(file, node.lineno)] = (kind, "unresolved open mode/arguments")
                else:
                    for value in modes:
                        if not value or set(value) - set("rwaxbt+") or len(set(value)) != len(value) or sum(char in value for char in "rwax") != 1 or "b" in value and "t" in value:
                            fail("PLAN_SOURCE_OPEN_MODE_INVALID (line " + str(node.lineno) + ")", file)
                    # '+' may consume existing bytes (notably a+); retain input checking.
                    if all("r" not in value and "+" not in value for value in modes): return None
                if dynamic_arguments: input_node = None
            if input_node is None:
                unknown_access[(file, node.lineno)] = (kind, "unresolved file path/arguments")
                return None
            return input_node, kind, structured
        for key, function in functions.items():
            effects[key] = set()
            for node in ast.walk(function):
                read = reader(key[0], node)
                index = parameter(key[0], read[0], function) if read else None
                if index is not None: effects[key].add((index, read[1], read[2]))
        changed = True
        while changed:
            changed = False
            for key, function in functions.items():
                for node in ast.walk(function):
                    if not isinstance(node, ast.Call): continue
                    for index, kind, structured in effects.get(called(key[0], node.func), ()):
                        callee = functions[called(key[0], node.func)]
                        forwarded = parameter(key[0], call_argument(node, index, callee), function)
                        effect = (forwarded, kind, structured)
                        if forwarded is not None and effect not in effects[key]: effects[key].add(effect); changed = True
        unresolved, results, digest_calls = [], {}, {}
        for file, (tree, evaluate, parents, assignments) in python_contexts.items():
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call): continue
                reads = []
                read = reader(file, node)
                if read: reads.append(read)
                for index, kind, structured in effects.get(called(file, node.func), ()):
                    reads.append((call_argument(node, index, functions[called(file, node.func)]), kind, structured))
                for argument, kind, structured in reads:
                    cursor = node
                    while cursor in parents and not isinstance(cursor, ast.FunctionDef): cursor = parents[cursor]
                    values = evaluate(argument)
                    if not values and isinstance(cursor, ast.FunctionDef) and parameter(file, argument, cursor) is not None: continue
                    for value in values:
                        target = reference(value, kind, file, kind + " read line " + str(node.lineno))
                        if kind == "input" and structured and target: results.setdefault((file, node), set()).add(target)
                    if kind == "integrity": digest_calls.setdefault(file, []).append((node, argument))
                    if not values: unresolved.append((file, node.lineno, kind))
        def documents(file, node, seen=()):
            if (file, node) in results:
                return [(target, input_documents[target]) for target in results[(file, node)] if target in input_documents]
            if isinstance(node, ast.Name) and node.id not in seen:
                return [item for value in python_contexts[file][3].get(node.id, []) for item in documents(file, value, seen + (node.id,))]
            if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
                return [(origin, value[node.slice.value]) for origin, value in documents(file, node.value, seen) if isinstance(value, dict) and node.slice.value in value]
            if isinstance(node, ast.Call) and node.args:
                name = node.func.attr if isinstance(node.func, ast.Attribute) else ""
                if name in ("load", "loads", "safe_load"): return documents(file, node.args[0], seen)
                if name == "get" and isinstance(node.args[0], ast.Constant):
                    return [(origin, value[node.args[0].value]) for origin, value in documents(file, node.func.value, seen) if isinstance(value, dict) and node.args[0].value in value]
            return []
        manifest_calls = set()
        for file, (tree, evaluate, parents, assignments) in python_contexts.items():
            for loop in ast.walk(tree):
                if not isinstance(loop, ast.For): continue
                iterator = loop.iter
                if isinstance(iterator, ast.Call) and isinstance(iterator.func, ast.Attribute) and iterator.func.attr in ("items", "keys"): iterator = iterator.func.value
                key = loop.target.elts[0] if isinstance(loop.target, ast.Tuple) and loop.target.elts else loop.target
                if not isinstance(key, ast.Name): continue
                loop_nodes = set(ast.walk(loop))
                consumers = [node for node, value in digest_calls.get(file, []) if node in loop_nodes and any(isinstance(item, ast.Name) and item.id == key.id for item in ast.walk(value))]
                if not consumers: continue
                for origin, value in documents(file, iterator):
                    if not isinstance(value, dict) or not value or not all(isinstance(path, str) and isinstance(digest, str) and re.fullmatch(r"[a-fA-F0-9]{64}", digest) for path, digest in value.items()): continue
                    for path in value: add(path, True, "integrity", origin, "consumed path-to-digest manifest at " + file + ":" + str(loop.lineno))
                    manifest_calls.update((file, node.lineno) for node in consumers)
        if pending: return
        for (file, line), (kind, reason) in unknown_access.items():
            group = "integrity" if kind == "integrity" else "inputs"
            if not declared[group]: fail("PLAN_SOURCE_DYNAMIC_DEPENDENCY_UNDECLARED (" + reason + " line " + str(line) + "; declare source_dependencies." + group + ")", file)
            conservative.add(file + ": " + reason + " line " + str(line) + " bounded by source_dependencies." + group)
        for file, line, kind in unresolved:
            covered = (declared["integrity"] or (file, line) in manifest_calls) if kind == "integrity" else (declared["inputs"] if kind == "input" else declared["configs"] or config_inputs)
            if not covered: fail("PLAN_SOURCE_DYNAMIC_DEPENDENCY_UNDECLARED (declare source_dependencies." + ("integrity" if kind == "integrity" else "inputs/configs") + ")", file)
            conservative.add(file + ": dynamic " + kind + " read line " + str(line) + " bounded by declared dependencies")
    # Config inheritance and commands are resolved before Python dynamic imports.
    while pending or resources_dirty:
        if not pending:
            resources_dirty = False
            resource_reads()
            continue
        relative, kind = pending.pop(0)
        if relative in processed and ranks[processed[relative]] >= ranks[kind]:
            continue
        if relative not in files and len(files) >= 4096:
            fail("PLAN_SOURCE_SCOPE_TOO_LARGE", relative)
        full = plan_scope_path(root, relative)
        if os.path.getsize(full) > 2 * 1024 * 1024:
            fail("PLAN_SOURCE_FILE_TOO_LARGE", relative)
        raw = pathlib.Path(full).read_bytes()
        if relative not in files: total_bytes += len(raw)
        if total_bytes > 32 * 1024 * 1024:
            fail("PLAN_SOURCE_SCOPE_BYTES_LIMIT", relative)
        if len(raw) > 2 * 1024 * 1024:
            fail("PLAN_SOURCE_FILE_TOO_LARGE", relative)
        files.add(relative)
        processed[relative] = kind
        resources_dirty = True
        if kind in ("input", "integrity"):
            if kind == "input" and relative.endswith(".json"):
                try: document = json.loads(raw)
                except (ValueError, UnicodeDecodeError): document = None
                input_documents[relative] = document
            continue
        text = raw.decode("utf-8-sig")
        if kind == "config" and relative.endswith(config_suffixes):
            for value in re.findall(r"[A-Za-z_][A-Za-z0-9_.-]*", text):
                if len(tokens) < 256: tokens.add(value)
            document = config_document(text, relative)
            if relative == plan_file and isinstance(document, dict) and "source_dependencies" in document:
                explicit = document["source_dependencies"]
                if not isinstance(explicit, dict) or any(key not in declared for key in explicit): fail("PLAN_SOURCE_DECLARATION_INVALID", relative)
                for group, values in explicit.items():
                    if not isinstance(values, list) or any(not isinstance(value, str) or not value for value in values): fail("PLAN_SOURCE_DECLARATION_INVALID", relative)
                    declared[group].update(values)
                    for value in values: add(value, True, {"code": "code", "configs": "config", "inputs": "input", "integrity": "integrity"}[group], relative, "source_dependencies." + group)
            config_references(document, relative)
        if relative.endswith(".sh"):
            for line in text.splitlines():
                if line.strip() and not line.lstrip().startswith("#"): command(line, relative, "shell command")
        if not relative.endswith(".py"):
            continue
        tree = ast.parse(text, filename=relative)
        python_access[relative] = plan_scope_python_access(tree)
        package = relative.split("/")[:-1]
        assignments = {}
        parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name): assignments.setdefault(target.id, []).append(node.value)
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
                assignments.setdefault(node.target.id, []).append(node.value)
        def strings(node, seen=(), source_file=relative, names=assignments, expand=False):
            if isinstance(node, ast.Constant) and isinstance(node.value, str): return [node.value]
            if isinstance(node, ast.Name):
                if node.id == "__file__": return [source_file]
                if node.id in seen: return []
                values = python_access[source_file][2](node) or []
                choices = [strings(item, seen + (node.id,), source_file, names, expand) for item in values]
                return [value for values in choices for value in values] if choices and all(choices) else []
            if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Div, ast.Add)):
                left, right = strings(node.left,seen,source_file,names,expand), strings(node.right,seen,source_file,names,expand)
                if len(left)*len(right) <= 256:
                    return [os.path.normpath(os.path.join(a,b)).replace(os.sep,"/") if isinstance(node.op,ast.Div) else a+b for a in left for b in right]
            if isinstance(node, ast.Attribute) and node.attr == "parent":
                return [os.path.dirname(v) for v in strings(node.value,seen,source_file,names,expand)]
            if isinstance(node, ast.Subscript) and isinstance(node.value,ast.Attribute) and node.value.attr == "parents" and isinstance(node.slice,ast.Constant) and isinstance(node.slice.value,int) and 0 <= node.slice.value < 12:
                values = strings(node.value.value,seen,source_file,names,expand)
                for _ in range(node.slice.value+1): values=[os.path.dirname(v) for v in values]
                return values
            if isinstance(node, ast.Call):
                called = node.func.attr if isinstance(node.func,ast.Attribute) else node.func.id if isinstance(node.func,ast.Name) else ""
                path_constructor = python_access[source_file][0](node.func) in ("pathlib.Path", "pathlib.PosixPath", "pathlib.WindowsPath")
                path_join = called == "joinpath" or called == "join" and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Attribute) and node.func.value.attr == "path"
                if path_constructor and len(node.args) > 1 or path_join:
                    arguments = ([node.func.value] if called == "joinpath" else []) + list(node.args)
                    choices = [strings(value,seen,source_file,names,expand) for value in arguments]
                    combinations = 1
                    for values in choices: combinations *= len(values)
                    if choices and all(choices) and combinations <= 256:
                        return [os.path.normpath(os.path.join(*values)).replace(os.sep,"/") for values in itertools.product(*choices)]
                    return []
                if path_constructor or called in ("str","resolve","absolute","as_posix"):
                    return strings(node.args[0],seen,source_file,names,expand) if node.args else strings(node.func.value,seen,source_file,names,expand) if isinstance(node.func,ast.Attribute) else []
            if isinstance(node, ast.JoinedStr):
                choices = [[part.value] if isinstance(part, ast.Constant) else strings(part.value,seen,source_file,names,expand) or (sorted(tokens) if expand else []) for part in node.values]
                if len([part for part in node.values if not isinstance(part, ast.Constant)]) <= 1:
                    return ["".join(v) for v in itertools.product(*choices)]
            return []
        python_contexts[relative] = (tree, strings, parents, assignments)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names: module(alias.name, relative, "import line " + str(node.lineno))
            elif isinstance(node, ast.ImportFrom):
                base = package[:len(package)-node.level+1] if node.level else []
                base += node.module.split(".") if node.module else []
                module(".".join(base), relative, "import line " + str(node.lineno))
                for alias in node.names:
                    if alias.name != "*": module(".".join(base + [alias.name]), relative, "import attribute line " + str(node.lineno), False)
            elif isinstance(node, ast.Call) and node.args:
                name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ""
                if name in ("import_module", "__import__", "spec_from_file_location"):
                    expression = node.args[1] if name == "spec_from_file_location" and len(node.args)>1 else node.args[0]
                    values = strings(expression)
                    if not values:
                        # Token substitution is an approximation, not an explicit missing-file declaration.
                        values = [value for value in strings(expression, expand=True) if
                                  os.path.isfile(os.path.join(root, value if name == "spec_from_file_location" else value.replace(".", "/") + ".py")) or
                                  name != "spec_from_file_location" and os.path.isdir(os.path.join(root, value.replace(".", "/")))]
                    if values:
                        for value in values:
                            if name == "spec_from_file_location":
                                if os.path.isabs(value): value=os.path.relpath(value,root).replace(os.sep,"/")
                                add(value, True, "code", relative, "dynamic code loader line " + str(node.lineno))
                            else: module(value, relative, "dynamic import line " + str(node.lineno))
                    else:
                        # An unresolved dynamic loader cannot silently omit executable code.
                        if declared["code"]:
                            conservative.add(relative + ": dynamic code loader bounded by source_dependencies.code")
                            continue
                        prefix = relative.split("/")[0] + "/" if "/" in relative else ""
                        conservative.add(relative)
                        for item in inventory:
                            if item.startswith(prefix) and item.endswith(".py"): add(item, parent=relative, reason="unresolved dynamic import: conservative code scope")
                        roots = [prefix.rstrip("/")] if prefix else sorted({p.split("/")[0] for p in inventory if "/" in p and p.endswith(".py")})
                        if not prefix:
                            for item in pathlib.Path(root).glob("*.py"): add(item.name, parent=relative, reason="unresolved dynamic import: conservative code scope")
                        for directory in roots:
                            for base, dirs, names in os.walk(plan_scope_path(root, directory), followlinks=False):
                                relbase = os.path.relpath(base, root).replace(os.sep, "/")
                                dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(base,d)) and not plan_scope_generated(relbase + "/" + d + "/child")]
                                for name in names:
                                    if name.endswith(".py"): add(relbase + "/" + name, parent=relative, reason="unresolved dynamic import: conservative code scope")
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
    provenance = {}
    paths, conservative = plan_source_scope(root, row["planFile"], row["planRevision"], manifest, provenance)
    if set(paths) != set(manifest):
        raise ValueError("PLAN_SOURCE_DEPENDENCIES_CHANGED: " + ", ".join(sorted(set(paths) ^ set(manifest))[:12]))
    for relative in paths:
        try:
            _code_sync_stat_record(root, relative, manifest[relative], verify_content=True)
        except (ValueError, OSError) as exc:
            raise ValueError(str(exc) + "; dependency chain: " + plan_scope_reason(relative, provenance)) from exc
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
        provenance = {}
        paths, _ = plan_source_scope(root, row["planFile"], row["planRevision"], original, provenance)
        if any(key not in original for key in paths):
            missing = next(key for key in paths if key not in original)
            raise ValueError("PLAN_SOURCE_ORIGINAL_DEPENDENCY_MISSING: " + missing + "; dependency chain: " + plan_scope_reason(missing, provenance))
        manifest = {key: original[key] for key in paths}
        source = {"manifest": manifest, "digest": plan_source_digest(manifest)}
    checked = verify_plan_execution_source(root, row, source)
    return {"ok": True, "compatible": True, "readOnly": True, **row, "executionSource": source,
            "fileCount": checked["fileCount"], "conservative": checked["conservative"], "queriedAt": now_iso()}
`;
