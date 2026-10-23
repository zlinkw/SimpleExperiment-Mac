"""Real-tmux production-chain evidence for the GPU collector lifecycle, built on
the existing isolated-tmux-socket fixture convention (formalIdentityTmux.fixture.py):
extracted production functions only (never the module entry point), a private
per-run tmux server on its own socket (-L ... -f /dev/null) so no other session
is reachable, natural process exits instead of PID signals, and teardown that
only ever touches this run's own private server.
argv: <mode> <root> <state-file> <socket>
Modes: phase-a, phase-b, phase-c, phase-t, collector-loop (tmux child)."""
import json
import os
import pathlib
import shlex
import subprocess
import sys
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions

MODE = sys.argv[1]
ROOT = pathlib.Path(sys.argv[2]).resolve()
STATE = sys.argv[3]
SOCKET = sys.argv[4]
COLLECTOR_AGENT = str(pathlib.Path(__file__).resolve().parents[2] / "dist" / "runtime" / "cluster_agent.py")

agent = extract_runtime_functions(COLLECTOR_AGENT, [
    "gpu_collector_ensure", "gpu_collector_command", "gpu_collector_session",
    "gpu_collector_frame_path", "gpu_collector_register_path", "read_gpu_collector_frame",
    "gpu_collector_read_registration", "gpu_collector_main"])
agent.__file__ = COLLECTOR_AGENT

# Private tmux server (existing convention): every tmux call — including the
# ones inside the extracted production functions and inside the pane's collector
# child — resolves through this wrapper, so the run can neither see nor damage
# any pre-existing session; teardown closes only verified recorded windows. The socket
# name is shared across this run's phases by the driver (embedded in its own
# unique temp-dir name), never a foreign or default server.
WRAPPER_DIR = ROOT / "bin"
WRAPPER_DIR.mkdir(parents=True, exist_ok=True)
wrapper = WRAPPER_DIR / "tmux"
wrapper.write_text("#!/bin/sh\nexec /usr/bin/tmux -L " + shlex.quote(SOCKET) + " -f /dev/null \"$@\"\n",
                   encoding="utf-8")
# The execute bit is load-bearing: a NON-executable wrapper is silently skipped
# by PATH resolution, which would send the extracted functions' tmux calls to
# the shared default server instead of this run's private one.
os.chmod(wrapper, 0o755)
assert os.access(str(wrapper), os.X_OK), "tmux wrapper not executable; private server isolation would fail"
os.environ["PATH"] = str(WRAPPER_DIR) + os.pathsep + os.environ.get("PATH", "")


def tmux(*args, timeout=3):
    return subprocess.run([str(wrapper), *args], capture_output=True, text=True, timeout=timeout)


def finish(payload):
    print(json.dumps({"ok": True, "mode": MODE, "root": str(ROOT), "socket": SOCKET, "detail": payload},
                     ensure_ascii=False))


def load_state():
    with open(STATE, "r", encoding="utf-8") as handle:
        return json.load(handle)


def save_state(payload):
    with open(STATE, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)


# Deterministic sampler for the fixture-run collector (no GPU on test hosts).
_counter = [0]


def stub_collect():
    _counter[0] += 1
    return [{"index": 0, "memoryUsedMb": _counter[0]}], ""


agent.collect_local_gpu = stub_collect

WORKER_STATE = str(ROOT / "worker-state")
os.environ["SIMPLE_EXPERIMENT_WORKER_STATE_DIR"] = WORKER_STATE


def fixture_collector_command(worker_id, limit="0"):
    # Stands in ONLY for the script path of the production command (the full
    # production command string, including the carried authoritative state root,
    # is asserted in gpuCollectorFrame.fixture.py). The lifecycle semantics —
    # exec env carry, real tmux new-session/respawn of a real python collector
    # publishing through the PRODUCTION functions — are exercised unchanged.
    return ("exec env " + shlex.join(["SIMPLE_EXPERIMENT_WORKER_STATE_DIR=" + WORKER_STATE]) + " " +
            shlex.join([sys.executable, "-B", str(pathlib.Path(__file__).resolve()),
                        "collector-loop", str(ROOT), STATE, SOCKET, str(worker_id), str(limit)]))


