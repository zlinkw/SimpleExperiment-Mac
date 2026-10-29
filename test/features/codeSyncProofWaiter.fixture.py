import ast
import copy
import hashlib
import json
import os
import pathlib
import re
import tempfile
import threading
import time
import traceback

root_path = pathlib.Path(__file__).resolve().parents[2]
tree = ast.parse((root_path / 'dist/runtime/cluster_agent.py').read_text(encoding='utf-8'))
names = {'register_code_sync_proof', 'register_code_sync_proof_request', 'code_sync_request_state', '_code_sync_stat_record'}
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert len(nodes) == len(names)
env = {name: value for name, value in globals().items() if not name.startswith('__')}
env.update(CODE_SYNC_REQUEST_LOCK=threading.RLock(), CODE_SYNC_REQUESTS={})
exec(compile(ast.Module(body=nodes, type_ignores=[]), 'selected-agent-functions', 'exec'), env)
root = tempfile.mkdtemp(prefix='code-sync-request-')
manifest = {}
for index in range(4):
    name = 'file%d.py' % index
    data = ('fixture%d' % index).encode('utf-8')
    pathlib.Path(root, name).write_bytes(data)
    manifest[name] = {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
digest = 'a' * 64
stores = []
env.update(durable_code_manifest_digest=lambda value: digest, code_sync_proof_runtime_generation=lambda: 'runtime',
           code_sync_proof_id=lambda *args: 'b' * 64, code_sync_proof_document=lambda value: {},
           _store_code_sync_proof=lambda root, proof: stores.append(proof), signal_durable_plan_queue_processor=lambda *args: None,
           now_iso=lambda: 'now')
actual_stat = env['_code_sync_stat_record']
gate = threading.Event()
def delayed_stat(*args, **kwargs):
    assert gate.wait(1)
    time.sleep(0.025)
    return actual_stat(*args, **kwargs)
env['_code_sync_stat_record'] = delayed_stat
payload = {'opId': 'original-operation', 'workerId': 'worker', 'projectId': '/project', 'codeFingerprint': digest,
           'manifestDigest': digest, 'scopeSignature': 'c' * 64, 'codeManifest': manifest, 'async': True}
started = time.monotonic()
row = env['register_code_sync_proof_request'](root, payload, 'worker')
assert time.monotonic() - started < 0.2 and row['status'] == 'running' and row['processedFiles'] == 0
assert env['register_code_sync_proof_request'](root, payload, 'worker')['operationId'] == payload['opId']
try:
    env['register_code_sync_proof_request'](root, {**payload, 'projectId': '/other'}, 'worker')
except ValueError:
    pass
else:
    raise AssertionError('modified input reused operationId')
gate.set()
counts = []
deadline = time.monotonic() + 2
while time.monotonic() < deadline:
    row = env['code_sync_request_state'](root, 'worker', payload['opId'])
    counts.append(row['processedFiles'])
    if row['status'] in ('completed', 'failed'):
        break
    time.sleep(0.005)
assert row['status'] == 'completed', row
assert row['processedFiles'] == 4 and any(0 < count < 4 for count in counts)
assert len(stores) == 1 and stores[0]['fileCount'] == 4
assert env['code_sync_request_state'](root, 'different-worker', payload['opId']) is None
print(json.dumps({'ok': True, 'asyncBoundary': True, 'duplicateStarts': len(stores)}))
