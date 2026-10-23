"""Extracted production queries against an isolated tmux; no project state files."""
import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "_helpers"))
from closeFixtureTmuxWindows import close_fixture_tmux_windows

tree = ast.parse(Path(sys.argv[1]).read_text(encoding="utf-8"))
names = {"task_tmux", "task_inventory", "task_read_job", "task_query", "task_public_observation", "local_stop_tmux_inventory"}
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert len(nodes) == len(names)
root = tempfile.mkdtemp(prefix="se-stop-race-")
socket = Path(root).name

class Tmux:
    @staticmethod
    def run(args, **kwargs):
        assert args[0] == "tmux" and "kill-server" not in args and "kill-session" not in args
        return subprocess.run(["tmux", "-L", socket, *args[1:]], **kwargs)

ns = dict(subprocess=Tmux, os=os, re=re, base64=base64, json=json, hashlib=hashlib,
          task_memory_scheduler_capability=lambda root: 0,
          now_iso=lambda: "2026-10-15T00:00:00Z", task_safe_path=lambda root, path: path,
          task_manifest_observation=lambda *_: None, task_queue_session=lambda *_: "controller",
          task_option=lambda *_: '["command"]')
exec(compile(ast.Module(body=nodes, type_ignores=[]), "stop_race", "exec"), ns)

def tmux(args):
    return ns["task_tmux"](args)

pane = tmux(["new-session", "-d", "-s", "race", "-P", "-F", "#{pane_id}", "sleep 30"])
window = tmux(["display-message", "-p", "-t", pane, "#{window_id}"])
query = dict(commandId="command", workerId="w", projectId="project", outputDir="work/job", lifecycleProtocol=2)
try:
    tmux(["set-option", "-w", "-t", pane, "@simple_experiment_command", "command"])
    tmux(["set-option", "-w", "-t", pane, "@simple_experiment_project", "project"])
    inventory = ns["local_stop_tmux_inventory"]
    def disappear(root):
        rows = inventory(root)
        # The window is closed after listing; no per-pane followup may fail the query.
        tmux(["kill-window", "-t", window])
        return rows
    ns["local_stop_tmux_inventory"] = disappear
    result = ns["task_query"](root, [query])
    assert result["queryComplete"] and not any(row["observation"].get("queryError") for row in result["tasks"]), result
    ns["local_stop_tmux_inventory"] = inventory
    result = ns["task_query"](root, [query])
    assert result["tasks"][0]["observation"]["cancelled"] and "tmux" not in result["tasks"][0]["observation"]
    print(json.dumps({"ok": True, "realTmux": True, "stateFilesRead": 0}))
finally:
    close_fixture_tmux_windows(lambda args: Tmux.run(["tmux", *args], capture_output=True, text=True, timeout=2), socket_name=socket)
