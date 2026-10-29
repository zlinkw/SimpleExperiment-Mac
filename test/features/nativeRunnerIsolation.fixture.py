"""Only extracted helpers; no research imports, user tmux or remote hosts."""
import json, os, pathlib, shlex, subprocess, sys, tempfile, time, venv
repo = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / 'test/_helpers'))
from extractRuntimeFunctions import extract_runtime_functions
runtime = str(repo / 'dist/runtime/cluster_agent.py')
if len(sys.argv) > 1:
    agent = extract_runtime_functions(runtime, ['atomic_write_file'])
    target = pathlib.Path(sys.argv[1])
    for step in range(6):
        def write(stream):
            stream.write(json.dumps(dict(pid=os.getpid(), step=step))); time.sleep(0.006)
        agent.atomic_write_file(str(target), write)
    sys.exit(0)
root = pathlib.Path(tempfile.mkdtemp(prefix='native-runner-isolation-'))
agent = extract_runtime_functions(runtime, ['task_shell_args', 'append_event'])
prefix = root / 'environment with spaces'
venv.EnvBuilder(with_pip=False, symlinks=True).create(prefix)
activation = prefix / 'etc/conda/activate.d'
activation.mkdir(parents=True)
(activation / 'project.sh').write_text('export PROJECT_ACTIVATED="selected-environment"\nexport CUDA_VISIBLE_DEVICES="wrong-hook-gpu"\n', encoding='utf-8')
profile = root / 'login-shell'
profile.write_text('#!/bin/sh\nexport PATH="/usr/bin:/bin"\nexport LD_LIBRARY_PATH="/project/user-library"\nexec /bin/bash --noprofile --norc "$@"\n', encoding='utf-8')
profile.chmod(0o700)
env = dict(os.environ, SHELL=str(profile), SIMPLE_EXPERIMENT_CONDA_ENV=str(prefix),
           SIMPLE_EXPERIMENT_NVJITLINK_PROOF='stale-invalid-proof', CUDA_VISIBLE_DEVICES='3',
           SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY='job identity', SIMPLE_EXPERIMENT_TASK_LIFECYCLE='2')
code = 'import json,os,subprocess; child=subprocess.check_output(["python","-B","-c","import sys;print(sys.prefix)"],text=True).strip(); print(json.dumps(dict(child=child,activated=os.getenv("PROJECT_ACTIVATED"),identity=os.getenv("SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY"), gpu=os.getenv("CUDA_VISIBLE_DEVICES"), ld=os.getenv("LD_LIBRARY_PATH"), proof=os.getenv("SIMPLE_EXPERIMENT_NVJITLINK_PROOF"))))'
args = [str(prefix / 'bin/python'), '-B', '-c', code]
for _ in range(2):
    args = agent.task_shell_args(args, env, str(prefix / 'bin/python'))
result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=3)
assert result.returncode == 0, result.stderr
report = json.loads(result.stdout)
assert report == dict(child=str(prefix), activated='selected-environment', identity='job identity', gpu='3', ld='/project/user-library', proof=None), report
# Exercise real shell activation with a tiny synthetic Conda hook, no package operations.
conda_root = root / 'conda installation'
(conda_root / 'bin').mkdir(parents=True)
(conda_root / 'etc/profile.d').mkdir(parents=True)
(conda_root / 'etc/profile.d/conda.sh').write_text('conda() { if [ "$1" = "shell.posix" ]; then echo ":"; elif [ "$1" = "activate" ]; then export CONDA_PREFIX="$2"; . "$2/etc/conda/activate.d/project.sh"; export CONDA_ACTIVATE_USED=1; else return 9; fi; }\n', encoding='utf-8')
conda_env = dict(env, CONDA_EXE=str(conda_root / 'bin/conda'))
activated = subprocess.run(agent.task_shell_args([str(prefix / 'bin/python'), '-c', 'import os;assert os.environ["CONDA_ACTIVATE_USED"]=="1"'], conda_env, str(prefix / 'bin/python')),
                           env=conda_env, capture_output=True, text=True, timeout=3)
assert activated.returncode == 0, activated.stderr
# Task errors stay task errors, with their actual exit code and output.
failed = subprocess.run(agent.task_shell_args([str(prefix / 'bin/python'), '-c', 'import sys; print("project error",file=sys.stderr); sys.exit(7)'], env, str(prefix / 'bin/python')),
                        env=env, capture_output=True, text=True, timeout=3)
assert failed.returncode == 7 and 'project error' in failed.stderr, failed
agent.NATIVE_TASK_RUNNER_CONTEXT = ('command', '%1', str(root))
agent.prune_runtime_memory_state = lambda: (_ for _ in ()).throw(AssertionError('native task touched old journal'))
assert agent.append_event(str(root), dict(type='worker_command_started'))['type'] == 'worker_command_started'
assert not list(root.glob('**/seq.txt*')) and not list(root.glob('**/events.jsonl'))
target = root / 'shared.json'
children = [subprocess.Popen([sys.executable, '-B', __file__, str(target)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(3)]
for child in children:
    out, err = child.communicate(timeout=5)
    assert child.returncode == 0, err or out
assert 'pid' in json.loads(target.read_text(encoding='utf-8'))
assert not list(root.glob('*.writing*'))
print(json.dumps(dict(launch=True, rawError=True, journalUntouched=True, concurrentWriters=3)))
