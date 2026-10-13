import json, os, pathlib, subprocess, sys, tempfile
repo = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / "test/_helpers"))
from extractRuntimeFunctions import extract_runtime_functions

bash, variant = sys.argv[1:3]
components = (sys.argv[3],) if len(sys.argv) > 3 else ("agent", "scheduler")
base = pathlib.Path(tempfile.mkdtemp(prefix="simple-shell-probe-")).resolve()
prefix = base / "环境 空格'quoted"
(prefix / "bin").mkdir(parents=True)
python = prefix / "bin/python"
python.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$SHELL_PROBE_REPORT"\n', encoding="utf-8")
os.chmod(python, 0o755)
env = dict(os.environ, PATH="/usr/bin:/bin", CONDA_EXE="", CONDA_PREFIX="", BASH_ENV="", ENV="", MSYS2_ARG_CONV_EXCL="*")
if os.name == "nt":
    converted = subprocess.run([bash, "--noprofile", "--norc", "-c", 'cygpath -u "$1"', "probe", str(prefix)],
        env=env, capture_output=True, text=True, encoding="utf-8", timeout=3)
    assert converted.returncode == 0, converted.stderr
    target = converted.stdout.strip()
else: target = str(prefix)
if variant == "python": target += "/bin/python"
if variant == "missing": target += "/absent"
env.update(SIMPLE_EXPERIMENT_CONDA_ENV=target, SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV="1", SHELL_PROBE_REPORT=json.dumps({"selected": target}))
results = {}
for name in components:
    # Extract only the activation function and its dependencies from generated Python.
    module = extract_runtime_functions(str(repo / f"dist/runtime/cluster_{name}.py"), ["simple_conda_activation_script"])
    script = module.simple_conda_activation_script(env) + ' && python'
    result = subprocess.run([bash, "--noprofile", "--norc", "-c", script], env=env,
        capture_output=True, text=True, encoding="utf-8", timeout=8)
    results[name] = {"returncode": result.returncode, "stdout": result.stdout.strip(), "stderr": result.stderr[-800:]}
print(json.dumps(results))
