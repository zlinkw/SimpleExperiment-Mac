"""Evaluate the shipped capability producer only; no Agent entry point or server access."""
import ast
import json
import pathlib
import re
import os

repo = pathlib.Path(__file__).resolve().parents[2]
runtime = repo / "dist/runtime/cluster_agent.py"
tree = ast.parse(runtime.read_text(encoding="utf-8"))
constants = {"SCHEMA_VERSION", "API_VERSION", "AGENT_VERSION", "RUNTIME_VERSION", "PLUGIN_VERSION",
             "WORKER_RESULT_ACTIONS", "WORKER_TENSORBOARD_ACTIONS", "WORKER_ENV_ACTIONS"}
body = [node for node in tree.body if isinstance(node, ast.FunctionDef)
        and node.name in ("api_capabilities", "formal_job_path_capable", "execution_shell_preflight_capable")
        or isinstance(node, ast.Assign) and any(getattr(target, "id", "") in constants for target in node.targets)]
namespace = {"re": re, "os": os, "cluster_scheduler_path": lambda root: str(repo / "dist/runtime/cluster_scheduler.py")}
exec(compile(ast.Module(body=body, type_ignores=[]), str(runtime), "exec"), namespace)
capabilities = namespace["api_capabilities"](str(repo), mode="worker_telemetry")
assert capabilities["endpoints"]["declaredJobPaths"] is True, "packaged Scheduler protocol/version mismatch"
assert capabilities["endpoints"]["executionShellPreflight"] == 1, "packaged Scheduler shell-preflight protocol/version mismatch"
print(json.dumps(capabilities, ensure_ascii=False))
