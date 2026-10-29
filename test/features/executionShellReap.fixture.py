"""A stalled real login shell must leave no live child; only an isolated sleep probe."""
import json, os, pathlib, signal, subprocess, sys, tempfile, time
repo = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / "test/_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
scheduler = extract_runtime_functions(str(repo / "dist/runtime/cluster_scheduler.py"), ["execution_shell_preflight"])
if len(sys.argv) > 1 and sys.argv[1] == "cancelled-child":
    os.environ["SHELL"] = sys.argv[2]
    print(json.dumps(scheduler.execution_shell_preflight()), flush=True)
    sys.exit(0)
root = pathlib.Path(tempfile.mkdtemp(prefix="simple-shell-reap-"))
pid_file = root / "child.pid"
shell = root / "stalled-login"
shell.write_text('#!/bin/sh\nsleep 30 >/dev/null 2>&1 &\nprintf "%s" "$!" > ' + str(pid_file) + '\nwait\n', encoding="utf-8")
shell.chmod(0o700)
os.environ["SHELL"] = str(shell)
real_popen = subprocess.Popen
processes = []
def spawn(*args, **kw):
    # Give the real fixture shell its own group even before the production fix;
    # scale only the existing eight-second deadline for a fast deterministic repro.
    kw["start_new_session"] = True
    proc = real_popen(*args, **kw)
    processes.append(proc)
    real_wait = proc.wait
    proc.wait = lambda timeout=None: real_wait(timeout=min(timeout, 0.2) if timeout else timeout)
    return proc
scheduler.subprocess.Popen = spawn
try:
    if len(sys.argv) > 1 and sys.argv[1] == "cancel":
        proc = real_popen([sys.executable, "-B", __file__, "cancelled-child", str(shell)],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        processes.append(proc)
        deadline = time.monotonic() + 3
        while not pid_file.exists() and time.monotonic() < deadline: time.sleep(0.01)
        assert pid_file.exists(), "cancel probe never started"
        os.kill(proc.pid, signal.SIGTERM)
        stdout, stderr = proc.communicate(timeout=2)
        assert proc.returncode == 0, stderr
        report = json.loads(stdout)
        assert report["ok"] is False and "cancelled" in report["error"], report
    else:
        report = scheduler.execution_shell_preflight()
        assert report["ok"] is False and "timed out" in report["error"], report
    child = int(pid_file.read_text(encoding="utf-8"))
    state = pathlib.Path(f"/proc/{child}/stat")
    assert not state.exists() or state.read_text().split()[2] == "Z", "login shell child survived preflight timeout"
    assert processes[0].poll() is not None
    print(json.dumps(dict(ok=True, childReaped=True, errorCode=report["errorCode"])))
finally:
    # Only the private process group created above; no user process or files are touched.
    for proc in processes:
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
