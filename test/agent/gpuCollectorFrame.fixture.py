"""GPU collector frame/admission semantics on EXTRACTED production functions only
(extract_runtime_functions — never the module entry point). argv: <mode> <root>.
The root directory is provided by the Node driver and kept for audit; nothing is
deleted. Runs identically under Linux python3 and WSL /usr/bin/python3."""
import json
import os
import pathlib
import sys
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions

MODE = sys.argv[1]
ROOT = sys.argv[2]
os.environ["SIMPLE_GPU_COLLECTOR_FRESH_MS"] = "5000"
os.environ["SIMPLE_GPU_ADMISSION_WAIT_SECONDS"] = "0.4"

agent = extract_runtime_functions(
    str(pathlib.Path(__file__).resolve().parents[2] / "dist" / "runtime" / "cluster_agent.py"),
    ["gpu_admission_recheck_evidence", "gpu_admission_probe", "read_gpu_collector_frame",
     "gpu_collector_self_heal", "gpu_collector_main", "gpu_collector_ensure",
     "gpu_collector_read_registration", "gpu_collector_command", "task_execution_inventory", "task_queue_command"])

# The isolated module namespace has no __file__; production gpu_collector_command
# resolves the runtime script through it — bind it to the real generated file.
agent.__file__ = str(pathlib.Path(__file__).resolve().parents[2] / "dist" / "runtime" / "cluster_agent.py")
EVENTS = []
GPU_PROBES = []
# CALLS counts ACTUAL sampler invocations (len(GPU_PROBES) alone could not tell
# "no second sampler ran" apart from bookkeeping of queued canned answers).
CALLS = []
TMUX_CALLS = []
TMUX_SCRIPT = []
agent.EVENTS = EVENTS
agent.append_event = lambda root, event: EVENTS.append(event)


def stub_collect():
    CALLS.append(1)
    if GPU_PROBES:
        return GPU_PROBES.pop(0)
    return [{"index": 0, "memoryUsedMb": 100, "memoryTotalMb": 8000, "utilizationPercent": 3}], ""


agent.collect_local_gpu = stub_collect


def state_root():
    return os.path.join(ROOT, "worker-state")


os.environ["SIMPLE_EXPERIMENT_WORKER_STATE_DIR"] = state_root()


def frame_path(worker, root):
    return agent.gpu_collector_frame_path(worker, root)


def register_path(worker, root):
    return agent.gpu_collector_register_path(worker, root)


def write_frame(worker, root, epoch, seq, mono=None, gpus=None, completeness="full"):
    frame = {"schemaVersion": 1, "frameSource": agent.GPU_COLLECTOR_SOURCE, "workerId": worker,
             "epoch": epoch, "seq": seq, "collectedAt": agent.now_iso(),
             "collectedMonotonicMs": int(time.monotonic() * 1000) if mono is None else mono,
             "status": "ok", "error": "", "completeness": completeness, "runtimeVersion": agent.RUNTIME_VERSION,
             "gpu": gpus or [{"index": 0}], "gpus": gpus or [{"index": 0}]}
    agent.atomic_write(frame_path(worker, root), frame)
    return frame


def publish_generation(worker, root, epoch, **overrides):
    registration = {"frameSource": agent.GPU_COLLECTOR_SOURCE, "workerId": worker,
                    "framePath": frame_path(worker, root), "epoch": epoch,
                    "runningVersion": agent.RUNTIME_VERSION,
                    "uid": os.getuid() if hasattr(os, "getuid") else -1,
                    "genStartedMonotonicMs": int(time.monotonic() * 1000)}
    registration.update(overrides)
    agent.atomic_write(register_path(worker, root), registration)
    return registration


def finish(payload):
    print(json.dumps({"ok": True, "mode": MODE, "root": ROOT, "detail": payload}, ensure_ascii=False))


class FakeCompleted:
    def __init__(self, returncode, stdout, stderr):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


class FakeProc:
    @staticmethod
    def run(args, capture_output=None, text=None, timeout=None):
        TMUX_CALLS.append([str(a) for a in args])
        if TMUX_SCRIPT:
            return TMUX_SCRIPT.pop(0)
        return FakeCompleted(1, "", "fixture default: no session")


