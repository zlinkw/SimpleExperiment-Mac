import re
import sys

source = sys.stdin.read()

def extract(name):
    marker = f"def {name}("
    start = source.index(marker)
    end = source.find("\ndef ", start + len(marker))
    if end < 0:
        end = len(source)
    return source[start:end]

namespace = {"re": re}
exec(extract("scheduler_stop_record_identity"), namespace)
exec(extract("parse_linux_process_start_identity"), namespace)

resolve = namespace["scheduler_stop_record_identity"]
identity = resolve("op-1", "experiments/plans/a.yaml", {
    "operationId": "op-1",
    "payload": {"planFile": "./experiments/plans/a.yaml", "pid": 123, "tmuxSession": "configured-sch-op-1"},
})
assert identity == {
    "planFile": "experiments/plans/a.yaml",
    "pid": 123,
    "pidStartIdentity": "",
    "tmuxSession": "configured-sch-op-1",
}, identity

for event in (
    {"operationId": "op-2", "payload": {"planFile": "experiments/plans/a.yaml"}},
    {"operationId": "op-1", "payload": {"planFile": "experiments/plans/b.yaml"}},
    {"operationId": "op-1", "payload": {}},
):
    try:
        resolve("op-1", "experiments/plans/a.yaml", event)
    except ValueError:
        pass
    else:
        raise AssertionError(f"accepted mismatched or incomplete stop identity: {event!r}")

fields = ["S"] + [str(index) for index in range(1, 20)]
fields[19] = "987654"
parsed = namespace["parse_linux_process_start_identity"]("22 (worker (python) task) " + " ".join(fields))
assert parsed == "987654", parsed
print("stop identity ok")
