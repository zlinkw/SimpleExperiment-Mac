"""Exercise only the extracted read-only function, with an in-memory filesystem."""
import hashlib
import io
import json
import pathlib
import posixpath
import re
import stat
from types import SimpleNamespace

source = (pathlib.Path(__file__).resolve().parents[2] / "src/clusterAgentRuntime.legacy.ts").read_text(encoding="utf-8")
code = source.split("def inspect_plan_output_retirement(root, relative):", 1)[1].split("\ndef cache_cleanup_candidates(root):", 1)[0]
code = "def inspect_plan_output_retirement(root, relative):" + code
root = "/srv/research"
relative = "work_dirs/model/job/attempts/a"
target = root + "/" + relative
nodes = {}
links = set()
mounts = set()
tasks = []
mutating = False
reads = 0


def reset():
    global nodes, links, mounts, tasks, mutating, reads
    nodes = {root: None}
    current = root
    for part in relative.split("/"):
        current += "/" + part
        nodes[current] = None
    nodes[target + "/best_model.pth"] = b"checkpoint"
    nodes[target + "/test_results"] = None
    nodes[target + "/test_results/results.csv"] = b"case,seed,metric\ncase,1,0.8\n"
    links, mounts, tasks = set(), set(), []
    mutating, reads = False, 0


def metadata(value):
    if value not in nodes:
        raise FileNotFoundError(value)
    mode = stat.S_IFLNK if value in links else stat.S_IFDIR if nodes[value] is None else stat.S_IFREG
    return SimpleNamespace(st_mode=mode, st_dev=1, st_ino=sorted(nodes).index(value) + 1,
                           st_size=0 if nodes[value] is None else len(nodes[value]), st_mtime_ns=1, st_ctime_ns=1)


def walk(value, followlinks=False):
    assert followlinks is False
    for directory in sorted(name for name, body in nodes.items() if body is None and (name == value or name.startswith(value + "/"))):
        children = [name for name in nodes if posixpath.dirname(name) == directory]
        yield directory, [posixpath.basename(name) for name in children if nodes[name] is None], [posixpath.basename(name) for name in children if nodes[name] is not None]


descriptors = {}


def open_fd(value, flags):
    descriptor = len(descriptors) + 1
    descriptors[descriptor] = value
    return descriptor


class Stream(io.BytesIO):
    def __init__(self, descriptor):
        super().__init__(nodes[descriptors[descriptor]])
        self.descriptor = descriptor

    def fileno(self):
        return self.descriptor


def fstat(descriptor):
    global reads
    reads += 1
    info = metadata(descriptors[descriptor])
    if mutating and reads > 1:
        info.st_mtime_ns += 1
    return info


fake_path = SimpleNamespace(abspath=posixpath.abspath, realpath=lambda value: value,
                            expanduser=lambda value: "/home/researcher", join=posixpath.join,
                            dirname=posixpath.dirname, relpath=posixpath.relpath,
                            isabs=posixpath.isabs,
                            isdir=lambda value: value in nodes and nodes[value] is None and value not in links,
                            lexists=lambda value: value in nodes, islink=lambda value: value in links,
                            ismount=lambda value: value in mounts)
fake_os = SimpleNamespace(path=fake_path, sep="/", walk=walk, lstat=metadata, O_RDONLY=0, O_NOFOLLOW=1,
                          open=open_fd, fdopen=lambda descriptor, _mode: Stream(descriptor), fstat=fstat)
namespace = {"os": fake_os, "hashlib": hashlib, "json": json, "re": re,
             "api_worker_tasks": lambda _root: {"tasks": tasks}}
exec(compile(code, "inspect_plan_output_retirement", "exec"), namespace)
inspect = namespace["inspect_plan_output_retirement"]


def rejected(expected):
    try:
        inspect(root, relative)
    except ValueError as error:
        assert expected in str(error), str(error)
    else:
        raise AssertionError("unsafe inspection was accepted")


reset()
proof = inspect(root, relative)
assert proof["exists"] and proof["safeForDeletion"] and proof["fileCount"] == 2
assert proof["bytes"] == sum(len(body) for body in nodes.values() if body is not None)
assert inspect(root, relative)["fingerprint"] == proof["fingerprint"]
nodes[target + "/best_model.pth"] = b"new checkpoint"
assert inspect(root, relative)["fingerprint"] != proof["fingerprint"]
reset()
links.add(target + "/test_results")
rejected("link or mount")
reset()
links.add(target + "/best_model.pth")
rejected("link or special file")
reset()
mounts.add(target + "/test_results")
rejected("link or mount")
reset()
links.add(root + "/work_dirs")
rejected("link or mount")
reset()
tasks = [{"status": "queued", "outputDir": relative}]
rejected("still active")
reset()
mutating = True
rejected("changed during")
reset()
for value in ("work_dirs", "work_dirs/model/attempts/../a", "work_dirs/model/attempts/*"):
    try:
        inspect(root, value)
    except ValueError:
        pass
    else:
        raise AssertionError(value)
for name in list(nodes):
    if name == target or name.startswith(target + "/"):
        del nodes[name]
assert inspect(root, relative)["exists"] is False
print("inspection checks passed")
