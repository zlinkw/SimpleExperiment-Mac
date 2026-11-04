"""Run only the real save-result-policy branch, without loading Agent services."""
import ast
import json
import pathlib
import re
import sys

tree = ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
handler = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "handle_action")
branch = next(
    node for node in handler.body
    if isinstance(node, ast.If)
    and isinstance(node.test, ast.Compare)
    and isinstance(node.test.left, ast.Name)
    and node.test.left.id == "action"
    and len(node.test.comparators) == 1
    and isinstance(node.test.comparators[0], ast.Constant)
    and node.test.comparators[0].value == "save-result-policy"
)
function = ast.parse("def receive(root, action, payload, operation_id, op_id):\n    pass\n").body[0]
function.body = [branch]
module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
writes = []


def terminal_action(root, action, operation_id, op_id, status, message, *args, **kwargs):
    return {"status": status, "message": message}


def atomic_write(target, value):
    writes.append({"target": target, "value": value})


namespace = {
    "re": re,
    "terminal_action": terminal_action,
    "atomic_write": atomic_write,
    "path_for": lambda root, name: root + "/" + name,
}
exec(compile(module, "isolated-save-result-policy", "exec"), namespace)
results = [namespace["receive"](row.get("root", "fixture"), "save-result-policy", row["payload"], "op", "id") for row in json.load(sys.stdin)]
print(json.dumps({"results": results, "writes": writes}, ensure_ascii=False))
