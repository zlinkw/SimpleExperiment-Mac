"""Store one immutable source snapshot per plan and source revision."""

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