def main():
    if MODE == "identity":
        root = os.path.join(ROOT, "proj1")
        assert agent.gpu_collector_frame_path("worker-a", os.path.join(ROOT, "proj1")) == \
            agent.gpu_collector_frame_path("worker-a", os.path.join(ROOT, "proj2"))
        assert agent.gpu_collector_frame_path("worker-a", root) != agent.gpu_collector_frame_path("worker-b", root)
        s1 = agent.gpu_collector_session("worker-a", os.path.join(ROOT, "proj1"))
        s2 = agent.gpu_collector_session("worker-a", os.path.join(ROOT, "proj2"))
        assert s1 == s2 and s1.startswith("se-gpu-collector-"), (s1, s2)
        cmd = agent.gpu_collector_command("worker-a", root)
        # The command carries the RESOLVED authoritative root (parent A): both
        # sides must resolve the identical anchor even with unset environments.
        assert "SIMPLE_EXPERIMENT_WORKER_STATE_DIR=" + state_root() in cmd, cmd
        queue_cmd = agent.task_queue_command(root, "worker-a")
        assert "SIMPLE_EXPERIMENT_WORKER_STATE_DIR=" + state_root() in queue_cmd, queue_cmd
        assert "SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX=" in cmd, cmd
        # Zero-config: no env var at all → managed per-USER anchor, identical on
        # every consumer and on the launched collector; NEVER a per-project root.
        del os.environ["SIMPLE_EXPERIMENT_WORKER_STATE_DIR"]
        os.environ["HOME"] = os.path.join(ROOT, "fake-home")
        anchor = agent.gpu_collector_state_root(root)
        assert anchor == os.path.join(ROOT, "fake-home", ".simple-cluster", "worker-state"), anchor
        cmd2 = agent.gpu_collector_command("worker-a", root)
        assert "SIMPLE_EXPERIMENT_WORKER_STATE_DIR=" + anchor in cmd2, cmd2
        # An injected authoritative value beats the anchor everywhere (template).
        os.environ["SIMPLE_EXPERIMENT_WORKER_STATE_DIR"] = state_root()
        assert agent.gpu_collector_state_root(root) == state_root()
        finish({"session": s1, "anchor": anchor})
    elif MODE == "writer_lock":
        import fcntl
        root = os.path.join(ROOT, "project")
        worker = "worker-a"
        target = frame_path(worker, root)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target + ".writer.lock", "a+") as owner:
            fcntl.flock(owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                agent.gpu_collector_main(root, worker)
                raise AssertionError("second writer acquired the machine source")
            except RuntimeError as exc:
                assert str(exc) == "GPU_COLLECTOR_WRITER_BUSY", str(exc)
        assert CALLS == []
        assert not os.path.exists(register_path(worker, root))
        finish({"samplerCalls": len(CALLS)})
    elif MODE == "reads":
        root = os.path.join(ROOT, "proj1")
        worker = "worker-a"
        assert agent.read_gpu_collector_frame(worker, root)["mode"] == "absent"
        publish_generation(worker, root, "gen-1")
        write_frame(worker, root, "gen-1", 7)
        got = agent.read_gpu_collector_frame(worker, root)
        assert got["mode"] == "fresh" and got["frame"]["seq"] == 7, got
        write_frame(worker, root, "gen-1", 8, mono=int(time.monotonic() * 1000) - 60000)
        assert agent.read_gpu_collector_frame(worker, root)["mode"] == "stale"
        write_frame(worker, root, "gen-1", 9, mono=int(time.monotonic() * 1000) + 60000)
        assert agent.read_gpu_collector_frame(worker, root)["mode"] == "stale"
        # Late OLD-generation frame under a current registration: never fresh.
        publish_generation(worker, root, "gen-2")
        write_frame(worker, root, "gen-1", 999, gpus=[{"index": 0}])
        stale = agent.read_gpu_collector_frame(worker, root)
        assert stale["mode"] == "stale" and stale.get("reason") == "generation", stale
        # Foreign identity is never consumed.
        publish_generation(worker, root, "gen-3")
        write_frame(worker, root, "gen-3", 1)
        foreign = json.loads(open(frame_path(worker, root), encoding="utf-8").read())
        foreign["workerId"] = "worker-z"
        agent.atomic_write(frame_path(worker, root), foreign)
        assert agent.read_gpu_collector_frame(worker, root)["mode"] == "foreign"
        # REAL-SEMANTICS ENOTDIR: with the namespace parent a FILE, os.path.isfile
        # returns False (would fake "absent" and open the legacy door); the real
        # stat raises ENOTDIR → must be unreadable.
        base = os.path.dirname(os.path.dirname(frame_path("worker-ns", root)))
        os.makedirs(base, exist_ok=True)
        victim_ns_path = agent.gpu_collector_frame_path("worker-ns", root)
        victim_ns_dir = os.path.dirname(victim_ns_path)
        os.makedirs(os.path.dirname(victim_ns_dir), exist_ok=True)
        with open(victim_ns_dir, "w", encoding="utf-8") as handle:
            handle.write("not-a-directory")
        assert agent.read_gpu_collector_frame("worker-ns", root)["mode"] == "unreadable"
        # Registration on a corrupt file: invalid (never absent) → frame unknown.
        corrupt_worker = "worker-corrupt"
        os.makedirs(os.path.dirname(register_path(corrupt_worker, root)), exist_ok=True)
        with open(register_path(corrupt_worker, root), "w", encoding="utf-8") as handle:
            handle.write("{trunc")
        write_frame(corrupt_worker, root, "gen-1", 1)
        assert agent.gpu_collector_read_registration(corrupt_worker, root)["mode"] == "unreadable"
        assert agent.read_gpu_collector_frame(corrupt_worker, root)["mode"] == "unknown"
        # Bounded read: a pathological 100KB frame never enters the fast loop.
        big_worker = "worker-big"
        publish_generation(big_worker, root, "gen-1")
        os.makedirs(os.path.dirname(frame_path(big_worker, root)), exist_ok=True)
        with open(frame_path(big_worker, root), "w", encoding="utf-8") as handle:
            handle.write("{" + '"x":"' + "y" * 120000 + '"}')
        assert agent.read_gpu_collector_frame(big_worker, root)["mode"] == "unreadable"
        # Frame present WITHOUT a valid registration: unregistered, never consumed.
        nogood = "worker-noreg"
        write_frame(nogood, root, "gen-x", 3)
        assert agent.read_gpu_collector_frame(nogood, root)["mode"] == "unregistered"
        # Registration valid but frame gone: stalled (not absent!).
        stall = "worker-stall"
        publish_generation(stall, root, "gen-1")
        assert agent.read_gpu_collector_frame(stall, root)["mode"] == "stalled"
        # Registration field validation (parent B): forged uid / non-finite start
        # / relative framePath / empty epoch are all invalid, never "registered".
        bad = "worker-badreg"
        publish_generation(bad, root, "gen-1", uid="root")
        assert agent.gpu_collector_read_registration(bad, root)["mode"] == "invalid"
        publish_generation(bad, root, "gen-1", uid=True)
        assert agent.gpu_collector_read_registration(bad, root)["mode"] == "invalid"
        publish_generation(bad, root, "gen-1", genStartedMonotonicMs=float("nan"))
        assert agent.gpu_collector_read_registration(bad, root)["mode"] == "invalid"
        publish_generation(bad, root, "gen-1", genStartedMonotonicMs=-1)
        assert agent.gpu_collector_read_registration(bad, root)["mode"] == "invalid"
        publish_generation(bad, root, "gen-1", framePath="relative/path")
        assert agent.gpu_collector_read_registration(bad, root)["mode"] == "invalid"
        # Well-typed foreign roots and UID values are not this reader's source.
        for changes in ({"framePath": os.path.join(ROOT, "foreign", "gpu_frame.json")},
                        {"uid": os.getuid() + 1}, {"uid": -1}):
            publish_generation(bad, root, "gen-1", **changes)
            write_frame(bad, root, "gen-1", 1)
            assert agent.gpu_collector_read_registration(bad, root)["mode"] == "foreign"
            assert agent.read_gpu_collector_frame(bad, root)["mode"] != "fresh"
            assert agent.gpu_admission_probe_bound(root, bad, {"commandId": "foreign"})[2] is None
        # Permission semantics probe: honest about the mount's capability. If the
        # filesystem enforces mode 000, a permission denial must be unreadable.
        perm = "worker-perm"
        publish_generation(perm, root, "gen-1")
        write_frame(perm, root, "gen-1", 1)
        try:
            os.chmod(frame_path(perm, root), 0o000)
            denials_work = False
            try:
                os.stat(frame_path(perm, root))
            except PermissionError:
                denials_work = True
            finally:
                os.chmod(frame_path(perm, root), 0o600)
            if denials_work:
                os.chmod(frame_path(perm, root), 0o000)
                try:
                    assert agent.read_gpu_collector_frame(perm, root)["mode"] == "unreadable"
                finally:
                    os.chmod(frame_path(perm, root), 0o600)
            finish({"permissionSemantics": "enforced-and-verified" if denials_work else "mount-does-not-enforce-000"})
        except OSError:
            finish({"permissionSemantics": "chmod-unavailable"})
    elif MODE == "main_loop":
        root = os.path.join(ROOT, "proj1")
        worker = "worker-a"
        counter = [0]

        def counting_collect():
            counter[0] += 1
            return [{"index": 0, "memoryUsedMb": counter[0]}], ""

        agent.collect_local_gpu = counting_collect
        errors = []

        def loop():
            try:
                agent.gpu_collector_main(root, worker, poll_seconds=0.5)
            except Exception as exc:
                errors.append(repr(exc))

        threading.Thread(target=loop, daemon=True).start()
        deadline = time.monotonic() + 6.0
        frame = None
        while time.monotonic() < deadline:
            observed = agent.read_gpu_collector_frame(worker, root)
            # Wait for the SECOND frame specifically: one frame only proves the
            # loop ran once, not that it keeps advancing.
            if observed["mode"] == "fresh" and int(observed["frame"]["seq"]) >= 2:
                frame = observed["frame"]
                break
            time.sleep(0.05)
        assert frame and int(frame["seq"]) >= 2, frame
        registration = agent.gpu_collector_read_registration(worker, root)
        assert registration["mode"] == "registered", registration
        assert registration["registration"]["epoch"] == frame["epoch"]
        assert not errors, errors
        finish({"seq": frame["seq"], "epoch": frame["epoch"]})
    elif MODE == "causality":
        root = os.path.join(ROOT, "proj1")
        worker = "worker-a"
        publish_generation(worker, root, "gen-1")
        write_frame(worker, root, "gen-1", 10)
        time.sleep(0.05)
        # Already-collecting-before-the-request sample: seq advances, start does
        # not cross the request boundary → rejected (rev-0 accepted this).
        write_frame(worker, root, "gen-1", 11, mono=int(time.monotonic() * 1000) - 500)
        gpus, error, evidence = agent.gpu_admission_probe_bound(root, worker, {"commandId": "cmd-x"})
        assert gpus == [] and "gpu_collector_stalled" in error, (gpus, error)
        assert evidence is None and CALLS == []

        def advancer():
            time.sleep(0.1)
            write_frame(worker, root, "gen-1", 12, gpus=[{"index": 0, "memoryUsedMb": 4242}])

        threading.Thread(target=advancer).start()
        gpus, error, evidence = agent.gpu_admission_probe_bound(root, worker, {"commandId": "cmd-x"})
        assert error == "" and gpus[0]["memoryUsedMb"] == 4242, (gpus, error)
        assert evidence["epoch"] == "gen-1" and evidence["seq"] == 12 and evidence["commandId"] == "cmd-x"
        finish({"accepted": evidence["seq"]})
    elif MODE == "generation":
        root = os.path.join(ROOT, "proj1")
        worker = "worker-a"
        publish_generation(worker, root, "gen-1")
        write_frame(worker, root, "gen-1", 100)
        time.sleep(0.05)

        def restart():
            time.sleep(0.1)
            publish_generation(worker, root, "gen-2")
            write_frame(worker, root, "gen-2", 1, gpus=[{"index": 0, "memoryUsedMb": 777}])

        threading.Thread(target=restart).start()
        gpus, error, evidence = agent.gpu_admission_probe_bound(root, worker, {"commandId": "cmd-r"})
        assert error == "" and gpus[0]["memoryUsedMb"] == 777, (gpus, error)
        assert evidence["epoch"] == "gen-2" and evidence["seq"] == 1
        time.sleep(0.05)
        write_frame(worker, root, "gen-1", 999, gpus=[{"index": 0, "memoryUsedMb": 666}])
        gpus2, error2, _ = agent.gpu_admission_probe_bound(root, worker, {"commandId": "cmd-r"})
        assert gpus2 == [] and "gpu_collector_stalled" in error2, (gpus2, error2)
        assert CALLS == []
        finish({"followed": evidence["epoch"]})
    elif MODE == "evidence":
        root = os.path.join(ROOT, "proj1")
        worker = "worker-a"
        publish_generation(worker, root, "gen-9")

        def advancer():
            time.sleep(0.05)
            write_frame(worker, root, "gen-9", 4, gpus=[{"index": 0, "memoryUsedMb": 111}])

        threading.Thread(target=advancer).start()
        gpus, error, evidence = agent.gpu_admission_probe_bound(root, worker, {"commandId": "cmd-1"})
        assert error == "" and evidence["seq"] == 4, (gpus, error, evidence)
        for field in ("workerId", "root", "commandId", "epoch", "seq", "collectedMonotonicMs", "gpuIds", "fingerprint"):
            assert evidence.get(field), field
        same, err = agent.gpu_admission_recheck_evidence(root, worker, evidence, {"commandId": "cmd-1"})
        assert err == "" and same[0]["memoryUsedMb"] == 111, (same, err)
        late_request = dict(evidence, requestStartedMonotonicMs=evidence["collectedMonotonicMs"] + 1)
        assert agent.gpu_admission_recheck_evidence(root, worker, late_request, {"commandId": "cmd-1"})[1] == "gpu_admission_evidence_request_fence"
        # Same Worker, DIFFERENT command: credential is worthless (parent D).
        _, err_cmd = agent.gpu_admission_recheck_evidence(root, worker, evidence, {"commandId": "cmd-OTHER"})
        assert err_cmd == "gpu_admission_evidence_command_mismatch", err_cmd
        # Second project, same worker id: root binding rejects (parent D).
        _, err_root = agent.gpu_admission_recheck_evidence(os.path.join(ROOT, "proj2"), worker, evidence, {"commandId": "cmd-1"})
        assert err_root == "gpu_admission_evidence_root_mismatch", err_root
        # Missing field (no defaults, never the caller's default worker):
        stripped = dict(evidence)
        del stripped["commandId"]
        _, err_missing = agent.gpu_admission_recheck_evidence(root, worker, stripped, {"commandId": "cmd-1"})
        assert err_missing.startswith("gpu_admission_evidence_missing"), err_missing
        _, err_missing2 = agent.gpu_admission_recheck_evidence(root, "", stripped, {"commandId": "cmd-1"})
        assert err_missing2.startswith("gpu_admission_evidence_missing"), err_missing2
        # Same seq/epoch/mono but tampered VALUES: fingerprint catches it.
        write_frame(worker, root, "gen-9", 4, mono=evidence["collectedMonotonicMs"],
                    gpus=[{"index": 0, "memoryUsedMb": 999999}])
        _, err_fp = agent.gpu_admission_recheck_evidence(root, worker, evidence, {"commandId": "cmd-1"})
        assert err_fp == "gpu_admission_evidence_changed", err_fp
        # A later frame invalidates the credential, and a rollback cannot become fresh.
        write_frame(worker, root, "gen-9", 5)
        _, err2 = agent.gpu_admission_recheck_evidence(root, worker, evidence, {"commandId": "cmd-1"})
        assert err2 == "gpu_admission_evidence_changed", err2
        write_frame(worker, root, "gen-9", 4, mono=evidence["collectedMonotonicMs"])
        assert agent.read_gpu_collector_frame(worker, root)["reason"] == "ordering"
        # Exact frame back, but the published generation moved: the SHARED reader
        # now refuses the old-epoch frame as not-fresh BEFORE recheck's own
        # generation guard (which stays as the race-window backstop) — either way
        # the credential is dead and NO sampling runs (equivalent fail-closed).
        write_frame(worker, root, "gen-9", 4, mono=evidence["collectedMonotonicMs"],
                    gpus=[{"index": 0, "memoryUsedMb": 111}])
        publish_generation(worker, root, "gen-10")
        gpus3, err3 = agent.gpu_admission_recheck_evidence(root, worker, evidence, {"commandId": "cmd-1"})
        assert gpus3 == [] and err3 in ("gpu_admission_evidence_frame_not_fresh",
                                        "gpu_admission_evidence_generation_changed"), err3
        assert CALLS == []
        finish({"fields": sorted(evidence.keys())})
    elif MODE == "capability":
        root = os.path.join(ROOT, "proj-legacy")
        worker = "worker-a"
        GPU_PROBES.append(([{"index": 0, "direct": True}], ""))
        gpus, error, evidence = agent.gpu_admission_probe_bound(root, worker, {"commandId": "cmd-l"})
        assert "gpu_collector_stalled" in error and gpus == [] and evidence is None
        assert len(CALLS) == 0, CALLS
        # Frame without ANY registration (needs update): error, NO direct sample.
        orphan = os.path.join(ROOT, "proj-orphan")
        write_frame(worker, orphan, "gen-old", 3, mono=int(time.monotonic() * 1000) - 500)
        gpus2, error2, _ = agent.gpu_admission_probe_bound(orphan, worker, {"commandId": "cmd-o"})
        assert gpus2 == [] and error2 == "gpu_collector_needs_update", (gpus2, error2)
        assert len(CALLS) == 0, "frame-only state must never trigger direct sampling: %r" % CALLS
        # Registered + stale: waits, errors, never samples.
        stale_root = os.path.join(ROOT, "proj-stale")
        publish_generation(worker, stale_root, "gen-1")
        write_frame(worker, stale_root, "gen-1", 3, mono=int(time.monotonic() * 1000) - 60000)
        gpus3, error3, _ = agent.gpu_admission_probe_bound(stale_root, worker, {"commandId": "cmd-s"})
        assert gpus3 == [] and "gpu_collector_stalled" in error3, (gpus3, error3)
        assert len(CALLS) == 0, CALLS
        # Corrupt registration → unknown → error, no sampling.
        bad_root = os.path.join(ROOT, "proj-bad")
        os.makedirs(os.path.dirname(register_path(worker, bad_root)), exist_ok=True)
        with open(register_path(worker, bad_root), "w", encoding="utf-8") as handle:
            handle.write("nope")
        gpus4, error4, _ = agent.gpu_admission_probe_bound(bad_root, worker, {"commandId": "cmd-b"})
        assert gpus4 == [] and error4 == "gpu_collector_identity_unverified", (gpus4, error4)
        assert len(CALLS) == 0, CALLS
        finish({"samplerCalls": len(CALLS)})
    elif MODE == "ensure":
        root = os.path.join(ROOT, "proj1")
        worker = "worker-a"
        path = frame_path(worker, root)
        own = {"frameSource": agent.GPU_COLLECTOR_SOURCE, "workerId": worker, "framePath": path,
               "epoch": "gen-live", "uid": os.getuid() if hasattr(os, "getuid") else -1, "runningVersion": agent.RUNTIME_VERSION}
        agent.subprocess = FakeProc()
        # Fresh start: no annotation write (the collector publishes its own).
        TMUX_CALLS.clear()
        TMUX_SCRIPT[:] = [FakeCompleted(1, "", "no session"), FakeCompleted(0, "@9\t%12", ""),
                          FakeCompleted(0, "@9\t%12\t0\t", ""), FakeCompleted(0, "", "")]
        report = agent.gpu_collector_ensure(worker, root)
        assert report["status"] == "started", report
        assert not any("set-option" in " ".join(c) and "@se_gpu_collector" in " ".join(c) for c in TMUX_CALLS)
        # Running: full identity verified, epoch comes from the collector.
        TMUX_CALLS.clear()
        TMUX_SCRIPT[:] = [FakeCompleted(0, "", ""), FakeCompleted(0, "@9\t%12\t0\t" + json.dumps(own), "")]
        report = agent.gpu_collector_ensure(worker, root)
        assert report["status"] == "running" and report["epoch"] == "gen-live", report
        assert not any("respawn" in " ".join(c) or "set-option" in " ".join(c) or "new-session" in " ".join(c) for c in TMUX_CALLS)
        TMUX_CALLS.clear()
        TMUX_SCRIPT[:] = [FakeCompleted(0, "", ""), FakeCompleted(0, "@9\t%12\tunknown\t" + json.dumps(own), "")]
        assert agent.gpu_collector_ensure(worker, root)["status"] == "unverified"
        assert len(TMUX_CALLS) == 2
        # Dead pane + OWN binding: respawn inside the exclusive transaction, lock
        # removed afterwards, exact pane target, no annotation write.
        # Script covers BOTH inspects: pre-transaction and inside-transaction
        # re-verify, then the respawn command itself.
        TMUX_CALLS.clear()
        TMUX_SCRIPT[:] = [FakeCompleted(0, "", ""), FakeCompleted(0, "@9\t%12\t1\t" + json.dumps(own), ""),
                          FakeCompleted(0, "@9\t%12\t1\t" + json.dumps(own), ""), FakeCompleted(0, "", "")]
        report = agent.gpu_collector_ensure(worker, root)
        assert report["status"] == "respawned" and report["paneId"] == "%12", report
        respawns = [c for c in TMUX_CALLS if "respawn-pane" in c]
        assert len(respawns) == 1 and respawns[0][respawns[0].index("-t") + 1] == "%12", respawns
        assert os.path.isfile(register_path(worker, root) + ".respawn.lock"), "stable lock inode must be retained"
        assert "-k" not in respawns[0], respawns
        # Dead pane + EMPTY binding (foreign or unpublished): unknown, zero mutation.
        TMUX_CALLS.clear()
        TMUX_SCRIPT[:] = [FakeCompleted(0, "", ""), FakeCompleted(0, "@9\t%12\t1\t", "")]
        report = agent.gpu_collector_ensure(worker, root)
        assert report["status"] == "unknown" and report.get("reason") == "unbound_dead_window", report
        assert not any("respawn" in " ".join(c) for c in TMUX_CALLS), TMUX_CALLS
        # Respawn transaction: a held lock means another ensure owns the restart.
        TMUX_CALLS.clear()
        TMUX_SCRIPT[:] = [FakeCompleted(0, "", ""), FakeCompleted(0, "@9\t%12\t1\t" + json.dumps(own), "")]
        os.makedirs(os.path.dirname(register_path(worker, root)), exist_ok=True)
        import fcntl
        held = os.open(register_path(worker, root) + ".respawn.lock", os.O_RDWR)
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        report = agent.gpu_collector_ensure(worker, root)
        assert report["status"] == "unknown" and report.get("reason") == "respawn_in_progress", report
        assert not any("respawn" in " ".join(c) for c in TMUX_CALLS), TMUX_CALLS
        os.close(held)
        # Transaction re-verify: pane came alive inside the window → no respawn-k.
        TMUX_CALLS.clear()
        TMUX_SCRIPT[:] = [FakeCompleted(0, "", ""), FakeCompleted(0, "@9\t%12\t1\t" + json.dumps(own), ""),
                          FakeCompleted(0, "@9\t%12\t0\t" + json.dumps(own), "")]
        report = agent.gpu_collector_ensure(worker, root)
        assert report["status"] == "starting", report
        assert not any("respawn" in " ".join(c) for c in TMUX_CALLS), TMUX_CALLS
        # Foreign frameSource / foreign uid / forged uid: refuse, zero mutation.
        for mutator, expected in (({"framePath": "/elsewhere/gpu_frame.json"}, "mismatch"),
                                  ({"uid": (os.getuid() if hasattr(os, "getuid") else 0) + 1000}, "foreign_uid"),
                                  ({"uid": "root"}, "mismatch"),
                                  ({"uid": -1}, "foreign_uid"),
                                  ({"frameSource": "other"}, "mismatch")):
            forged = dict(own)
            forged.update(mutator)
            TMUX_CALLS.clear()
            TMUX_SCRIPT[:] = [FakeCompleted(0, "", ""), FakeCompleted(0, "@9\t%12\t0\t" + json.dumps(forged), "")]
            report = agent.gpu_collector_ensure(worker, root)
            assert report["status"] == expected, (expected, report)
            assert len(TMUX_CALLS) == 2, TMUX_CALLS
        # Startup race: winner verified by FULL identity, not by non-emptiness.
        TMUX_CALLS.clear()
        TMUX_SCRIPT[:] = [FakeCompleted(1, "", "no session"), FakeCompleted(1, "", "duplicate session"),
                          FakeCompleted(0, "", ""), FakeCompleted(0, "@9\t%12\t0\t" + json.dumps(own), "")]
        report = agent.gpu_collector_ensure(worker, root)
        assert report["status"] == "race_won_by_other", report
        assert sum(1 for c in TMUX_CALLS if "new-session" in " ".join(c)) == 1, TMUX_CALLS
        foreign_winner = dict(own)
        foreign_winner["workerId"] = "worker-Z"
        TMUX_CALLS.clear()
        TMUX_SCRIPT[:] = [FakeCompleted(1, "", "no session"), FakeCompleted(1, "", "duplicate session"),
                          FakeCompleted(0, "", ""), FakeCompleted(0, "@9\t%12\t0\t" + json.dumps(foreign_winner), "")]
        assert agent.gpu_collector_ensure(worker, root)["status"] == "mismatch"
        TMUX_CALLS.clear()
        TMUX_SCRIPT[:] = [FakeCompleted(1, "", "no session"), FakeCompleted(1, "", "duplicate session"),
                          FakeCompleted(0, "", ""), FakeCompleted(0, "@9\t%12\t0\t", "")]
        assert agent.gpu_collector_ensure(worker, root)["status"] == "starting"
        finish({"statuses": "verified"})
    elif MODE == "inventory":
        root = os.path.join(ROOT, "proj1")
        worker = "worker-a"
        os.environ["SIMPLE_EXPERIMENT_WORKER_ID"] = worker
        acquires = []

        class CountingLock:
            def __init__(self):
                self.held = False

            def acquire(self, blocking=None):
                acquires.append(1)
                if self.held:
                    return False
                self.held = True
                return True

            def release(self):
                self.held = False

        agent.WORKER_GPU_SAMPLE_LOCK = CountingLock()
        agent.WORKER_GPU_SAMPLE_CACHE = {"sample": (time.monotonic(),
            {"gpu": [{"index": 9}], "gpus": [{"index": 9}], "source": "worker_agent_direct"})}
        agent.task_inventory = lambda root, execution_only=False: [
            {"commandId": "cmd-1", "projectId": "proj-1", "workerId": worker}]
        agent.local_stop_tmux_inventory = lambda root: []
        agent.task_option = lambda target, option: "[]"
        agent.task_queue_session = lambda root, worker: "sess"
        agent.task_safe_path = lambda root, path_value: path_value
        publish_generation(worker, root, "gen-1")
        write_frame(worker, root, "gen-1", 3, gpus=[{"index": 7}])
        inv = agent.task_execution_inventory(root)
        assert inv["gpuSampleState"] == "ready" and inv["gpuSample"]["frameSource"] == agent.GPU_COLLECTOR_SOURCE
        assert inv["gpuSample"]["seq"] == 3
        assert acquires == [], acquires
        # Registered but stale: honest "stale"; the legacy cache must NOT resurface.
        write_frame(worker, root, "gen-1", 3, mono=int(time.monotonic() * 1000) - 60000)
        inv2 = agent.task_execution_inventory(root)
        assert inv2["gpuSampleState"] == "stale" and inv2["gpuSample"] is None, inv2["gpuSampleState"]
        assert acquires == [], acquires
        # Unregistered (frame, no registration): honest, not ready.
        unreg = "worker-unreg"
        os.environ["SIMPLE_EXPERIMENT_WORKER_ID"] = unreg
        write_frame(unreg, root, "gen-old", 1)
        inv3 = agent.task_execution_inventory(root)
        assert inv3["gpuSampleState"] == "unregistered" and inv3["gpuSample"] is None, inv3["gpuSampleState"]
        assert acquires == [], acquires
        # Confirmed legacy (both ENOENT): the marked cache path stays (1 acquire).
        os.environ["SIMPLE_EXPERIMENT_WORKER_ID"] = "worker-never"
        inv4 = agent.task_execution_inventory(root)
        assert inv4["gpuSampleState"] == "stalled" and inv4["gpuSample"] is None
        assert len(acquires) == 0, acquires
        finish({"states": [inv["gpuSampleState"], inv2["gpuSampleState"], inv3["gpuSampleState"], inv4["gpuSampleState"]]})
    elif MODE == "concurrency":
        root = os.path.join(ROOT, "proj1")
        worker = "worker-a"
        publish_generation(worker, root, "gen-1")
        seen = []
        errors = []
        stop = threading.Event()

        def writer():
            seq = 0
            while not stop.is_set():
                seq += 1
                write_frame(worker, root, "gen-1", seq,
                            gpus=[{"index": 0, "memoryUsedMb": seq, "twin": seq}])
                time.sleep(0.001)

        def reader():
            try:
                last = 0
                while not stop.is_set():
                    got = agent.read_gpu_collector_frame(worker, root)
                    frame = got.get("frame")
                    if got.get("mode") == "fresh" and frame:
                        row = frame["gpus"][0]
                        assert row["memoryUsedMb"] == row["twin"] == frame["seq"], (row, frame["seq"])
                        if row["memoryUsedMb"] < last:
                            errors.append("regression %d after %d" % (row["memoryUsedMb"], last))
                        last = row["memoryUsedMb"]
                        seen.append(last)
            except Exception as exc:
                errors.append(repr(exc))

        writer_thread = threading.Thread(target=writer)
        writer_thread.start()
        readers = [threading.Thread(target=reader) for _ in range(8)]
        for thread in readers:
            thread.start()
        time.sleep(1.2)
        stop.set()
        writer_thread.join(timeout=5)
        for thread in readers:
            thread.join(timeout=5)
        assert errors == [], errors
        assert len(seen) > 10, len(seen)
        finish({"reads": len(seen)})
    else:
        raise SystemExit("unknown mode " + MODE)


main()
