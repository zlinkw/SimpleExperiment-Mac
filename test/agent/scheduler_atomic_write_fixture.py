import hashlib
import os
import sys
import stat
import threading
import tempfile
from pathlib import Path

source = sys.stdin.read()
marker = "def atomic_write_text(path: Path, text: str) -> None:"
start = source.index(marker)
end = source.find("\ndef ", start + len(marker))
namespace = {"Path": Path, "os": os, "hashlib": hashlib, "stat": stat, "threading": threading, "ATOMIC_WRITE_LOCKS": [threading.Lock() for _ in range(64)], "tempfile": tempfile}
exec(source[start:end], namespace)
atomic_write_text = namespace["atomic_write_text"]

with tempfile.TemporaryDirectory(prefix="scheduler-atomic-write-") as directory:
    target = Path(directory) / "scheduler_state.json"
    target.write_text("old", encoding="utf-8")
    atomic_write_text(target, "new-state")
    assert target.read_text(encoding="utf-8") == "new-state"
    assert sorted(item.name for item in Path(directory).iterdir()) == [target.name]

    original_replace = os.replace
    def fail_replace(_source, _target):
        raise PermissionError("injected replace failure")
    os.replace = fail_replace
    try:
        try:
            atomic_write_text(target, "uncommitted")
        except PermissionError as exc:
            assert "injected replace failure" in str(exc)
        else:
            raise AssertionError("replace failure was hidden")
    finally:
        os.replace = original_replace
    assert target.read_text(encoding="utf-8") == "new-state"
    assert sorted(item.name for item in Path(directory).iterdir()) == [target.name]

print("scheduler atomic write ok")
