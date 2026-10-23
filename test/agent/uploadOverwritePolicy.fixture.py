import ast, hashlib, json, os, pathlib, sys, tempfile
runtime = pathlib.Path(sys.argv[1])
tree = ast.parse(runtime.read_text(encoding="utf-8"))
names = {"normalize_overwrite_policy", "existing_upload_target_info", "upload_target_snapshot", "validate_upload_overwrite", "sha256_file"}
nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
assert len(nodes) == len(names)
ns = {"os": os, "hashlib": hashlib}
exec(compile(ast.Module(body=nodes, type_ignores=[]), "isolated-upload-policy", "exec"), ns)
root = pathlib.Path(tempfile.mkdtemp(prefix="upload-policy-functions-"))
target = root / "plan.yaml"
target.write_text("old", encoding="utf-8")
def reject(policy, content, original=None):
    before = target.read_bytes() if target.exists() else None
    try: ns["validate_upload_overwrite"](str(target), policy, len(content), hashlib.sha256(content).hexdigest(), original)
    except ValueError: pass
    else: raise AssertionError("unsafe overwrite accepted: " + policy)
    assert (target.read_bytes() if target.exists() else None) == before
reject(ns["normalize_overwrite_policy"](None), b"new")
reject(ns["normalize_overwrite_policy"]("never"), b"new")
ns["validate_upload_overwrite"](str(target), ns["normalize_overwrite_policy"]("always"), 11, hashlib.sha256(b"new-content").hexdigest())
# The guard authorizes replacement; no runtime or upload server is started.
assert target.read_text() == "old"
target.write_bytes(b"same")
original = ns["upload_target_snapshot"](str(target))
ns["validate_upload_overwrite"](str(target), "if_same_size", 4, hashlib.sha256(b"same").hexdigest(), original)
target.write_bytes(b"evil")
reject("if_same_size", b"same", original)  # equal size mutation must fail SHA256
# Presence changes on either side of initialization must also reject.
missing = root / "new.yaml"
empty = ns["upload_target_snapshot"](str(missing))
missing.write_bytes(b"same")
try: ns["validate_upload_overwrite"](str(missing), "if_same_size", 4, hashlib.sha256(b"same").hexdigest(), empty)
except ValueError: pass
else: raise AssertionError("new file race accepted")
# Rename only a fixture, retaining the original and its evidence.
target.rename(root / "retained-plan.yaml")
reject("if_same_size", b"same", original)
print(json.dumps({"ok": True, "root": str(root), "retained": str(root / "retained-plan.yaml")}))
