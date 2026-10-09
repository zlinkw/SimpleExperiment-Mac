import os
import re
import sys

source = sys.stdin.read()
marker = "def scheduler_state_cleanup_owner_matches("
start = source.index(marker)
end = source.find("\ndef ", start + len(marker))
namespace = {"os": os, "re": re}
exec(source[start:end], namespace)
matches = namespace["scheduler_state_cleanup_owner_matches"]

originals = {name: getattr(os.path, name) for name in ("realpath", "abspath", "isdir", "islink", "isfile")}
try:
    root = os.path.normpath(os.path.join(os.getcwd(), "scheduler-state-owner-fixture"))
    state_dir = os.path.join(root, "simple_cluster", "tmp", "cluster_scheduler")
    file_path = os.path.join(state_dir, "plan-a-0123456789_state.json")
    norm = lambda value: os.path.normpath(str(value))
    os.path.realpath = norm
    os.path.abspath = norm
    os.path.isdir = lambda value: norm(value) == norm(state_dir)
    os.path.islink = lambda _value: False
    os.path.isfile = lambda value: norm(value) == norm(file_path)

    state = {
        "plan": "experiments/plans/a.yaml",
        "schedulerTerminal": True,
        "running_experiments": [],
        "testing_experiments": [],
        "cleanupOwner": {
            "schemaVersion": 1,
            "projectRoot": root,
            "planFile": "./experiments/plans/a.yaml",
            "operationId": "operation-a",
            "runId": "operation-a",
            "attemptId": "attempt-a",
            "purpose": "scheduler-state",
            "statePath": file_path,
        },
    }
    assert matches(root, file_path, state)

    rejected = [
        {**state, "schedulerTerminal": False},
        {**state, "running_experiments": [{"status": "running"}]},
        {**state, "cleanupOwner": {**state["cleanupOwner"], "projectRoot": root + "-other"}},
        {**state, "cleanupOwner": {**state["cleanupOwner"], "purpose": "shared-log"}},
        {**state, "cleanupOwner": {**state["cleanupOwner"], "attemptId": ""}},
        {**state, "cleanupOwner": {**state["cleanupOwner"], "runId": "other-run"}},
    ]
    assert all(not matches(root, file_path, candidate) for candidate in rejected)
    assert not matches(root, os.path.join(state_dir, "other", "plan-a-0123456789_state.json"), state)
finally:
    for name, value in originals.items():
        setattr(os.path, name, value)

print("scheduler state ownership ok")
