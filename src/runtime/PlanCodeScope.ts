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

def plan_scope_snapshot_protocol(tree):
    """Recognise the complete reviewed snapshot protocol, never execute its functions."""
    import ast
    import copy
    reference = ast.parse(r'''"""Store one immutable source snapshot per plan and source revision."""

from __future__ import annotations

import hashlib
import shutil
import time
from pathlib import Path


_COMMON_DIRS = (
    "data", "models", "losses", "metrics", "optimizers", "trainers", "utils",
    "experiments", "configs", "tools", "comparison_methods",
)
_COMMON_FILES = ("train.py", "test.py", "environment.yml", ".vscode/settings.json",
                 "AGENTS.md", "README.md", "docs/project-constraints.md",
                 "docs/experiment-protocol.md", "docs/plugin-project-contract.md",
                 "docs/comparison-integration.md", "docs/research-boundaries.md",
                 "docs/baseline-lock.json")
_IGNORED_DIRS = {"__pycache__", "_repos", ".runtime"}


def _source_roots(cfg) -> list[Path]:
    roots = [Path(name) for name in _COMMON_DIRS if Path(name).is_dir()]
    roots.extend(Path(name) for name in _COMMON_FILES if Path(name).is_file())
    return roots


def _selected_files(roots: list[Path]) -> list[Path]:
    files = []
    for root in roots:
        candidates = root.rglob("*") if root.is_dir() else (root,)
        for path in candidates:
            if path.is_symlink():
                raise ValueError(f"代码备份不允许符号链接：{path}")
            if (path.is_file() and not any(part in _IGNORED_DIRS for part in path.parts)
                    and (path.suffix in {".py", ".yaml"} or path.as_posix() in _COMMON_FILES)
                    and not any(part in {"results", "runs", "masks"} for part in path.parts)):
                files.append(path)
    return sorted(set(files), key=lambda path: path.as_posix())


def _plan_root(save_dir: str | Path) -> Path:
    output = Path(save_dir).resolve()
    for candidate in (output, *output.parents):
        if candidate.parent.name == "work_dirs":
            return candidate
    return output


def backup_code(save_dir: str | Path, cfg) -> Path:
    """Reuse a complete plan snapshot; different source bytes get a new revision."""
    files = _selected_files(_source_roots(cfg))
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    snapshot = _plan_root(save_dir) / "code_backup" / digest.hexdigest()[:24]
    complete = snapshot / ".complete"
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    try:
        snapshot.mkdir()
        owner = True
    except FileExistsError:
        owner = False
    if owner:
        copied_digest = hashlib.sha256()
        for source in files:
            target = snapshot / source
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            copied_digest.update(source.as_posix().encode("utf-8"))
            copied_digest.update(b"\0")
            copied_digest.update(target.read_bytes())
            copied_digest.update(b"\0")
        if copied_digest.digest() != digest.digest():
            raise RuntimeError(f"源码在备份期间发生变化：{snapshot}")
        complete.write_text(digest.hexdigest() + "\n", encoding="utf-8")
    else:
        deadline = time.monotonic() + 120
        while not complete.is_file():
            if time.monotonic() >= deadline:
                raise TimeoutError(f"代码备份未完成：{snapshot}")
            time.sleep(0.1)
        if complete.read_text(encoding="utf-8").strip() != digest.hexdigest():
            raise RuntimeError(f"代码备份指纹不一致：{snapshot}")
    Path(save_dir, "code_backup_ref.txt").write_text(str(snapshot) + "\n", encoding="utf-8")
    return snapshot
''')
    def imports(module):
        result, bound = {}, {}
        for node in module.body:
            if isinstance(node, ast.Import):
                for item in node.names:
                    name = item.asname or item.name
                    result[name] = item.name; bound[name] = bound.get(name,0)+1
            elif isinstance(node, ast.ImportFrom) and not node.level:
                for item in node.names:
                    name = item.asname or item.name
                    result[name] = (node.module or '') + '.' + item.name; bound[name] = bound.get(name,0)+1
            elif isinstance(node,(ast.Assign,ast.AnnAssign,ast.AugAssign)):
                for target in node.targets if isinstance(node,ast.Assign) else [node.target]:
                    if isinstance(target,ast.Name): bound[target.id] = bound.get(target.id,0)+1
            elif isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)):
                bound[node.name] = bound.get(node.name,0)+1
        return {name:value for name,value in result.items() if bound[name]==1}
    def normalise(function, aliases, roles, bound=()):
        value = copy.deepcopy(function)
        local = {}
        for arg in [*value.args.posonlyargs, *value.args.args, *value.args.kwonlyargs]: local.setdefault(arg.arg, '_local_' + str(len(local)))
        for node in ast.walk(value):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store): local.setdefault(node.id, '_local_' + str(len(local)))
            if isinstance(node, ast.arg): local.setdefault(node.arg, '_local_' + str(len(local)))
        class Canonical(ast.NodeTransformer):
            def visit_Name(self, node):
                node.id = local.get(node.id, roles.get(node.id, '_import_' + aliases[node.id].replace('.', '_') if node.id in aliases else '_bound_' + node.id if node.id in bound else node.id))
                return node
            def visit_arg(self, node):
                node.arg = local[node.arg]; node.annotation = None
                return node
            def visit_FunctionDef(self, node):
                node.name = '_function'; node.returns = None; node.type_comment = None
                if node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant) and isinstance(node.body[0].value.value, str): node.body = node.body[1:]
                return self.generic_visit(node)
        return ast.dump(Canonical().visit(value), include_attributes=False), local
    reference_functions = {node.name: node for node in reference.body if isinstance(node, ast.FunctionDef)}
    reference_aliases = imports(reference)
    functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    candidates = []
    for entry in functions.values():
        nodes = list(ast.walk(entry))
        methods = {node.func.attr for node in nodes if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute)}
        collectors = [node for node in nodes if isinstance(node,ast.Assign) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id in functions and len(node.value.args)==1 and isinstance(node.value.args[0],ast.Call) and isinstance(node.value.args[0].func,ast.Name) and node.value.args[0].func.id in functions]
        if collectors and {'copy2','read_bytes','hexdigest'} <= methods: candidates.append(entry)
    def unsupported(): return [{'entry':entry,'unsupported':True} for entry in candidates]
    constants, counts, bound = {}, {}, set()
    for node in tree.body:
        if isinstance(node,ast.FunctionDef): counts[node.name] = counts.get(node.name,0)+1; bound.add(node.name)
        elif isinstance(node,(ast.Import,ast.ImportFrom)):
            bound.update(item.asname or item.name.split('.')[0] for item in node.names)
        elif isinstance(node,ast.Expr) and isinstance(node.value,ast.Constant) and isinstance(node.value.value,str): pass
        elif not isinstance(node,ast.Assign): return unsupported()
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            bound.add(node.targets[0].id)
            counts[node.targets[0].id] = counts.get(node.targets[0].id,0)+1
            try: constants[node.targets[0].id] = ast.literal_eval(node.value)
            except (ValueError, TypeError): return unsupported()
        elif isinstance(node,ast.Assign): return unsupported()
    records = []
    for entry in functions.values():
        body = entry.body[1:] if entry.body and isinstance(entry.body[0], ast.Expr) and isinstance(entry.body[0].value, ast.Constant) and isinstance(entry.body[0].value.value, str) else entry.body
        # A nested collector call is necessary, but never sufficient to authorise reads.
        if not body or not isinstance(body[0], ast.Assign): continue
        collection = body[0].value
        if not isinstance(collection, ast.Call) or not isinstance(collection.func, ast.Name) or len(collection.args) != 1: continue
        root_call = collection.args[0]
        if not isinstance(root_call, ast.Call) or not isinstance(root_call.func, ast.Name): continue
        selected, roots = functions.get(collection.func.id), functions.get(root_call.func.id)
        if selected is None or roots is None: continue
        root_body = roots.body
        if len(root_body) != 3 or not isinstance(root_body[0], ast.Assign) or not isinstance(root_body[0].value, ast.ListComp): continue
        dirs = root_body[0].value.generators[0].iter
        second = root_body[1]
        if not isinstance(dirs, ast.Name) or not isinstance(second, ast.Expr) or not isinstance(second.value, ast.Call) or len(second.value.args) != 1 or not isinstance(second.value.args[0], ast.GeneratorExp): continue
        files = second.value.args[0].generators[0].iter
        if not isinstance(files, ast.Name): continue
        ignored = {node.id for node in ast.walk(selected) if isinstance(node, ast.Name) and node.id in constants and node.id != files.id}
        other_helpers = {node.func.id for node in ast.walk(entry) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in functions} - {selected.name, roots.name}
        if len(ignored) != 1 or len(other_helpers) != 1: continue
        ignored_name, plan_root = next(iter(ignored)), functions[next(iter(other_helpers))]
        roles = {entry.name:'backup_code', selected.name:'_selected_files', roots.name:'_source_roots', plan_root.name:'_plan_root', dirs.id:'_COMMON_DIRS', files.id:'_COMMON_FILES', ignored_name:'_IGNORED_DIRS'}
        if any(counts.get(name)!=1 for name in roles): continue
        aliases = imports(tree)
        if any(normalise(actual, aliases, roles, bound)[0] != normalise(reference_functions[name], reference_aliases, {})[0] for name, actual in [('backup_code',entry),('_selected_files',selected),('_source_roots',roots),('_plan_root',plan_root)]): continue
        values = [constants.get(dirs.id), constants.get(files.id), constants.get(ignored_name)]
        if any(not isinstance(items, (tuple,list,set)) or any(not isinstance(item,str) or not item for item in items) for items in values): continue
        local = normalise(entry, aliases, roles, bound)[1]
        reference_local = normalise(reference_functions['backup_code'], reference_aliases, {})[1]
        actual_name = {role: next(key for key,value in local.items() if value == reference_local[role]) for role in ('path','source','target','complete')}
        integrity, generated = set(), set()
        for node in ast.walk(entry):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute) or not isinstance(node.func.value, ast.Name): continue
            if node.func.attr == 'read_bytes' and node.func.value.id == actual_name['path']: integrity.add(node)
            if node.func.attr in ('read_bytes','read_text') and node.func.value.id in (actual_name['target'],actual_name['complete']): generated.add(node)
            if node.func.attr == 'copy2': integrity.add(node)
        records.append({'entry':entry,'collection':collection,'integrity':integrity,'generated':generated,'directories':list(values[0]),'files':list(values[1]),'ignored':set(values[2])})
    records.extend({'entry':entry,'unsupported':True} for entry in candidates if not any(record['entry'] is entry for record in records))
    return records

