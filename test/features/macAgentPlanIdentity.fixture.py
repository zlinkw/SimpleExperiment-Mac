"""Compiled Agent functions only; in-memory queue, no research or remote process."""
import contextlib
import copy
import json
import pathlib
import sys
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions

agent = extract_runtime_functions(str(pathlib.Path(__file__).resolve().parents[2] / "dist/runtime/cluster_agent.py"), [
    "accept_durable_plan_job", "durable_plan_public_task", "durable_plan_same_identity",
    "_legacy_recall_identity_matches", "worker_task_matches_stop_identity", "cancel_durable_plan_job",
    "requeue_durable_plan_job", "drain_durable_plan_queue_once",
])
scenario = sys.argv[1]
plan_path = " experiments/plans/中文 A%20.yaml "
output_path = " experiments/runs/中文 A /attempts/1 "

def job(command="command"):
    return dict(projectId="project", workflowId="workflow", planFile=plan_path, planRevision="revision",
                codeFingerprint="code", experimentIndex=0, case="case", seed=42, attempt=1,
                outputDir=output_path, runKey=command, commandId=command, workerId="worker", planJobCount=1,
                executionMode="train", mode="train", action="start-worker-task", durablePlanQueue=True)

queue = {"schemaVersion": 1, "jobs": []}
events, writes, tasks, tombstones, launched = [], [], [], {}, []

def read_queue(_):
    return copy.deepcopy(queue)

def write_queue(_, data):
    writes.append(copy.deepcopy(data))
    queue.clear()
    queue.update(copy.deepcopy(data))

def tombstone(_, receipt):
    tombstones[receipt["commandId"]] = copy.deepcopy(receipt)
    return receipt

