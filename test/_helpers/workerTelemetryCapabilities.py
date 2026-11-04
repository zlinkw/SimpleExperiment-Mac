"""Evaluate the shipped capability producer only; no Agent entry point or server access."""
import ast
import json
import pathlib
import re
import os
import sys
import hashlib
import tempfile
from unittest.mock import patch

repo = pathlib.Path(__file__).resolve().parents[2]
runtime_root = pathlib.Path(os.environ.get("SIMPLE_PROTOCOL_RUNTIME_ROOT", repo / "dist/runtime"))
runtime = runtime_root / "cluster_agent.py"
tree = ast.parse(runtime.read_text(encoding="utf-8"))
constants = {"SCHEMA_VERSION", "API_VERSION", "AGENT_VERSION", "RUNTIME_VERSION", "PLUGIN_VERSION",
             "WORKER_RESULT_ACTIONS", "WORKER_TENSORBOARD_ACTIONS", "WORKER_ENV_ACTIONS"}
body = [node for node in tree.body if isinstance(node, ast.FunctionDef)
        and node.name in ("api_capabilities", "scheduler_protocol_report", "formal_job_path_capable", "execution_shell_preflight_capable", "task_shell_environment_capable", "staged_job_preflight_capable", "project_managed_validation_capable")
        or isinstance(node, ast.Assign) and any(getattr(target, "id", "") in constants for target in node.targets)]
selected_scheduler = runtime_root / "cluster_scheduler.py"
namespace = {"re": re, "os": os, "hashlib": hashlib, "cluster_scheduler_path": lambda root: str(selected_scheduler)}
exec(compile(ast.Module(body=body, type_ignores=[]), str(runtime), "exec"), namespace)
capabilities = namespace["api_capabilities"](str(repo), mode="worker_telemetry")
assert capabilities["endpoints"]["declaredJobPaths"] is True, "packaged Scheduler protocol/version mismatch"
assert capabilities["endpoints"]["executionShellPreflight"] == 1, "packaged Scheduler shell-preflight protocol/version mismatch"
assert capabilities["endpoints"]["taskShellEnvironment"] == 1, "packaged Scheduler task-shell library protocol/version mismatch"
assert capabilities["endpoints"]["stagedJobPreflight"] == 1, "packaged Scheduler staged preflight protocol/version mismatch"
assert capabilities["endpoints"]["originalSourceHashDiagnostic"] == 1
assert capabilities["endpoints"]["projectManagedValidation"] == 1
assert capabilities["endpoints"]["completedOutputPreflight"] == 1
if "--regression" not in sys.argv:
    print(json.dumps(capabilities, ensure_ascii=False))
