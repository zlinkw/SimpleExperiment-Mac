"""Synthetic TensorBoard records; no training project or filesystem writes."""

import io
import math
import pathlib
import struct
import sys
from types import SimpleNamespace
from unittest.mock import patch


SOURCE = pathlib.Path(__file__).resolve().parents[1] / "dist/runtime/cluster_agent.py"
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(str(SOURCE), ["scalar_event", "scalar_file_points", "scalar_masked_crc", "scalar_query", "SCALAR_FILE_CACHE"])


def varint(number):
    result = bytearray()
    while number >= 128:
        result.append((number & 127) | 128)
        number >>= 7
    result.append(number)
    return bytes(result)


def field(number, wire, value):
    key = varint((number << 3) | wire)
    return key + (varint(len(value)) if wire == 2 else b"") + value


def record(tag, step, value, tensor=False):
    name = field(1, 2, tag.encode())
    if tensor:
        tensor_value = field(1, 0, varint(1)) + field(4, 2, struct.pack("<f", value))
        scalar = name + field(8, 2, tensor_value)
    else:
        scalar = name + field(2, 5, struct.pack("<f", value))
    event = field(2, 0, varint(step)) + field(5, 2, field(1, 2, scalar))
    length = struct.pack("<Q", len(event))
    return length + struct.pack("<I", agent.scalar_masked_crc(length)) + event + struct.pack("<I", agent.scalar_masked_crc(event))


def file_points(content, *, inode=1, mtime=1):
    stat = SimpleNamespace(st_dev=1, st_ino=inode, st_size=len(content), st_mtime_ns=mtime)
    with patch.object(agent.os, "stat", return_value=stat), patch("builtins.open", return_value=io.BytesIO(content)):
        return agent.scalar_file_points("virtual/events.out.tfevents.test")


agent.SCALAR_FILE_CACHE.clear()
first = record("accuracy", 1, 0.25)
second = record("accuracy", 2, 0.75, tensor=True)
assert agent.scalar_event(first[12:-4]) == [("accuracy", 1, 0.25)]
assert agent.scalar_event(second[12:-4]) == [("accuracy", 2, 0.75)]
packed_tensor = field(1, 0, varint(1)) + field(5, 2, struct.pack("<f", 0.625))
packed_value = field(1, 2, b"accuracy") + field(8, 2, packed_tensor)
packed_event = field(2, 0, varint(5)) + field(5, 2, field(1, 2, packed_value))
assert agent.scalar_event(packed_event) == [("accuracy", 5, 0.625)]
shape = field(2, 2, field(1, 0, varint(2)))
vector_tensor = field(1, 0, varint(1)) + field(2, 2, shape) + field(4, 2, struct.pack("<ff", 1, 2))
vector_value = field(1, 2, b"vector") + field(8, 2, vector_tensor)
assert agent.scalar_event(field(5, 2, field(1, 2, vector_value))) == []
assert agent.scalar_event(record("accuracy", 3, math.nan)[12:-4]) == []

partial = file_points(first + second[:-3], mtime=1)
assert partial["points"]["accuracy"] == {1: 0.25} and not partial["unsupported"]
complete = file_points(first + second, mtime=2)
assert complete["points"]["accuracy"] == {1: 0.25, 2: 0.75}
rewritten = file_points(record("accuracy", 1, 0.5), mtime=3)
assert rewritten["points"]["accuracy"] == {1: 0.5}
larger_rewrite = file_points(record("accuracy", 1, 0.875) + second, mtime=4)
assert larger_rewrite["points"]["accuracy"] == {1: 0.875, 2: 0.75}
recreated = file_points(record("loss", 4, 1.5), inode=2, mtime=4)
assert recreated["points"] == {"loss": {4: 1.5}}
bad = file_points(first[:-1] + b"x", inode=3, mtime=5)
assert bad["unsupported"]


class VirtualEventFile:
    name = "events.out.tfevents.virtual"

    def is_file(self):
        return True

    def is_symlink(self):
        return False

    def stat(self):
        return SimpleNamespace(st_mtime_ns=7)

    def __str__(self):
        return self.name


catalog = {"plans": [{"planFile": "plan.yaml", "cases": [{
    "case": "case-a", "expectedSeeds": 2,
    "outputs": [{"seed": "42", "outputDir": "work_dirs/a"}],
}]}]}
entry = {"mtime": 7, "unsupported": False, "points": {
    "accuracy": {1: 0.25, 2: 0.75}, "loss": {1: 2.0, 2: 1.0},
}}
with patch.object(agent, "scalar_catalog", return_value=catalog), \
        patch.object(agent.os.path, "isdir", return_value=True), \
        patch.object(agent.pathlib.Path, "glob", return_value=[VirtualEventFile()]), \
        patch.object(agent, "scalar_file_points", return_value=entry) as read_event:
    queried = agent.scalar_query("/virtual/project", {
        "groups": [{"planFile": "plan.yaml", "case": "case-a"}],
        "tags": ["accuracy", "loss"], "logdir": "work_dirs",
    })
assert read_event.call_count == 1
group = queried["groups"][0]
assert set(group["seriesByTag"]) == {"accuracy", "loss"}
assert group["seriesByTag"]["accuracy"][0]["points"] == [[1, 0.25], [2, 0.75]]
assert group["seriesByTag"]["loss"][0]["points"] == [[1, 2.0], [2, 1.0]]
with patch.object(agent, "scalar_catalog", return_value={"plans": []}):
    groups = [{"planFile": "plan.yaml", "case": f"case-{index}"} for index in range(21)]
    assert len(agent.scalar_query("/virtual/project", {"groups": groups})["groups"]) == 20
print("scalar agent records: pass")
