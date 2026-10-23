"""Load only requested runtime functions and their static dependencies; never module entry points."""
import ast
import sys
import types
from pathlib import Path

def extract_runtime_functions(filename, roots, namespace=None, include_imports=True):
    roots = set(roots)
    tree = ast.parse(Path(filename).read_text(encoding="utf-8"), filename=filename)
    definitions = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            definitions[node.name] = node
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    definitions[target.id] = node
        elif isinstance(node, ast.If) and not any(isinstance(item, ast.Name) and item.id == '__name__' for item in ast.walk(node.test)):
            # Keep only requested conditional constant initializers, such as the
            # GPU history retention setting; never include the runtime main guard.
            for item in ast.walk(node):
                if isinstance(item, (ast.Assign, ast.AnnAssign)):
                    for target in item.targets if isinstance(item, ast.Assign) else [item.target]:
                        if isinstance(target, ast.Name):
                            definitions[target.id] = node
    selected = set()
    pending = list(roots)
    while pending:
        name = pending.pop()
        if name in selected or name not in definitions or (namespace is not None and name in namespace and name not in roots):
            continue
        selected.add(name)
        for item in ast.walk(definitions[name]):
            if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load):
                pending.append(item.id)
    imports = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom)) or isinstance(node, ast.Try) and any(isinstance(item, (ast.Import, ast.ImportFrom)) for item in node.body)]
    if not include_imports:
        # A fixture may supply explicit portable imports and filesystem/transport
        # boundaries. This never evaluates unrelated module setup or POSIX imports.
        imports = []
    chosen = {id(definitions[name]) for name in selected}
    body = imports + [node for node in tree.body if id(node) in chosen]
    module = types.ModuleType("isolated_runtime")
    module.__file__ = str(filename)
    sys.modules[module.__name__] = module
    if namespace is None:
        exec(compile(ast.Module(body=body, type_ignores=[]), filename, "exec"), module.__dict__)
    else:
        # Function-only fixtures may inject filesystem/transport boundaries. Keep
        # those doubles while resolving every other static production dependency
        # into the same globals, so later test state changes stay visible.
        injected = dict(namespace)
        exec(compile(ast.Module(body=imports, type_ignores=[]), filename, "exec"), namespace)
        namespace.update(injected)
        exec(compile(ast.Module(body=[node for node in tree.body if id(node) in chosen], type_ignores=[]), filename, "exec"), namespace)
        module.__dict__.update(namespace)
    return module
