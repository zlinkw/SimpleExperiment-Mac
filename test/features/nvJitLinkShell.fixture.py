"""Real ELF loader and isolated tmux; synthetic libraries, imports and CPU only."""
import concurrent.futures, hashlib, json, os, pathlib, shlex, subprocess, sys, tempfile, time, venv

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from closeFixtureTmuxWindows import close_fixture_tmux_windows
repo = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / "test/_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(str(repo / "dist/runtime/cluster_agent.py"),
    ["formal_job_command_env", "start_job_in_gpu_pane", "start_simple_tmux_command"])
root = pathlib.Path(tempfile.mkdtemp(prefix="simple-nvjitlink-probe-")).resolve()
mode = sys.argv[1]

def library(directory, value, modern=True):
    directory.mkdir(parents=True, exist_ok=True)
    source = directory / "probe.s"
    symbol = "__nvJitLinkComplete_12_4" if modern else "__nvJitLinkComplete_12_0"
    source.write_text(f".text\n.globl {symbol}\n.type {symbol},@function\n{symbol}:\n mov ${value}, %eax\n ret\n.section .note.GNU-stack,\"\",@progbits\n", encoding="utf-8")
    subprocess.run(["as", str(source), "-o", str(directory / "probe.o")], check=True, capture_output=True, timeout=2)
    target = directory / "libnvJitLink.so.12"
    subprocess.run(["ld", "-shared", "-soname", target.name, str(directory / "probe.o"), "-o", str(target)], check=True, capture_output=True, timeout=2)
    return target

old = library(root / "old system CUDA", 0, False)
envs = []
for index in (0, 1):
    prefix = root / ("environment ' " + str(index))
    venv.EnvBuilder(with_pip=False, symlinks=True).create(prefix)
    libdir = prefix / f"lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages/nvidia/nvjitlink/lib"
    target = library(libdir, 42 + index)
    envs.append((prefix, target))
consumer_source = root / "consumer.s"
consumer_source.write_text('.text\n.globl cpu_probe\n.type cpu_probe,@function\ncpu_probe:\n jmp __nvJitLinkComplete_12_4@PLT\n.section .note.GNU-stack,"",@progbits\n', encoding="utf-8")
subprocess.run(["as", str(consumer_source), "-o", str(root / "consumer.o")], check=True, capture_output=True, timeout=2)
consumer = root / "libconsumer.so"
subprocess.run(["ld", "-shared", "--no-as-needed", str(root / "consumer.o"), "-L" + str(envs[0][1].parent),
                "-l:libnvJitLink.so.12", "-o", str(consumer)], check=True, capture_output=True, timeout=2)
for prefix, target in envs:
    # A synthetic CPU import uses a real ELF dependency, reproducing torch's missing-symbol boundary.
    module = target.parent.parent.parent.parent / "torch"
    module.mkdir()
    module.joinpath("__init__.py").write_text('import ctypes\nlib=ctypes.CDLL(' + repr(str(consumer)) + ')\nvalue=lib.cpu_probe()\n__version__="cpu-loader-probe"\n', encoding="utf-8")
import_probe = root / "import_probe.py"
import_probe.write_text('import ctypes\nlib = ctypes.CDLL(' + repr(str(consumer)) + ')\nvalue = lib.cpu_probe()\n', encoding="utf-8")
bad = subprocess.run([sys.executable, "-B", str(import_probe)], env={**os.environ, "LD_LIBRARY_PATH": str(old.parent)}, capture_output=True, text=True, timeout=2)
assert bad.returncode != 0 and "undefined symbol: __nvJitLinkComplete_12_4" in bad.stderr, bad.stderr
profile = root / "login-profile"
profile.write_text("export LD_LIBRARY_PATH=" + shlex.quote(str(old.parent)) + "\n", encoding="utf-8")
shell = root / "login-shell"
shell.write_text("#!/bin/sh\n. " + shlex.quote(str(profile)) + '\nexec /bin/bash --noprofile --norc "$@"\n', encoding="utf-8")
shell.chmod(0o700)
socket = "simple-nvjitlink-" + root.name
tmux = root / "tmux"
tmux.write_text("#!/bin/sh\nexec /usr/bin/tmux -L " + shlex.quote(socket) + ' -f /dev/null "$@"\n', encoding="utf-8")
tmux.chmod(0o700)
os.environ.update(PATH=str(root) + ":" + os.environ["PATH"], SHELL=str(shell), LD_LIBRARY_PATH=str(old.parent))
base = os.environ.copy()
selected = extract_runtime_functions(str(repo / "dist/runtime/cluster_scheduler.py"), ["simple_conda_wrapped_args"])
wrong_proof = dict(python=str(envs[0][0] / "bin/python"), prefix=str(envs[0][0]), library=str(envs[0][1]),
                   directory=str(envs[0][1].parent), sha256="0" * 64)
