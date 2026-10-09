"""Load only requested runtime functions and their static dependencies; never module entry points."""
import ast
import sys
import types
from pathlib import Path

def extract_runtime_functions(filename, roots):
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
    selected = set()
    pending = list(roots)
    while pending:
        name = pending.pop()
        if name in selected or name not in definitions:
            continue
        selected.add(name)
        pending.extend(item.id for item in ast.walk(definitions[name]) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load))
    imports = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom)) or isinstance(node, ast.Try) and any(isinstance(item, (ast.Import, ast.ImportFrom)) for item in node.body)]
    chosen = {id(definitions[name]) for name in selected}
    body = imports + [node for node in tree.body if id(node) in chosen]
    module = types.ModuleType("isolated_runtime")
    sys.modules[module.__name__] = module
    exec(compile(ast.Module(body=body, type_ignores=[]), filename, "exec"), module.__dict__)
    return module