agent.gpu_collector_command = lambda worker_id, root="": fixture_collector_command(worker_id)


def wait_registered_frame(worker, root, timeout_s, epoch=None, seq_gt=0):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        reg = agent.gpu_collector_read_registration(worker, root)
        frame = agent.read_gpu_collector_frame(worker, root)
        if reg.get("mode") == "registered" and frame.get("frame"):
            r_epoch = str(reg["registration"]["epoch"])
            ok_epoch = (epoch is None or r_epoch == epoch) and str(frame["frame"]["epoch"]) == r_epoch
            if ok_epoch and int(frame["frame"]["seq"]) > seq_gt:
                return reg, frame
        time.sleep(0.2)
    raise AssertionError("collector generation never appeared within " + str(timeout_s) + "s")


def main():
    root = str(ROOT / "project")
    os.makedirs(root, exist_ok=True)
    if MODE == "collector-loop":
        worker = sys.argv[5]
        limit = int(sys.argv[6] or 0)
        # gpu_collector_main is production's endless loop; run it as a daemon
        # thread and let THIS thread return once `limit` frames of OUR OWN
        # generation exist — a plain process exit (no signals) that the
        # remain-on-exit window records as an honestly dead pane with its own
        # binding still attached. The pre-existing frame of an OLDER generation
        # must not count (a respawn sees the previous collector's frames), and
        # neither may this process's own seq, which restarts at 1 — hence the
        # epoch comparison against the snapshot taken before the thread starts.
        # limit=0 keeps the collector alive until the private server is torn down.
        prior = agent.gpu_collector_read_registration(worker, root)
        old_epoch = (str(prior["registration"]["epoch"]) if prior.get("mode") == "registered" else None)
        threading.Thread(target=agent.gpu_collector_main, args=(root, worker),
                         kwargs={"poll_seconds": 0.5}, daemon=True).start()
        deadline = time.monotonic() + (90.0 if not limit else 25.0)
        while time.monotonic() < deadline:
            observed = agent.read_gpu_collector_frame(worker, root)
            frame = observed.get("frame") or {}
            if limit and int(frame.get("seq") or 0) >= limit and str(frame.get("epoch") or "") != old_epoch:
                return
            time.sleep(0.1)
        return
    if MODE == "phase-a":
        worker = "revtmux-w1"
        report = agent.gpu_collector_ensure(worker, root)
        assert report["status"] == "started", report
        reg, frame = wait_registered_frame(worker, root, 8.0, seq_gt=0)
        second = agent.gpu_collector_ensure(worker, root)
        assert second["status"] == "running" and second["epoch"] == reg["registration"]["epoch"], second
        sessions = tmux("list-sessions", "-F", "#{session_name}").stdout.splitlines()
        name = agent.gpu_collector_session(worker, root)
        assert sessions.count(name) == 1, sessions
        windows = tmux("list-windows", "-t", "=" + name, "-F", "#{window_id}").stdout.split()
        assert len(windows) == 1, windows
        assert second["paneId"], second
        save_state({"session": name, "epoch": reg["registration"]["epoch"], "seq": int(frame["frame"]["seq"]),
                    "windows": [{"worker": worker, "windowId": second["windowId"], "paneId": second["paneId"]}]})
        finish({"ensure": report["status"], "session": name, "epoch": reg["registration"]["epoch"],
                "windows": len(windows)})
    elif MODE == "phase-b":
        # A NEW consumer process: the recorded sample must already have advanced
        # beyond what phase A's (now exited) process saw — real survival of the
        # collector across a consumer exit, proven by the shared frame itself.
        state = load_state()
        worker = "revtmux-w1"
        reg, frame = wait_registered_frame(worker, root, 6.0, epoch=state["epoch"], seq_gt=state["seq"])
        report = agent.gpu_collector_ensure(worker, root)
        assert report["status"] == "running" and report["epoch"] == state["epoch"], report
        sessions = tmux("list-sessions", "-F", "#{session_name}").stdout.splitlines()
        assert sessions.count(state["session"]) == 1, sessions
        finish({"survivedSeq": int(frame["frame"]["seq"]), "oldSeq": state["seq"], "epoch": state["epoch"]})
    elif MODE == "phase-c":
        # Independent worker identity: a collector that terminates NATURALLY
        # (limit=1, no signals) leaves a dead pane WITH its own binding; ensure
        # must verify identity and respawn a NEW generation in the SAME window,
        # never a second session.
        worker = "revtmux-w2"
        agent.gpu_collector_command = lambda worker_id, root="": fixture_collector_command(worker_id, limit="1")
        first = agent.gpu_collector_ensure(worker, root)
        assert first["status"] == "started", first
        state = load_state()
        state["windows"].append({"worker": worker, "windowId": first["windowId"], "paneId": first["paneId"]})
        save_state(state)
        reg1, _frame1 = wait_registered_frame(worker, root, 8.0, seq_gt=0)
        session = agent.gpu_collector_session(worker, root)
        # Read-only pane lookup on THIS exact window: a second ensure could race
        # the natural exit and legitimately answer "respawned" instead of "running".
        pane = tmux("display-message", "-p", "-t", session + ":collector", "#{pane_id}").stdout.strip()
        assert pane.startswith("%"), pane
        deadline = time.monotonic() + 8.0
        dead = False
        while time.monotonic() < deadline:
            dead = tmux("display-message", "-p", "-t", pane, "#{pane_dead}").stdout.strip() == "1"
            if dead:
                break
            time.sleep(0.2)
        assert dead, "naturally-terminated collector pane did not report dead"
        report = agent.gpu_collector_ensure(worker, root)
        assert report["status"] == "respawned", report
        reg2, frame2 = None, None
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            reg_now = agent.gpu_collector_read_registration(worker, root)
            if reg_now.get("mode") == "registered" and str(reg_now["registration"]["epoch"]) != reg1["registration"]["epoch"]:
                reg2 = reg_now
                frame2 = agent.read_gpu_collector_frame(worker, root)
                break
            time.sleep(0.2)
        if not reg2:
            # Honest failure evidence from the exact respawned pane only.
            pane_state = tmux("display-message", "-p", "-t", pane,
                              "dead=#{pane_dead} pid=#{pane_pid}").stdout.strip()
            pane_tail = tmux("capture-pane", "-p", "-t", pane).stdout.strip()[-800:]
            raise AssertionError("respawned collector never published a new generation; pane["
                                 + pane_state + "] tail:\n" + pane_tail)
        assert frame2 and int(frame2["frame"]["seq"]) >= 1, frame2
        sessions = tmux("list-sessions", "-F", "#{session_name}").stdout.splitlines()
        assert sessions.count(session) == 1, sessions
        finish({"oldEpoch": reg1["registration"]["epoch"], "newEpoch": reg2["registration"]["epoch"],
                "newSeq": int(frame2["frame"]["seq"]), "respawn": report["status"]})
    elif MODE == "phase-t":
        # Verify and close only the exact windows recorded by new-session.
        # A private socket does not authorize killing a session or server.
        closed = []
        for expected in load_state()["windows"]:
            result = tmux("display-message", "-p", "-t", expected["windowId"],
                          "#{window_id}\t#{pane_id}\t#{@se_gpu_collector}")
            assert result.returncode == 0, result.stderr
            window, pane, raw = result.stdout.rstrip("\r\n").split("\t")
            assert window == expected["windowId"] and pane == expected["paneId"]
            assert agent._gpu_binding_verdict(json.loads(raw), expected["worker"],
                       agent.gpu_collector_frame_path(expected["worker"], root)) == "own"
            result = tmux("kill-window", "-t", window)
            assert result.returncode == 0, result.stderr
            closed.append(window)
        listing = subprocess.run(["/usr/bin/tmux", "-L", SOCKET, "list-sessions"],
                                 capture_output=True, text=True, timeout=5)
        assert len(closed) == 2 and len(set(closed)) == 2, closed
        finish({"closedWindows": closed, "serverGone": listing.returncode != 0})
    else:
        raise SystemExit("unknown mode " + MODE)


main()
