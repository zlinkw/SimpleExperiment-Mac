/** Offline auxiliary-service dependencies. Embedded into both deployed scripts. */
export const RUNTIME_DEPENDENCIES_PYTHON = String.raw`
# PyYAML 6.0.3, MIT. Unmodified pure Python sources + LICENSE are in the bundle.
# Copyright (c) 2017-2021 Ingy döt Net; Copyright (c) 2006-2016 Kirill Simonov.
RUNTIME_PYYAML_VERSION = "6.0.3"
RUNTIME_PYYAML_SHA256 = "__SIMPLE_PYYAML_SHA256__"
RUNTIME_PYYAML_BUNDLE = "__SIMPLE_PYYAML_BASE64__"
RUNTIME_DEPENDENCIES = None

def runtime_dependency_prepare():
    import base64
    import hashlib
    import importlib
    import os
    import pathlib
    import sys
    import uuid
    global RUNTIME_DEPENDENCIES
    interpreter = os.path.realpath(sys.executable)
    directory = pathlib.Path(__file__).absolute().parent / ".python-dependencies"
    target = directory / ("PyYAML-" + RUNTIME_PYYAML_VERSION + "-" + RUNTIME_PYYAML_SHA256 + ".zip")
    repair = "Use SimpleExperiment: prepare project and Agent with the paired Mac release, then restart only its assigned Agent window; do not install into the training environment. Offline bundle is embedded in cluster_agent.py and cluster_scheduler.py."
    try:
        raw = base64.b64decode(RUNTIME_PYYAML_BUNDLE, validate=True)
        if hashlib.sha256(raw).hexdigest() != RUNTIME_PYYAML_SHA256:
            raise ValueError("embedded PyYAML bundle checksum mismatch; redeploy runtime")
        for parent in (directory, *directory.parents):
            if parent.is_symlink(): raise ValueError("managed dependency path traverses a symlink: " + str(parent))
        directory.mkdir(exist_ok=True)
        if target.is_symlink() or target.exists() and not target.is_file():
            raise ValueError("managed dependency target is not a regular file: " + str(target))
        if not target.exists() or target.stat().st_size != len(raw) or hashlib.sha256(target.read_bytes()).hexdigest() != RUNTIME_PYYAML_SHA256:
            # Atomic publication also allows independent project Agents sharing this runtime.
            temporary = str(target) + "." + uuid.uuid4().hex + ".writing"
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            if target.is_symlink(): raise ValueError("managed dependency target changed to a symlink")
            os.replace(temporary, target)
        existing = sys.modules.get("yaml")
        if existing is not None and not str(existing.__file__).startswith(str(target) + os.sep):
            raise ValueError("yaml already loaded outside the managed environment: " + str(existing.__file__))
        if str(target) not in sys.path: sys.path.insert(0, str(target))
        yaml = importlib.import_module("yaml")
        if yaml.__version__ != RUNTIME_PYYAML_VERSION or not str(yaml.__file__).startswith(str(target) + os.sep):
            raise ValueError("loaded PyYAML does not match the managed bundle")
        sample = "base: &base [one, two]\ncopy: *base\ncommand: |\n  python train.py\n"
        parsed = yaml.safe_load(sample)
        if parsed != {"base": ["one", "two"], "copy": ["one", "two"], "command": "python train.py\n"}:
            raise ValueError("PyYAML safe_load capability check failed")
        RUNTIME_DEPENDENCIES = {"ok": True, "protocol": 1, "python": interpreter, "executable": sys.executable, "prefix": sys.prefix, "dependency": "PyYAML", "version": yaml.__version__, "module": yaml.__file__, "bundle": str(target), "sha256": RUNTIME_PYYAML_SHA256, "safeLoad": True, "offline": True, "repair": repair}
        return RUNTIME_DEPENDENCIES
    except (OSError, ImportError, ValueError) as error:
        raise RuntimeError("AGENT_RUNTIME_DEPENDENCY_FAILED: interpreter=" + interpreter + "; dependency=PyYAML==" + RUNTIME_PYYAML_VERSION + "; managedPath=" + str(target) + "; cause=" + str(error) + "; repair=" + repair) from error

def runtime_dependency_check():
    import os
    import sys
    try:
        return runtime_dependency_prepare()
    except RuntimeError as error:
        return {"ok": False, "protocol": 1, "code": "AGENT_RUNTIME_DEPENDENCY_FAILED", "python": os.path.realpath(sys.executable), "dependency": "PyYAML", "version": RUNTIME_PYYAML_VERSION, "error": str(error)}
`;
