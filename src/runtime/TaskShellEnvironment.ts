/** Shared by Agent and Scheduler, including the final adapter/wrapper launch. */
export const TASK_SHELL_ENVIRONMENT_PYTHON = String.raw`
TASK_SHELL_ENV_FIELDS = (
    "SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY", "SIMPLE_EXPERIMENT_JOB_COMMAND_ID", "SIMPLE_EXPERIMENT_JOB_PROJECT_ID",
    "SIMPLE_EXPERIMENT_MANAGED_JOB", "SIMPLE_EXPERIMENT_CHECKPOINT_TEST_ONLY", "SIMPLE_EXPERIMENT_DISTRIBUTED_RESULTS",
    "SIMPLE_EXPERIMENT_TMUX_SESSION", "SIMPLE_EXPERIMENT_TMUX_LOG_DIR", "SIMPLE_EXPERIMENT_EXIT_CODE_PATH",
    "SIMPLE_EXPERIMENT_CONDA_ENV", "SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV", "CUDA_VISIBLE_DEVICES", "PYTHONUNBUFFERED",
    "SIMPLE_EXPERIMENT_TASK_LIFECYCLE", "SIMPLE_EXPERIMENT_RUNTIME_LOG_PATH",
)

TASK_EXECUTION_PROBE_CODE = r'''
import ctypes, hashlib, importlib.util, json, os, pathlib, sys
proof = json.loads(os.environ.get('SIMPLE_EXPERIMENT_NVJITLINK_PROOF','null'))
if proof:
    library = pathlib.Path(proof['library'])
    if hashlib.sha256(library.read_bytes()).hexdigest() != proof['sha256']:
        raise RuntimeError('NVJITLINK_PROOF_CHANGED: bytes')
    ctypes.CDLL(library.name)  # Exercise the real loader using the post-login search order.
    maps = pathlib.Path('/proc/self/maps')
    if maps.is_file():
        loaded = {pathlib.Path(line.split(None,5)[-1].strip()).resolve() for line in maps.read_text().splitlines()
                  if 'libnvJitLink.so' in line}
        if loaded != {library.resolve()}:
            raise RuntimeError('NVJITLINK_LOADER_CONFLICT: ' + ','.join(map(str,loaded)))
imports = {}
if importlib.util.find_spec('torch') is not None:
    import torch  # Import only; never call torch.cuda, start a model or allocate a GPU tensor.
    imports['torch'] = str(getattr(torch,'__version__','unknown'))
print(json.dumps(dict(python=sys.executable,prefix=sys.prefix,
    identity=os.environ.get('SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY',''),nvJitLink=proof,cpuImports=imports),ensure_ascii=False))
'''

def task_shell_args(args, env, python):
    """Rebind allowlisted controls AFTER login scripts, before any task interpreter starts."""
    if os.name == "nt":
        return args
    shell = env.get("SHELL") or ("/bin/bash" if os.path.isfile("/bin/bash") else "/bin/sh")
    assignments = []
    for key in TASK_SHELL_ENV_FIELDS:
        value = env.get(key)
        assignments.append("export " + key + "=" + shlex.quote(str(value)) if value not in (None, "") else "unset " + key)
    # Absolute Python selects the launcher; activation also selects its child commands.
    # Login profiles can reset PATH, so bind the configured environment afterwards.
    selected = str(env.get("SIMPLE_EXPERIMENT_CONDA_ENV") or "").strip()
    if selected and os.path.isabs(str(python)):
        controls = list(assignments)
        prefix = os.path.dirname(os.path.dirname(str(python)))
        assignments.extend([
            "__simple_task_prefix=" + shlex.quote(prefix),
            'if [ "$' + '{CONDA_PREFIX:-}" != "$__simple_task_prefix" ]; then '
            'if ! command -v conda >/dev/null 2>&1 && [ -n "$' + '{CONDA_EXE:-}" ]; then '
            '__simple_conda_hook="$(dirname -- "$CONDA_EXE")/../etc/profile.d/conda.sh"; '
            'if [ -f "$__simple_conda_hook" ]; then . "$__simple_conda_hook" || exit $?; fi; fi; '
            'if command -v conda >/dev/null 2>&1; then '
            '__simple_conda_setup="$(conda shell.posix hook)" || exit $?; eval "$__simple_conda_setup" || exit $?; '
            'conda activate "$__simple_task_prefix" || exit $?; '
            'else export CONDA_PREFIX="$__simple_task_prefix"; '
            'for __simple_activate in "$__simple_task_prefix"/etc/conda/activate.d/*.sh; do '
            'if [ -f "$__simple_activate" ]; then . "$__simple_activate" || exit $?; fi; done; fi; fi',
            'case "$PATH" in "$__simple_task_prefix/bin"|"$__simple_task_prefix/bin":*) ;; '
            '*) export PATH="$__simple_task_prefix/bin:$PATH" ;; esac',
        ])
        assignments.extend(controls)  # Environment hooks cannot replace this job's GPU or identity.
    if env.get("SIMPLE_EXPERIMENT_TASK_LIFECYCLE") == "2" and env.get("TMUX_PANE"):
        assignments.append("tmux set-option -w -t " + shlex.quote(str(env["TMUX_PANE"])) + " @se_phase running || exit $?")
    # A renderer may already request a login shell. Execute its body in this prepared
    # login shell instead of starting another shell that could reset library/identity controls.
    nested = len(args) == 3 and str(args[1]) == "-lc" and str(args[0]) == str(shell)
    command = str(args[2]) if nested else "exec " + shlex.join([str(item) for item in args])
    # Research libraries and loader configuration belong to the project. In
    # particular, a proof inherited from an old tmux server must not gate launch.
    body = "; ".join(assignments) + "; unset SIMPLE_EXPERIMENT_NVJITLINK_PROOF; " + command
    return [shell, "-lc", body]
`;