blocked_env = dict(base, SIMPLE_EXPERIMENT_CONDA_ENV=str(envs[0][0]), SIMPLE_EXPERIMENT_NVJITLINK_PROOF=json.dumps(wrong_proof))
blocked = subprocess.run(selected.simple_conda_wrapped_args([str(envs[0][0] / "bin/python"), "-B", str(import_probe)], blocked_env),
                         env=blocked_env, capture_output=True, text=True, timeout=2)
assert blocked.returncode != 0 and "NVJITLINK_PROOF_CHANGED" in blocked.stderr, blocked.stderr
subprocess.run([str(tmux), "new-session", "-d", "-s", "bootstrap", str(shell)], check=True, capture_output=True, timeout=2)
child = root / "wrapper.py"
child.write_text("import json,os,sys\nsys.path.insert(0," + repr(str(root)) + ")\nimport import_probe\nprint(json.dumps(dict(value=import_probe.value,identity=os.environ.get('SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY'),library=os.environ.get('SIMPLE_EXPERIMENT_NVJITLINK_PROOF'),args=sys.argv[1:],ld=os.environ.get('LD_LIBRARY_PATH'))))\n", encoding="utf-8")
scheduler_probe = root / "scheduler_probe.py"
scheduler_probe.write_text("import json,os,pathlib,sys\nsys.path.insert(0," + repr(str(repo / "test/_helpers")) + ")\nfrom extractRuntimeFunctions import extract_runtime_functions\ns=extract_runtime_functions(" + repr(str(repo / "dist/runtime/cluster_scheduler.py")) + ", ['execution_shell_preflight','simple_conda_wrapped_args','run_command'])\nr=s.execution_shell_preflight()\nassert r['ok'], r\npathlib.Path(sys.argv[1]).write_text(json.dumps(r),encoding='utf-8')\nargs=[sys.executable,'-B'," + repr(str(child)) + ",sys.argv[2]]\n# Repeated wrapping must not accumulate paths or lose the raw identity.\ns.run_command(s.simple_conda_wrapped_args(args,dict(os.environ)),dict(os.environ))\n", encoding="utf-8")
try:
    def launch(index):
        prefix, target = envs[index]
        working = root / ("job " + str(index))
        working.mkdir()
        identity = dict(workflowId="workflow 中文 ' \"", commandId="command" + str(index), globalJobId="workflow 中文 ' \":" + str(index), planRevision="revision", codeFingerprint="code")
        env = agent.formal_job_command_env({**identity, "condaEnv": str(prefix)})
        env["CUDA_VISIBLE_DEVICES"] = ""  # No GPU process is run.
        raw = env["SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY"]
        report = working / "preflight.json"
        args = [str(prefix / "bin/python"), "-B", str(scheduler_probe), str(report), "参数 空格 ' \" $()"]
        log, exit_file = working / "task.log", working / "exit.code"
        session = ("probe-gpu-" if mode == "gpu" else "simple-sch-probe-") + str(index)
        if mode == "gpu":
            subprocess.run([str(tmux), "new-session", "-d", "-s", session, str(shell)], check=True, capture_output=True, timeout=2)
            agent.start_job_in_gpu_pane(session, args, str(working), env, str(log), str(exit_file))
        else:
            agent.start_simple_tmux_command(session, args, str(working), str(log), env, str(exit_file))
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and (not exit_file.exists() or not exit_file.read_text(encoding="utf-8").strip().lstrip("-").isdigit()):
            time.sleep(0.02)
        rc = int(exit_file.read_text(encoding="utf-8"))
        capture = subprocess.run([str(tmux), "capture-pane", "-p", "-J", "-t", session + ":", "-S", "-100"], capture_output=True, text=True, timeout=2).stdout if mode == "ordinary" else log.read_text(encoding="utf-8")
        assert rc == 0, capture
        metadata = json.loads(report.read_text(encoding="utf-8"))
        rows = [json.loads(line) for line in capture.splitlines() if line.startswith('{"value":')]
        assert len(rows) == 1, capture
        row = rows[0]
        assert metadata["identity"] == raw == row["identity"]
        assert metadata["cpuImports"]["torch"] == "cpu-loader-probe", metadata
        assert row["value"] == 42 + index and row["args"] == ["参数 空格 ' \" $()"], row
        proof = json.loads(row["library"])
        assert proof["library"] == str(target) and proof["sha256"] == hashlib.sha256(target.read_bytes()).hexdigest()
        assert metadata["nvJitLink"] == proof and row["ld"].split(":").count(str(target.parent)) == 1, row
        return dict(preflightVerified=True, wrapperVerified=True, exitCode=rc, library=proof["library"])
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        reports = list(pool.map(launch, [0, 1]))
    print(json.dumps(dict(oldLibraryRejected=True, reports=reports)))
finally:
    # Close only verified window IDs on the private socket; retain files.
    close_fixture_tmux_windows(lambda args: subprocess.run([str(tmux), *args], capture_output=True, text=True, timeout=2), socket_name=socket)