def plan_scope_snapshot_members(root, protocol, progress=None):
    """Enumerate the recognised selector exactly; metadata only, no project execution."""
    selected, visited = set(), 0
    def consider(relative, full):
        if os.path.islink(full): raise ValueError('PLAN_SOURCE_LINK: ' + relative + '; source snapshot selector rejects links before filtering')
        parts = relative.split('/')
        if os.path.isfile(full) and not any(part in protocol['ignored'] for part in parts) and (pathlib.Path(relative).suffix in ('.py','.yaml') or relative in protocol['files']) and not any(part in ('results','runs','masks') for part in parts): selected.add(relative)
    def scan(relative, full):
        nonlocal visited
        plan_scope_path(root,relative)
        with os.scandir(full) as stream:
            for entry in stream:
                child = relative + '/' + entry.name
                consider(child,entry.path)
                visited += 1
                if progress: progress({'phase':'dependencyAnalysisMs','path':child,'snapshotEntries':visited})
                if entry.is_dir(follow_symlinks=False): scan(child,entry.path)
        plan_scope_path(root,relative)
    for relative in protocol['directories']:
        full = plan_scope_path(root,relative)
        if os.path.isdir(full): scan(relative,full)
    for relative in protocol['files']:
        full = plan_scope_path(root,relative)
        if os.path.isfile(full): consider(relative,full)
    return sorted(selected)

