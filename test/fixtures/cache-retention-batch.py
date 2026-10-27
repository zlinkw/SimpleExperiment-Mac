import os, sys, json, re, hashlib, time, stat, tempfile, subprocess
from pathlib import Path
source = Path(sys.argv[1]).read_text(encoding="utf-8")
start = source.index("def observe_cache_paths(")
end = source.index("\ndef handle_action(", start)
def forbidden(*args):
    raise AssertionError("unrelated active-task inventory must not block cache retirement")
ns = dict(os=os, sys=sys, json=json, re=re, hashlib=hashlib, time=time, stat=stat,
          subprocess=subprocess, api_worker_tasks=forbidden, collect_scheduler=forbidden)
exec(source[start:end], ns)
root = tempfile.mkdtemp(prefix="cache-retention-batch-")
paths = ["simple_cluster/tmp/tmux_logs/一.log", "simple_cluster/console_logs/p/two.log"]
for item in paths:
    full = Path(root, item)
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text("new log without a seven-day wait", encoding="utf-8")
rows = ns["cache_cleanup_candidates"](root)
assert {item["path"] for item in rows} == set(paths)
assert all(item["state"] == "present" for item in ns["observe_cache_paths"](root, paths))
bindings = []
for item in rows:
    ns["cache_delete_exact_file"](root, item["path"], item["token"], batch=bindings)
assert all(Path(root, item).is_file() for item in paths), "preflight must not delete"
ns["cache_delete_confirmed_batch"](bindings)
assert not any(Path(root, item).exists() for item in paths)
assert all(item["state"] == "absent" for item in ns["observe_cache_paths"](root, paths))
# Replacing the verified direct parent with a symlink before execution must fail without touching
# the foreign target. The executor sees the physical cwd mismatch and stops the whole batch.
original = Path(root, "simple_cluster/tmp/tmux_logs")
original.mkdir(exist_ok=True)
target = original / "guard.log"
target.write_text("protected", encoding="utf-8")
row = next(item for item in ns["cache_cleanup_candidates"](root) if item["path"].endswith("guard.log"))
bindings = []
ns["cache_delete_exact_file"](root, row["path"], row["token"], batch=bindings)
moved = original.with_name("kept-parent")
original.rename(moved)
original.symlink_to(moved, target_is_directory=True)
try:
    ns["cache_delete_confirmed_batch"](bindings)
except ValueError as error:
    assert "PARENT_CD_FAILED" in str(error)
else:
    raise AssertionError("parent replacement was not rejected")
assert (moved / "guard.log").read_text(encoding="utf-8") == "protected"
print(json.dumps(dict(ok=True, youngLogs=True, batch=True, parentGuard=True)))