else:
    original = selected_scheduler.read_bytes()
    scheduler_tree = ast.parse(original.decode("utf-8"))
    bundle = next(node.value.value for node in scheduler_tree.body if isinstance(node, ast.Assign)
                  and any(isinstance(target, ast.Name) and target.id == "RUNTIME_PYYAML_BUNDLE" for target in node.targets))
    assert len(bundle) > 8192, "regression must exercise the actual large offline dependency, not a thin source fixture"
    root = pathlib.Path(tempfile.mkdtemp(prefix="scheduler-protocol-"))
    reports = []
    responses = {}
    def inspect(name, raw, expected_status, failed=()):
        global selected_scheduler
        selected_scheduler = root/(name+".py")
        selected_scheduler.write_bytes(raw)
        namespace["AGENT_LIFECYCLE_IDENTITY"] = {"runtimeFiles": {"cluster_scheduler.py": hashlib.sha256(raw).hexdigest()}}
        response = namespace["api_capabilities"](str(root), mode="worker_telemetry")
        report = response["schedulerProtocol"]
        assert report["status"] == expected_status, report
        for key in failed: assert not response["endpoints"][key], (key, response)
        reports.append({"case": name, "status": expected_status})
        responses[name] = response
        return report
    good = inspect("packaged", original, "ok")
    assert good["pairedHashVerified"]
    # Valid assignments remain visible regardless of unrelated data layout.
    expanded = original.decode("utf-8").replace('RUNTIME_PYYAML_BUNDLE = ', 'UNRELATED_DATA = '+repr("p"*150000)+'\nRUNTIME_PYYAML_BUNDLE = ', 1)
    assert inspect("expanded_layout", expanded.encode(), "ok")["capabilities"] == good["capabilities"]
    failures_by_protocol = {
        "FORMAL_JOB_PATH_PROTOCOL": list(good["capabilities"]),
        "FORMAL_JOB_IDENTITY_ENV_PROTOCOL": list(good["capabilities"]),
        "EXECUTION_SHELL_PREFLIGHT_PROTOCOL": ["executionShellPreflight","taskShellEnvironment","stagedJobPreflight"],
        "TASK_SHELL_ENVIRONMENT_PROTOCOL": ["taskShellEnvironment","stagedJobPreflight"],
        "FORMAL_JOB_PREFLIGHT_STAGES_PROTOCOL": ["stagedJobPreflight"],
        "PROJECT_MANAGED_VALIDATION_PROTOCOL": ["projectManagedValidation","completedOutputPreflight"],
    }
    for key, failures in failures_by_protocol.items():
        changed = ast.parse(original.decode("utf-8"))
        changed.body = [node for node in changed.body if not (isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == key for target in node.targets))]
        changed.body.append(ast.Assign(targets=[ast.Name(id="UNCONSUMED_MARKER",ctx=ast.Store())],value=ast.Constant(key+" = 1")))
        report = inspect("missing_"+key, ast.unparse(ast.fix_missing_locations(changed)).encode(), "unsupported", failures)
        assert any(key in values for values in report["missing"].values()), report
    bad = ast.parse(original.decode("utf-8"))
    for node in bad.body:
        if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='RUNTIME_VERSION' for target in node.targets): node.value=ast.Constant("0.0.1")
    inspect("version_mismatch", ast.unparse(bad).encode(), "version_mismatch", good["capabilities"])
    changed=ast.parse(original.decode("utf-8"))
    changed.body=[node for node in changed.body if not (isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='RUNTIME_VERSION' for target in node.targets))]
    inspect("missing_version",ast.unparse(changed).encode(),"parse_error",good["capabilities"])
    changed=ast.parse(original.decode("utf-8"))
    for node in changed.body:
        if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='PROJECT_MANAGED_VALIDATION_PROTOCOL' for target in node.targets): node.value=ast.Constant(0)
    inspect("disabled_protocol",ast.unparse(changed).encode(),"unsupported",["projectManagedValidation","completedOutputPreflight"])
    inspect("syntax_error", original+b'\ndef broken(\n', "parse_error", good["capabilities"])
    inspect("invalid_utf8", b'\xff', "parse_error", good["capabilities"])
    inspect("duplicate", original+b'\nPROJECT_MANAGED_VALIDATION_PROTOCOL = 1\n', "parse_error", good["capabilities"])
    changed=ast.parse(original.decode("utf-8"))
    changed.body=[node for node in changed.body if not isinstance(node,ast.FunctionDef) or node.name!='formal_job_preflight_report']
    inspect("missing_implementation", ast.unparse(changed).encode(), "unsupported", ["stagedJobPreflight","projectManagedValidation","completedOutputPreflight"])
    inspect("oversized_runtime", b' '*(8*1024*1024+1), "read_error", good["capabilities"])
    selected_scheduler = runtime_root / "cluster_scheduler.py"
    namespace["AGENT_LIFECYCLE_IDENTITY"] = {"runtimeFiles": {"cluster_scheduler.py": "0"*64}}
    mismatch = namespace["api_capabilities"](str(root))
    assert mismatch['schedulerProtocol']['status']=='runtime_mismatch'
    assert not any(mismatch['schedulerProtocol']['capabilities'].values())
    responses['runtime_mismatch']=mismatch
    with patch('builtins.open',side_effect=PermissionError('fixture permission denied')):
        unreadable = namespace['api_capabilities'](str(root))
    assert unreadable['schedulerProtocol']['status']=='read_error' and not any(unreadable['schedulerProtocol']['capabilities'].values())
    responses['permission_denied']=unreadable
    selected_scheduler=root/'not-created.py'
    missing=namespace['api_capabilities'](str(root))
    assert missing['schedulerProtocol']['status']=='read_error' and not any(missing['schedulerProtocol']['capabilities'].values())
    responses['missing_file']=missing
    print(json.dumps({"capabilities": capabilities, "responses": responses, "cases": reports, "fixture": str(root)},ensure_ascii=False))