def plan_scope_python_access(tree, module_name="", path_collections=()):
    import ast
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    frames = (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
    def enclosing(node):
        node = parents.get(node)
        while node is not None and not isinstance(node, frames): node = parents.get(node)
        return node
    names, definitions = {}, {}
    def bind(frame, name, value):
        names.setdefault(frame, {}).setdefault(name, []).append(value)
        definitions.setdefault(node, []).append((frame, name, value))
    for node in ast.walk(tree):
        frame = enclosing(node)
        if isinstance(node, ast.Import):
            for alias in node.names: bind(frame, alias.asname or alias.name.split(".")[0], alias.name if alias.asname else alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            package = module_name.split(".")[:-1]
            base = package[:len(package)-node.level+1] if node.level else []
            base += node.module.split(".") if node.module else []
            for alias in node.names: bind(frame, alias.asname or alias.name, ".".join(base + [alias.name]))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bind(frame, node.name, node)
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
                if isinstance(child, ast.Name): bind(frame, child.id, node if isinstance(node.target, ast.Name) else None)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars is not None:
                    for child in ast.walk(item.optional_vars):
                        if isinstance(child, ast.Name): bind(frame, child.id, None)
        elif isinstance(node, ast.ExceptHandler) and node.name: bind(frame, node.name, None)
        elif isinstance(node, ast.Delete):
            for target in node.targets:
                if isinstance(target, ast.Name): bind(frame, target.id, None)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name: bind(frame, node.name, None)
        elif isinstance(node, ast.MatchMapping) and node.rest: bind(frame, node.rest, None)
    # Local loads see reaching definitions, not every assignment in the function.
    # Outer/closure bindings remain conservative: a function may run after a later
    # outer assignment. RHS loads are recorded before their assignment takes effect.
    reaching = {}
    def merge(*states):
        keys = set().union(*(state.keys() for state in states))
        return {key: tuple(dict.fromkeys(value for state in states for value in state.get(key, (None,)))) for key in keys}
    def analyse(frame):
        local = names.get(frame, {})
        untracked = {name for item in ast.walk(frame) if enclosing(item) is frame and isinstance(item, (ast.Global, ast.Nonlocal)) for name in item.names}
        def apply(node, env):
            for owner, name, value in definitions.get(node, ()):
                if owner is frame: env[name] = (value,)
        def possible(env, node):
            result = dict(env)
            for item in ast.walk(node):
                for owner, name, value in definitions.get(item, ()):
                    if owner is frame: result[name] = tuple(dict.fromkeys((*result.get(name, (None,)), value)))
            return result
        def expression(node, env):
            if isinstance(node, frames): return
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in local and node.id not in untracked:
                reaching[node] = env.get(node.id, None if isinstance(frame, ast.Module) else (None,))
            if isinstance(node, ast.NamedExpr):
                expression(node.value, env); apply(node, env); return
            if isinstance(node, ast.IfExp):
                expression(node.test, env)
                yes, no = dict(env), dict(env)
                expression(node.body, yes); expression(node.orelse, no)
                env.update(merge(yes, no)); return
            if isinstance(node, ast.BoolOp):
                expression(node.values[0], env)
                states = [dict(env)]
                for value in node.values[1:]: expression(value, env); states.append(dict(env))
                env.update(merge(*states)); return
            for child in ast.iter_child_nodes(node): expression(child, env)
        def block(statements, env):
            env = dict(env)
            for statement in statements:
                if isinstance(statement, ast.If):
                    expression(statement.test, env)
                    env = merge(block(statement.body, env), block(statement.orelse, env))
                elif isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
                    if isinstance(statement, ast.While):
                        loop = possible(env, statement); expression(statement.test, loop)
                    else:
                        expression(statement.iter, env); loop = possible(env, statement); apply(statement, loop)
                    # Include zero iterations and back-edge writes, even when a
                    # type-changing assignment occurs after a load in the body.
                    env = block(statement.orelse, merge(env, block(statement.body, loop)))
                elif isinstance(statement, (ast.Try, getattr(ast, 'TryStar', ast.Try))):
                    success = block(statement.orelse, block(statement.body, env))
                    outcomes = [success]
                    for handler in statement.handlers:
                        caught = possible(env, statement)
                        if handler.type: expression(handler.type, caught)
                        apply(handler, caught)
                        caught = block(handler.body, caught)
                        if handler.name: caught[handler.name] = (None,)  # Python clears exception targets.
                        outcomes.append(caught)
                    # finally also runs on exceptions which leave the block;
                    # otherwise unhandled exceptions cannot reach the next load.
                    env = block(statement.finalbody, merge(possible(env, statement), *outcomes)) if statement.finalbody else merge(*outcomes)
                elif isinstance(statement, (ast.With, ast.AsyncWith)):
                    for item in statement.items:
                        expression(item.context_expr, env)
                        if item.optional_vars:
                            for target in ast.walk(item.optional_vars):
                                if isinstance(target, ast.Name): env[target.id] = (None,)
                    env = block(statement.body, env)
                elif isinstance(statement, ast.Match):
                    expression(statement.subject, env)
                    outcomes = [dict(env)]
                    for case in statement.cases:
                        branch = dict(env)
                        for pattern in ast.walk(case.pattern): apply(pattern, branch)
                        if case.guard: expression(case.guard, branch)
                        outcomes.append(block(case.body, branch))
                    env = merge(*outcomes)
                else:
                    # Nested bodies have their own local analysis; decorators,
                    # bases and defaults still evaluate in the defining scope.
                    if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        for child in ast.iter_child_nodes(statement):
                            if child not in statement.body: expression(child, env)
                    else:
                        for child in ast.iter_child_nodes(statement): expression(child, env)
                    apply(statement, env)
            return env
        initial = {}
        if isinstance(frame, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for arg in [*frame.args.posonlyargs, *frame.args.args, *frame.args.kwonlyargs, frame.args.vararg, frame.args.kwarg]:
                if arg: initial[arg.arg] = (arg,)  # Unknown value, but an identifiable entry parameter.
        block(frame.body, initial)
    for frame in ast.walk(tree):
        if isinstance(frame, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): analyse(frame)
    def lookup(node):
        if node in reaching: return reaching[node]
        frame = enclosing(node)
        while frame is not None:
            if node.id in names.get(frame, {}): return names[frame][node.id]
            frame = enclosing(frame)
            # Method globals do not resolve through a class's attribute namespace.
            while isinstance(frame, ast.ClassDef): frame = enclosing(frame)
        return None
    def literal_string(node, seen=()):
        if node in seen: return None
        if isinstance(node, ast.Constant) and isinstance(node.value, str): return node.value
        if isinstance(node, ast.Name):
            values = [literal_string(value, seen + (node,)) for value in lookup(node) or []]
            return values[0] if values and all(value == values[0] for value in values) else None
        return None
    def symbol(node, seen=()):
        if node in seen: return None
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            parts, cursor = [node.name], enclosing(node)
            while isinstance(cursor, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                parts.insert(0, cursor.name); cursor = enclosing(cursor)
            prefix = module_name[:-9] if module_name.endswith(".__init__") else module_name
            return ".".join(([prefix] if prefix else []) + parts)
        if isinstance(node, ast.Name):
            values = lookup(node)
            if values is None: return {"open": "builtins.open", "str": "builtins.str", "getattr": "builtins.getattr", "__import__": "builtins.__import__", "sorted":"builtins.sorted", "set":"builtins.set", "list":"builtins.list", "tuple":"builtins.tuple"}.get(node.id)
            resolved = [value if isinstance(value, str) else symbol(value, seen + (node,)) for value in values]
            return resolved[0] if resolved and all(value == resolved[0] for value in resolved) else None
        if isinstance(node, ast.Attribute):
            base = symbol(node.value, seen + (node,))
            return base + "." + node.attr if base else None
        if isinstance(node, ast.Call):
            api = symbol(node.func, seen + (node,))
            if api in ("importlib.import_module", "builtins.__import__"):
                argument = node.args[0] if node.args else next((item.value for item in node.keywords if item.arg == "name"), None)
                return literal_string(argument)
        return None
    def path_items(node, seen=()):
        if node in seen: return False
        if node in path_collections: return True
        seen = seen + (node,)
        if isinstance(node, ast.Name):
            values = lookup(node)
            return bool(values) and all(path_items(value, seen) for value in values)
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)): return bool(node.elts) and all(is_path(item, seen) for item in node.elts)
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)): return is_path(node.elt, seen)
        if isinstance(node, ast.Call):
            if symbol(node.func) in ('builtins.sorted','builtins.set','builtins.list','builtins.tuple') and node.args: return path_items(node.args[0],seen)
            return isinstance(node.func,ast.Attribute) and node.func.attr in ('glob','rglob','iterdir') and is_path(node.func.value,seen)
        return False
    def is_path(node, seen=()):
        if node in seen: return False
        seen = seen + (node,)
        if isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)): return path_items(node.iter,seen)
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