with contextlib.ExitStack() as scope:
    replacements = {
        "read_durable_plan_queue": read_queue, "write_durable_plan_queue": write_queue,
        "recalled_worker_command": lambda _, command: tombstones.get(command.get("commandId")),
        "write_worker_recall_tombstone": tombstone,
        "signal_durable_plan_queue_processor": lambda *args: None,
        "verified_durable_execution_mode": lambda *args: "train",
        "append_event": lambda _, event: events.append(copy.deepcopy(event)),
        "append_worker_task": lambda _, task: tasks.append(copy.deepcopy(task)),
        "reconcile_worker_task_exit_codes": lambda *args: None,
        "sync_durable_plan_task_rows": read_queue,
        "resolve_durable_code_sync_proof": lambda *args: {},
        "read_json": lambda *args: {"tasks": []},
        "path_for": lambda *args: "virtual-path",
        "_durable_gpu_busy_reason": lambda *args, **kwargs: "",
        "release_distributed_gpu_reservation": lambda *args: None,
    }
    for name, replacement in replacements.items():
        scope.enter_context(patch.object(agent, name, replacement))
    scope.enter_context(patch.dict(agent.DISTRIBUTED_GPU_RESERVATIONS, {}, clear=True))

    if scenario == "admission":
        receipt = agent.accept_durable_plan_job("virtual", job(), "worker")
        assert receipt["durableAccepted"] and receipt["planFile"] == plan_path and receipt["outputDir"] == output_path
        assert queue["jobs"][0]["planFile"] == plan_path and queue["jobs"][0]["outputDir"] == output_path
        public = agent.durable_plan_public_task(queue["jobs"][0])
        assert public["planFile"] == plan_path and public["outputDir"] == output_path
        assert events[0]["payload"]["planFile"] == plan_path
        agent.accept_durable_plan_job("virtual", job(), "worker")
        assert len(queue["jobs"]) == 1 and len(writes) == 1
        # Alias/options paths and numeric count compatibility remain available.
        aliased = job("options-job")
        aliased.pop("planFile")
        aliased.pop("outputDir")
        aliased.update(plan=plan_path, options={"outputDir": output_path, "planJobCount": "1"})
        assert agent.accept_durable_plan_job("virtual", aliased, "worker")["planFile"] == plan_path
        for value in [plan_path.strip(), plan_path.lower(), plan_path.replace("%20", " "), plan_path.replace("中文", "中 文")]:
            before = copy.deepcopy(queue), len(writes)
            try:
                agent.accept_durable_plan_job("virtual", {**job(), "planFile": value}, "worker")
            except ValueError:
                pass
            else:
                raise AssertionError("different path rebound the same command")
            assert (queue, len(writes)) == before

    elif scenario == "aliases":
        invalid = ["/absolute", "C:/drive", "plans\\a.yaml", "plans/../a.yaml", "plans/./a.yaml", "plans//a.yaml",
                   "plans/a.yaml/", "plans/\x00a.yaml", "plans/a\na.yaml", "plans/\x7fa.yaml", "a:b", 123, {}, [], True,
                   "中" * 1366]
        for field in ("planFile", "outputDir"):
            for value in invalid:
                before = copy.deepcopy(queue), len(writes), len(events)
                try:
                    agent.accept_durable_plan_job("virtual", {**job(), field: value}, "worker")
                except ValueError:
                    pass
                else:
                    raise AssertionError("bad path accepted: " + repr(value))
                assert (queue, len(writes), len(events)) == before
        for index, name in enumerate(["e\u0301.yaml", "\u00e9.yaml", "A.yaml", "a.yaml", "a.yaml "]):
            command = job("name-" + str(index))
            command["planFile"] = "experiments/plans/" + name
            agent.accept_durable_plan_job("virtual", command, "worker")
        assert len({row["planFile"] for row in queue["jobs"]}) == 5

    elif scenario == "recall":
        task = {**job(), "gpuId": "0"}
        request = {**task, "commandId": "stop", "targetCommandId": "command"}
        assert agent.worker_task_matches_stop_identity(request, task)
        assert agent._legacy_recall_identity_matches(request, task)
        for field in ("planFile", "outputDir"):
            for value in (task[field].strip(), task[field].lower(), task[field].replace("%20", " "), 123):
                if value == task[field]:
                    continue
                assert not agent.worker_task_matches_stop_identity({**request, field: value}, task)
                assert not agent._legacy_recall_identity_matches({**request, field: value}, task)
        # Old callers can still supply plan/case aliases, with exact path identity.
        legacy = dict(plan=plan_path, caseName="case", seed="42", attempt="1", workflowId="workflow",
                      planRevision="revision", outputDir=output_path, workerId="worker", gpuId="0")
        assert agent._legacy_recall_identity_matches(legacy, task)
        assert not agent._legacy_recall_identity_matches({**legacy, "plan": plan_path.strip()}, task)

    elif scenario == "cancel":
        agent.accept_durable_plan_job("virtual", job(), "worker")
        request = {**job(), "targetCommandId": "command", "commandId": "cancel", "gpuId": ""}
        for method in (agent.cancel_durable_plan_job, agent.requeue_durable_plan_job):
            for field in ("planFile", "outputDir"):
                before = copy.deepcopy(queue), len(writes), len(tasks), copy.deepcopy(tombstones)
                try:
                    method("virtual", {**request, field: request[field].strip()})
                except ValueError:
                    pass
                else:
                    raise AssertionError("wrong path changed queued job")
                assert (queue, len(writes), len(tasks), tombstones) == before
        receipt = agent.requeue_durable_plan_job("virtual", request)
        assert receipt["neverStarted"] and receipt["durableReleased"]
        assert receipt["planFile"] == plan_path and receipt["outputDir"] == output_path
        assert tombstones["command"]["planFile"] == plan_path
        assert queue["jobs"][0]["status"] == "cancelled"
        agent.accept_durable_plan_job("virtual", job("second"), "worker")
        second = {**job("second"), "targetCommandId": "second", "commandId": "cancel-second"}
        cancelled = agent.cancel_durable_plan_job("virtual", second)
        assert cancelled["planFile"] == plan_path and cancelled["outputDir"] == output_path
        # Typed identities cannot alias a string filename through str(value).
        row = {**job("typed"), "planFile": "123", "outputDir": "456", "status": "queued"}
        queue["jobs"] = [row]
        for field, value in (("planFile", 123), ("outputDir", 456)):
            before = copy.deepcopy(queue), len(writes)
            try:
                agent.cancel_durable_plan_job("virtual", {**row, field: value,
                    "commandId": "cancel-typed", "targetCommandId": "typed"})
            except ValueError:
                pass
            else:
                raise AssertionError("non-string path impersonated stored filename")
            assert (queue, len(writes)) == before

    elif scenario == "dispatch":
        agent.accept_durable_plan_job("virtual", job(), "worker")
        def execute(_, command, worker):
            launched.append(copy.deepcopy(command))
            return {"status": "running"}
        def drain():
            return agent.drain_durable_plan_queue_once("virtual", "worker", lambda: ([{"index": "0"}], ""), execute)
        assert drain()[0]["status"] == "running"
        assert launched[0]["planFile"] == plan_path and launched[0]["outputDir"] == output_path
        # Legacy malformed queued paths wait; they are never repaired and launched.
        queue["jobs"] = [{**job("legacy"), "status": "queued", "planFile": "plans\\wrong.yaml"}]
        assert drain() == [] and len(launched) == 1
        assert queue["jobs"][0]["codeBlocked"] and queue["jobs"][0]["planFile"] == "plans\\wrong.yaml"
        # Active rows stay untouched by the new admission guard.
        queue["jobs"][0]["status"] = "running"
        before = copy.deepcopy(queue), len(writes)
        assert drain() == [] and (queue, len(writes)) == before
    else:
        raise AssertionError("unknown scenario")

print(json.dumps({"scenario": scenario, "passed": True, "remoteOperations": 0}))