def plan_scope_active_nodes(tree, roots):
    import ast
    active = set()
    def visit(node, class_live=False, scope=()):
        active.add(node)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for child in [*node.decorator_list, node.args, *([node.returns] if node.returns else [])]: visit(child, scope=scope)
            # A decorator may invoke the function while defining it; do not drop
            # those possible definition-time inputs just because no call is visible.
            qualified = ".".join((*scope, node.name))
            if "*" in roots or node.name in roots or qualified in roots or any(root.startswith(qualified + ".") for root in roots) or class_live or node.decorator_list:
                for statement in node.body: visit(statement, scope=(*scope, node.name))
            return
        if isinstance(node, ast.ClassDef):
            for child in [*node.decorator_list, *node.bases, *node.keywords]: visit(child, scope=scope)
            for statement in node.body: visit(statement, "*" in roots or node.name in roots, (*scope, node.name))
            return
        if isinstance(node, ast.If) and isinstance(node.test, ast.Compare) and len(node.test.ops) == 1:
            left, right = node.test.left, node.test.comparators[0]
            main_test = (isinstance(left, ast.Name) and left.id == "__name__" and isinstance(right, ast.Constant) and right.value == "__main__") or (isinstance(right, ast.Name) and right.id == "__name__" and isinstance(left, ast.Constant) and left.value == "__main__")
            if main_test and isinstance(node.test.ops[0], (ast.Eq, ast.NotEq)):
                visit(node.test, scope=scope)
                yes = ("__main__" in roots) != isinstance(node.test.ops[0], ast.NotEq)
                for statement in node.body if yes else node.orelse: visit(statement, scope=scope)
                return
        for child in ast.iter_child_nodes(node): visit(child, class_live, scope)
    visit(tree)
    return active

def plan_scope_asset_declaration(item):
    if not isinstance(item, dict) or set(item) != {"path", "allowed_root", "target", "sha256", "approval"} or item.get("approval") != "user-confirmed":
        raise ValueError("PLAN_ASSET_AUTHORIZATION_REQUIRED: declare each source_dependencies.assets file with user-confirmed approval, allowed_root, target and trusted/user-approved sha256")
    path = item["path"]
    if not isinstance(path, str) or not path or path.startswith("/") or ":" in path or "\\" in path or any(ord(char) < 32 for char in path) or any(part in ("", ".", "..") for part in path.split("/")):
        raise ValueError("PLAN_ASSET_PATH_INVALID: " + str(path))
    if not isinstance(item["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]): raise ValueError("PLAN_ASSET_DIGEST_REQUIRED: " + path)
    for key in ("allowed_root", "target"):
        value = item[key]
        if not isinstance(value, str) or not os.path.isabs(value) or os.path.normpath(value) != value: raise ValueError("PLAN_ASSET_PATH_INVALID: " + key)
    allowed, target = item["allowed_root"], item["target"]
    if allowed in (os.path.abspath(os.sep), os.path.expanduser("~")) or target == allowed or os.path.commonpath([allowed, target]) != allowed:
        raise ValueError("PLAN_ASSET_UNAUTHORIZED_TARGET: " + path)
    return dict(item)

def plan_scope_asset_resolve(root, relative):
    import stat
    root = os.path.realpath(root)
    links = []
    def resolve(path, active=()):
        path = pathlib.Path(path)
        current = path.anchor
        for part in path.parts[1:]:
            if part == ".": continue
            if part == "..": current = os.path.dirname(current); continue
            current = os.path.join(current, part)
            info = os.lstat(current)
            if stat.S_ISLNK(info.st_mode):
                if current in active: raise ValueError("PLAN_ASSET_LINK_LOOP: " + relative)
                target = os.readlink(current)
                label = os.path.relpath(current, root).replace(os.sep, "/") if os.path.commonpath([root, current]) == root else current
                links.append({"path": label, "target": target})
                destination = target if os.path.isabs(target) else os.path.join(os.path.dirname(current), target)
                current = resolve(destination, active + (current,))
        return current
    try:
        target = resolve(os.path.join(os.path.realpath(root), relative))
    except FileNotFoundError as error: raise ValueError("PLAN_ASSET_MISSING_OR_BROKEN_LINK: " + relative) from error
    except OSError as error: raise ValueError("PLAN_ASSET_RESOLVE_FAILED: " + relative + ": " + str(error)) from error
    return target, links

def plan_scope_asset_snapshot(root, declaration):
    import stat
    item = plan_scope_asset_declaration(declaration)
    relative, allowed = item["path"], item["allowed_root"]
    if not os.path.isdir(allowed) or os.path.realpath(allowed) != allowed or os.path.realpath(item["target"]) != item["target"]:
        raise ValueError("PLAN_ASSET_AUTHORIZED_PATH_CHANGED: " + relative)
    target, links = plan_scope_asset_resolve(root, relative)
    if target != item["target"] or os.path.commonpath([allowed, target]) != allowed:
        raise ValueError("PLAN_ASSET_UNAUTHORIZED_TARGET: " + relative + " -> " + target)
    info = os.stat(target, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode): raise ValueError("PLAN_ASSET_NOT_REGULAR: " + relative)
    return {"path": relative, "allowedRoot": allowed, "target": target, "sha256": item["sha256"], "links": links, "size": info.st_size}

def plan_scope_timed(progress, phase, action):
    import time
    started = time.monotonic()
    if progress: progress({"phase": phase, "state": "started"})
    try: return action()
    finally:
        if progress: progress({"phase": phase, "state": "completed", "elapsedMs": (time.monotonic() - started) * 1000})

def plan_scope_verify_asset(root, declaration, expected=None, progress=None):
    import stat
    binding = plan_scope_timed(progress, "assetResolutionMs", lambda: plan_scope_asset_snapshot(root, declaration))
    relative, target = binding["path"], binding["target"]
    if expected is not None and expected != binding: raise ValueError("PLAN_ASSET_BINDING_CHANGED: " + relative)
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    before = os.stat(target, follow_symlinks=False)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    digest = hashlib.sha256()
    def read_digest():
        processed = 0
        with os.fdopen(os.open(target, flags), "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or identity(opened) != identity(before): raise ValueError("PLAN_ASSET_REPLACED: " + relative)
            for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                digest.update(chunk)
                processed += len(chunk)
                if progress: progress({"phase": "assetHashReadMs", "path": relative, "processedBytes": processed, "totalBytes": binding["size"]})
            return opened, os.fstat(stream.fileno())
    opened, after = plan_scope_timed(progress, "assetHashReadMs", read_digest)
    resolved_after, links_after = plan_scope_timed(progress, "assetResolutionMs", lambda: plan_scope_asset_resolve(root, relative))
    if identity(opened) != identity(after) or identity(after) != identity(os.stat(target, follow_symlinks=False)) or resolved_after != target or links_after != binding["links"]:
        raise ValueError("PLAN_ASSET_CHANGED_DURING_READ: " + relative)
    if digest.hexdigest() != binding["sha256"] or binding["size"] != after.st_size:
        raise ValueError("PLAN_ASSET_DIGEST_MISMATCH: " + relative)
    return binding

def plan_source_scope(root, plan_file, revision, inventory=(), provenance=None, assets=None, progress=None):
    import ast
    import itertools
    import shlex
    import yaml
    provenance = provenance if provenance is not None else {}
    assets = assets if assets is not None else {}
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
    snapshot_collections, snapshot_integrity, snapshot_generated, snapshot_protocols = {}, {}, {}, {}
    python_roots = {}
    def activate(file, name):
        roots = python_roots.setdefault(file, set())
        if name in roots: return False
        roots.add(name)
        if progress: progress({"phase": "dependencyAnalysisMs", "path": file, "activatedRoot": name})
        return True
    declared_outputs = set()
    config_suffixes = (".yaml", ".yml", ".json", ".toml", ".ini", ".cfg")
    def add(relative, required=False, kind="code", parent=None, reason="import"):
        relative = relative.replace("\\", "/")
        if relative not in provenance or ranks[kind] > ranks[provenance[relative][2]]:
            provenance[relative] = (parent or plan_file, reason, kind)
        if relative in declared_outputs:
            if required: fail("PLAN_SOURCE_OUTPUT_OVERLAP", relative)
            return
        if relative in assets:
            if kind not in ("input", "integrity", "config"): fail("PLAN_ASSET_NOT_EXECUTABLE", relative)
            return
        if plan_scope_generated(relative) and not required:
            return
        try:
            full = plan_scope_path(root, relative)
        except ValueError as exc:
            code = str(exc).split(":", 1)[0]
            if code == "PLAN_SOURCE_LINK" and kind in ("input", "integrity", "config"): code += " (shared runtime asset requires source_dependencies.assets authorization)"
            fail(code, relative)
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
        elif candidate not in assets and not os.path.isfile(os.path.join(root, candidate)):
            candidate = os.path.normpath(os.path.join(os.path.dirname(parent), candidate)).replace(os.sep, "/")
        add(candidate, True, kind, parent, reason)
        return candidate
    def module(name, parent, reason, required=True, entry=False):
        if not name or not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", name):
            return
        parts = name.split(".")
        for i in range(1, len(parts)):
            initial = "/".join(parts[:i]) + "/__init__.py"
            if os.path.isfile(os.path.join(root, initial)): add(initial, True, "code", parent, reason)
        local = "/".join(parts)
        candidates = [local + ".py", local + "/__init__.py"]
        found = [item for item in candidates if os.path.isfile(os.path.join(root, item))]
        for item in found:
            add(item, True, "code", parent, reason)
            if entry: activate(item, "__main__")
        if required and not found and not os.path.isdir(os.path.join(root, local)) and os.path.isdir(os.path.join(root, parts[0])):
            provenance.setdefault(candidates[0], (parent, reason, "code"))
            fail("PLAN_SOURCE_MISSING", candidates[0])
    def command(value, parent, reason):
        try: words = shlex.split(value) if isinstance(value, str) else list(value)
        except ValueError: fail("PLAN_SOURCE_COMMAND_INVALID", parent)
        for index, word in enumerate(words):
            if not isinstance(word, str): fail("PLAN_SOURCE_COMMAND_INVALID", parent)
            if word.endswith((".py", ".sh")) and not word.startswith("-"):
                target = reference(word, "code", parent, reason)
                if target: activate(target, "__main__")
            if word == "-m" and index + 1 < len(words): module(words[index + 1], parent, reason, entry=True)
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
                if key in ("model_path", "tokenizer_path", "encoder_assets_dir") and isinstance(value, str) and value:
                    local = value if os.path.isabs(value) else os.path.join(root, value)
                    logical = os.path.relpath(local, root).replace(os.sep, "/")
                    if os.path.isfile(local): reference(value, "input", relative, "local model asset " + key)
                    elif os.path.isdir(local) or document.get("local_files_only") is True or any(path.startswith(logical.rstrip("/") + "/") for path in assets):
                        if not any(path.startswith(logical.rstrip("/") + "/") for path in assets): fail("PLAN_ASSET_DIRECTORY_UNDECLARED (" + key + "; declare exact source_dependencies.assets files)", relative)
                        conservative.add(relative + ": " + key + " uses explicitly enumerated asset files; third-party directory loader not executed")
                    continue
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
    def python_dependencies():
        def symbol_target(value, parent, line):
            if not isinstance(value, str): return False
            parts = value.split(".")
            for length in range(len(parts), 0, -1):
                prefix = "/".join(parts[:length])
                for candidate in (prefix + ".py", prefix + "/__init__.py"):
                    if not os.path.isfile(os.path.join(root, candidate)): continue
                    module(".".join(parts[:length]), parent, "referenced Python symbol line " + str(line))
                    return activate(candidate, ".".join(parts[length:])) if length < len(parts) else False
            return False
        changed = True
        while changed:
            changed = False
            active = {file: plan_scope_active_nodes(tree, python_roots.get(file, set())) for file, (tree, *_) in python_contexts.items()}
            for file, (tree, evaluate, parents, assignments) in python_contexts.items():
                symbol = python_access[file][0]
                package = file.split("/")[:-1]
                for node in ast.walk(tree):
                    if node not in active[file]: continue
                    if isinstance(node, ast.Import):
                        for alias in node.names: module(alias.name, file, "import line " + str(node.lineno))
                    elif isinstance(node, ast.ImportFrom):
                        base = package[:len(package)-node.level+1] if node.level else []
                        base += node.module.split(".") if node.module else []
                        module(".".join(base), file, "import line " + str(node.lineno))
                        for alias in node.names:
                            if alias.name == "*":
                                base_path = "/".join(base)
                                local = [path for path in (base_path + ".py", base_path + "/__init__.py") if os.path.isfile(os.path.join(root, path))]
                                if not declared["code"] or any(path not in declared["code"] for path in local): fail("PLAN_SOURCE_DYNAMIC_IMPORT_UNDECLARED (star import; declare exact module in source_dependencies.code)", file)
                                conservative.add(file + ": star import bounded by source_dependencies.code")
                                continue
                            module(".".join(base + [alias.name]), file, "import attribute line " + str(node.lineno), False)
                            if (alias.asname or alias.name) in python_roots.get(file, set()): changed = symbol_target(".".join(base + [alias.name]), file, node.lineno) or changed
                    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.decorator_list:
                        conservative.add(file + ": decorated callable body conservatively inspected line " + str(node.lineno))
                    elif isinstance(node, (ast.Name, ast.Attribute)) and isinstance(node.ctx, ast.Load):
                        changed = symbol_target(symbol(node), file, node.lineno) or changed
                    elif isinstance(node, ast.Call):
                        changed = symbol_target(symbol(node.func), file, node.lineno) or changed
                        if symbol(node.func) == "builtins.getattr" and len(node.args) > 1:
                            base, members = symbol(node.args[0]), evaluate(node.args[1])
                            if base and members:
                                for member in members: changed = symbol_target(base + "." + member, file, node.lineno) or changed
                            elif base:
                                for candidate in (base.replace(".", "/") + ".py", base.replace(".", "/") + "/__init__.py"):
                                    if os.path.isfile(os.path.join(root, candidate)) and candidate not in declared["code"]:
                                        fail("PLAN_SOURCE_DYNAMIC_CALL_UNDECLARED (line " + str(node.lineno) + "; declare source_dependencies.code for " + candidate + ")", file)
                        api = symbol(node.func)
                        loaders = {"importlib.import_module": "import_module", "builtins.__import__": "__import__", "importlib.util.spec_from_file_location": "spec_from_file_location"}
                        if api not in loaders: continue
                        name = loaders[api]
                        expression = (node.args[1] if len(node.args)>1 else next((keyword.value for keyword in node.keywords if keyword.arg == "location"), None)) if name == "spec_from_file_location" else node.args[0] if node.args else next((keyword.value for keyword in node.keywords if keyword.arg == "name"), None)
                        values = evaluate(expression)
                        if not values:
                            if not declared["code"]: fail("PLAN_SOURCE_DYNAMIC_IMPORT_UNDECLARED (line " + str(node.lineno) + "; declare source_dependencies.code)", file)
                            conservative.add(file + ": dynamic code loader line " + str(node.lineno) + " bounded by source_dependencies.code; no directory scan")
                        for value in values:
                            if name == "spec_from_file_location":
                                target = reference(value, "code", file, "dynamic code loader line " + str(node.lineno))
                                if target not in declared["code"]: fail("PLAN_SOURCE_DYNAMIC_CALL_UNDECLARED (file loader line " + str(node.lineno) + "; declare source_dependencies.code for " + str(target) + ")", file)
                            else:
                                module(value, file, "dynamic import line " + str(node.lineno))
                                if not symbol(node):
                                    for target in (value.replace(".", "/") + ".py", value.replace(".", "/") + "/__init__.py"):
                                        if os.path.isfile(os.path.join(root, target)) and target not in declared["code"]: fail("PLAN_SOURCE_DYNAMIC_CALL_UNDECLARED (dynamic module scope line " + str(node.lineno) + "; declare source_dependencies.code for " + target + ")", file)
            if pending: return None
        return active
    def resource_reads():
        active = python_dependencies()
        if active is None: return
        for file, protocols in snapshot_protocols.items():
            for protocol in protocols:
                body = protocol['entry'].body
                first = body[1] if body and isinstance(body[0],ast.Expr) and isinstance(body[0].value,ast.Constant) and isinstance(body[0].value.value,str) else body[0]
                if first not in active[file]: continue
                if protocol.get('unsupported'):
                    fail('PLAN_SOURCE_SNAPSHOT_UNSUPPORTED (complete selector/copy/reuse protocol not proven; inputs/integrity lists cannot authorise an unknown snapshot algorithm)',file)
                if protocol['collection'] in snapshot_collections[file]: continue
                try: members = plan_scope_snapshot_members(root,protocol,progress)
                except (ValueError,OSError) as error:
                    raise ValueError(str(error) + '; dependency chain: ' + plan_scope_reason(file,provenance)) from error
                snapshot_collections[file][protocol['collection']] = members
                snapshot_integrity[file].update(protocol['integrity']); snapshot_generated[file].update(protocol['generated'])
                for member in members: add(member,True,'integrity',file,'source snapshot member (complete selector, byte-only)')
                conservative.add(file + ': recognised live source snapshot protocol; exact membership re-enumerated, generated copy/marker reads are output verification, project functions not executed')
        if pending: return
        functions, effects = {}, {}
        for file, (tree, evaluate, parents, assignments) in python_contexts.items():
            for node in tree.body:
                if isinstance(node, ast.FunctionDef):
                    functions[(file, node.name)] = node
        qualified = {}
        for key in functions:
            file, name = key
            prefix = file[:-3].replace("/", ".")
            if prefix.endswith(".__init__"): prefix = prefix[:-9]
            qualified[prefix + "." + name] = key
        def called(file, node):
            # Do not replace a use-position binding with a later module definition.
            return qualified.get(python_access[file][0](node))
        def call_argument(node, index, function):
            if index < len(node.args): return node.args[index]
            parameters = function.args.posonlyargs + function.args.args
            if index < len(parameters):
                return next((keyword.value for keyword in node.keywords if keyword.arg == parameters[index].arg), None)
            return None
        def parameter(file, node, function, seen=()):
            if node in seen: return None
            if isinstance(node, ast.arg):
                return next((i for i, arg in enumerate(function.args.posonlyargs + function.args.args) if arg is node), None)
            if isinstance(node, ast.Name):
                values = python_access[file][2](node) or []
                forwarded = {parameter(file, value, function, seen + (node,)) for value in values}
                return next(iter(forwarded)) if len(forwarded) == 1 else None
            if isinstance(node, ast.Call):
                name = python_access[file][0](node.func)
                if name in ("pathlib.Path", "pathlib.PosixPath", "pathlib.WindowsPath", "builtins.str") and node.args: return parameter(file, node.args[0], function, seen)
            return None
        unknown_access = {}
        def hashing(file, node, seen=()):
            if node in seen: return False
            if isinstance(node,ast.Name):
                values=python_access[file][2](node)
                return bool(values) and all(hashing(file,value,seen+(node,)) for value in values)
            return isinstance(node,ast.Call) and python_access[file][0](node.func) in ('hashlib.sha256','hashlib.sha512','hashlib.sha1','hashlib.md5','hashlib.blake2b','hashlib.blake2s')
        def reader(file, node):
            if not isinstance(node, ast.Call): return None
            if node in snapshot_generated.get(file,()): return None
            if called(file, node.func) in functions: return None
            name = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ""
            symbol, is_path = python_access[file][:2]
            if symbol(node.func) == 'shutil.copy2':
                source = node.args[0] if node.args else next((item.value for item in node.keywords if item.arg == 'src'),None)
                if source is None: fail('PLAN_SOURCE_COPY_SOURCE_REQUIRED',file)
                return source, 'integrity' if node in snapshot_integrity.get(file,()) else 'input', False
            file_open = symbol(node.func) in ("builtins.open", "io.open")
            if not file_open and name not in ("open", "read_text", "read_bytes", "load_config", "read_config", "fromfile", "read_json", "read_csv"): return None
            bound = isinstance(node.func, ast.Attribute) and name in ("open", "read_text", "read_bytes") and is_path(node.func.value)
            evaluate, parents = python_contexts[file][1:3]
            kind, structured, cursor = ("config" if name in ("load_config", "read_config", "fromfile") else "input"), name in ("read_json", "read_csv"), node
            if node in snapshot_integrity.get(file,()): kind='integrity'
            while cursor in parents and not isinstance(parents[cursor], ast.FunctionDef):
                cursor = parents[cursor]
                if isinstance(cursor, ast.Call):
                    outer = cursor.func.attr if isinstance(cursor.func, ast.Attribute) else cursor.func.id if isinstance(cursor.func, ast.Name) else ""
                    if outer in ("sha256", "sha512", "sha1", "md5", "blake2b", "blake2s"): kind = "integrity"
                    if outer == 'update' and isinstance(cursor.func,ast.Attribute) and hashing(file,cursor.func.value): kind = 'integrity'
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
                expanded_positional = any(isinstance(arg, ast.Starred) for arg in node.args)
                if not expanded_positional and (positional is not None and keyword is not None or file_open and node.args and any(item.arg == "file" for item in node.keywords)):
                    fail("PLAN_SOURCE_OPEN_ARGUMENT_INVALID (line " + str(node.lineno) + ")", file)
                dynamic_arguments = expanded_positional or any(item.arg is None for item in node.keywords)
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
            if input_node is None:
                unknown_access[(file, node.lineno)] = (kind, "unresolved file path/arguments")
                return None
            return input_node, kind, structured
        for key, function in functions.items():
            effects[key] = set()
            for node in ast.walk(function):
                if node not in active[key[0]]: continue
                read = reader(key[0], node)
                index = parameter(key[0], read[0], function) if read else None
                if index is not None: effects[key].add((index, read[1], read[2]))
        changed = True
        while changed:
            changed = False
            for key, function in functions.items():
                for node in ast.walk(function):
                    if node not in active[key[0]]: continue
                    if not isinstance(node, ast.Call): continue
                    for index, kind, structured in effects.get(called(key[0], node.func), ()):
                        callee = functions[called(key[0], node.func)]
                        forwarded = parameter(key[0], call_argument(node, index, callee), function)
                        effect = (forwarded, kind, structured)
                        if forwarded is not None and effect not in effects[key]: effects[key].add(effect); changed = True
        unresolved, results, digest_calls = [], {}, {}
        for file, (tree, evaluate, parents, assignments) in python_contexts.items():
            for node in ast.walk(tree):
                if node not in active[file]: continue
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
                if loop not in active[file]: continue
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
        if relative not in files and len(files) + len(assets) >= 4096:
            fail("PLAN_SOURCE_SCOPE_TOO_LARGE", relative)
        full = plan_scope_path(root, relative)
        if os.path.getsize(full) > 2 * 1024 * 1024:
            fail("PLAN_SOURCE_FILE_TOO_LARGE", relative)
        raw = pathlib.Path(full).read_bytes()
        if progress: progress({"phase": "dependencyAnalysisMs", "path": relative, "readBytes": len(raw), "filesProcessed": len(processed) + 1})
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
                if not isinstance(explicit, dict) or any(key not in {*declared, "assets"} for key in explicit): fail("PLAN_SOURCE_DECLARATION_INVALID", relative)
                authorizations = explicit.get("assets", [])
                if not isinstance(authorizations, list): fail("PLAN_ASSET_AUTHORIZATION_REQUIRED", relative)
                for value in authorizations:
                    item = plan_scope_asset_declaration(value)
                    if item["path"] in assets: fail("PLAN_ASSET_DUPLICATE", item["path"])
                    assets[item["path"]] = item
                    provenance[item["path"]] = (relative, "user-confirmed source_dependencies.assets", "input")
                for group, values in explicit.items():
                    if group == "assets": continue
                    if not isinstance(values, list) or any(not isinstance(value, str) or not value for value in values): fail("PLAN_SOURCE_DECLARATION_INVALID", relative)
                    declared[group].update(values)
                    if group == "code":
                        for value in values: activate(value, "*")
                    for value in values: add(value, True, {"code": "code", "configs": "config", "inputs": "input", "integrity": "integrity"}[group], relative, "source_dependencies." + group)
            config_references(document, relative)
        if relative.endswith(".sh"):
            for line in text.splitlines():
                if line.strip() and not line.lstrip().startswith("#"): command(line, relative, "shell command")
        if not relative.endswith(".py"):
            continue
        tree = ast.parse(text, filename=relative)
        module_name = relative[:-3].replace("/", ".")
        protocols = plan_scope_snapshot_protocol(tree)
        snapshot_collections[relative], snapshot_integrity[relative], snapshot_generated[relative], snapshot_protocols[relative] = {}, set(), set(), protocols
        python_access[relative] = plan_scope_python_access(tree, module_name, [protocol['collection'] for protocol in protocols if not protocol.get('unsupported')])
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
            if isinstance(node,(ast.For,ast.AsyncFor,ast.comprehension)): return collection_values(node.iter,seen,source_file)
            if isinstance(node, ast.Constant) and isinstance(node.value, str): return [node.value]
            if isinstance(node, ast.Name):
                if node.id == "__file__": return [source_file]
                if node in seen: return []
                values = python_access[source_file][2](node) or []
                choices = [strings(item, seen + (node,), source_file, names, expand) for item in values]
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
        def collection_values(node, seen=(), source_file=relative):
            if node in seen: return []
            if node in snapshot_collections[source_file]: return snapshot_collections[source_file][node]
            seen = seen + (node,)
            if isinstance(node,ast.Name):
                values = python_access[source_file][2](node) or []
                choices = [collection_values(value,seen,source_file) for value in values]
                return [item for group in choices for item in group] if choices and all(choices) else []
            if isinstance(node,(ast.List,ast.Tuple,ast.Set)):
                choices = [python_contexts[source_file][1](item,seen,source_file) for item in node.elts]
                return [item for group in choices for item in group] if choices and all(choices) else []
            if isinstance(node,ast.Call) and python_access[source_file][0](node.func) in ('builtins.sorted','builtins.set','builtins.list','builtins.tuple') and node.args: return collection_values(node.args[0],seen,source_file)
            return []
        python_contexts[relative] = (tree, strings, parents, assignments)
    for relative in assets:
        if relative in declared_outputs: fail("PLAN_SOURCE_OUTPUT_OVERLAP", relative)
    return sorted(files), sorted(conservative)

def plan_source_digest(manifest, assets=None):
    rows = [[key, {"size": manifest[key]["size"], "sha256": manifest[key]["sha256"]}] for key in sorted(manifest)]
    if assets:
        if not isinstance(assets, dict): raise ValueError("PLAN_ASSET_BASELINE_INVALID")
        for key, value in assets.items():
            if not isinstance(value, dict) or set(value) != {"path", "allowedRoot", "target", "sha256", "links", "size"} or value.get("path") != key or type(value.get("size")) is not int or value["size"] < 0 or not isinstance(value.get("links"), list): raise ValueError("PLAN_ASSET_BASELINE_INVALID")
            plan_scope_asset_declaration({"path": key, "allowed_root": value["allowedRoot"], "target": value["target"], "sha256": value["sha256"], "approval": "user-confirmed"})
            if any(not isinstance(link, dict) or set(link) != {"path", "target"} or not all(isinstance(item, str) for item in link.values()) for link in value["links"]): raise ValueError("PLAN_ASSET_BASELINE_INVALID")
        rows = [rows, [[key, {field: assets[key][field] for field in ("path", "allowedRoot", "target", "sha256", "links", "size")}] for key in sorted(assets)]]
    return hashlib.sha256(json.dumps(rows, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()

def verify_plan_execution_source(root, row, source, progress=None):
    manifest = source.get("manifest") if isinstance(source, dict) else None
    asset_records = source.get("assets", {}) if isinstance(source, dict) else {}
    if not isinstance(manifest, dict) or not manifest or not isinstance(asset_records, dict) or len(manifest) + len(asset_records) > 4096 or plan_source_digest(manifest, asset_records) != source.get("digest"):
        raise ValueError("PLAN_SOURCE_BASELINE_INVALID")
    if len(json.dumps(source, ensure_ascii=False).encode("utf-8")) > 65536:
        raise ValueError("PLAN_SOURCE_WINDOW_INPUT_LIMIT")
    if manifest.get(row["planFile"], {}).get("sha256") != row["planRevision"]:
        raise ValueError("PLAN_SOURCE_REVISION_MISMATCH")
    provenance, authorizations = {}, {}
    paths, conservative = plan_scope_timed(progress, "dependencyAnalysisMs", lambda: plan_source_scope(root, row["planFile"], row["planRevision"], manifest, provenance, authorizations, progress))
    if set(paths) != set(manifest):
        raise ValueError("PLAN_SOURCE_DEPENDENCIES_CHANGED: " + ", ".join(sorted(set(paths) ^ set(manifest))[:12]))
    def verify_sources():
        for index, relative in enumerate(paths):
            try:
                _code_sync_stat_record(root, relative, manifest[relative], verify_content=True)
                if progress: progress({"phase": "sourceVerificationMs", "path": relative, "filesVerified": index + 1, "totalFiles": len(paths)})
            except (ValueError, OSError) as exc:
                raise ValueError(str(exc) + "; dependency chain: " + plan_scope_reason(relative, provenance)) from exc
    plan_scope_timed(progress, "sourceVerificationMs", verify_sources)
    if set(asset_records) != set(authorizations): raise ValueError("PLAN_ASSET_DEPENDENCIES_CHANGED")
    observations = {}
    for relative, declaration in authorizations.items():
        try: observations[relative] = plan_scope_verify_asset(root, declaration, asset_records[relative], progress)
        except (ValueError, OSError) as error: raise ValueError(str(error) + "; dependency chain: " + plan_scope_reason(relative, provenance)) from error
    return {"schemaVersion": 1, "files": [{"path": key, **manifest[key]} for key in paths], "fileCount": len(paths), "conservative": conservative, "assetCount": len(observations), "assets": observations}

def inspect_plan_code_scope(root, request, progress=None):
    timings = {}
    def report(event):
        if "elapsedMs" in event: timings[event["phase"]] = timings.get(event["phase"], 0) + event["elapsedMs"]
        if progress: progress(event)
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
                checked = verify_plan_execution_source(root, row, original, report)
                return {"ok": True, "compatible": True, "readOnly": True, **row, "executionSource": original, "fileCount": checked["fileCount"], "conservative": checked["conservative"], "assetCount": checked["assetCount"], "assets": checked["assets"], "timings": timings, "queriedAt": now_iso()}
            raise ValueError("PLAN_SOURCE_ORIGINAL_HASH_UNAVAILABLE")
        original = {item["path"]: {"size": item["size"], "sha256": item["sha256"]} for item in proof["files"]}
        if durable_code_manifest_digest(original) != row["codeFingerprint"]:
            raise ValueError("PLAN_SOURCE_ORIGINAL_HASH_INVALID")
        provenance, authorizations = {}, {}
        paths, _ = plan_scope_timed(report, "dependencyAnalysisMs", lambda: plan_source_scope(root, row["planFile"], row["planRevision"], original, provenance, authorizations, report))
        if any(key not in original for key in paths):
            missing = next(key for key in paths if key not in original)
            raise ValueError("PLAN_SOURCE_ORIGINAL_DEPENDENCY_MISSING: " + missing + "; dependency chain: " + plan_scope_reason(missing, provenance))
        manifest = {key: original[key] for key in paths}
        records = {key: plan_scope_timed(report, "assetResolutionMs", lambda: plan_scope_asset_snapshot(root, declaration)) for key, declaration in authorizations.items()}
        source = {"manifest": manifest, "digest": plan_source_digest(manifest, records)}
        if records: source["assets"] = records
    checked = verify_plan_execution_source(root, row, source, report)
    return {"ok": True, "compatible": True, "readOnly": True, **row, "executionSource": source,
            "fileCount": checked["fileCount"], "conservative": checked["conservative"], "assetCount": checked["assetCount"], "assets": checked["assets"], "timings": timings, "queriedAt": now_iso()}
`;
