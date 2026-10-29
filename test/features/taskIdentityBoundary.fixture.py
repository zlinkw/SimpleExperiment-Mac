import ast
import io
import json
import pathlib
import threading

source = (pathlib.Path(__file__).parents[2] / 'src/runtime/TmuxTaskLifecycle.ts').read_text(encoding='utf-8')
tree = ast.parse(source.split('String.raw`', 1)[1].rsplit('`', 1)[0])
stop = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'task_stop')
serve = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'task_queue_serve')
handler = next(node for node in serve.body if isinstance(node, ast.ClassDef) and node.name == 'Handler')
post = next(node for node in handler.body if isinstance(node, ast.FunctionDef) and node.name == 'do_POST')
job = dict(commandId='c', projectId='p', workerId='w', workflowId='f', outputDir='work_dirs/job',
           experimentIndex=0, globalJobId='f:0', case='case', seed=42, collectionResultCsv='tmp/result.csv', tmuxWindowId='@7')

def load(node, scope):
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), 'extracted-task-boundary', 'exec'), scope)

for changed in (False, True):
    rows = [dict(job)]
    closed = []
    def rpc(*args, **kwargs):
        if changed:
            rows[0]['commandId'] = 'unrelated'
        raise RuntimeError('controller unavailable')
    def tmux(args):
        closed.append(args)
        rows.clear()
    scope = dict(task_inventory=lambda *a, **k: list(rows), task_queue_rpc=rpc, task_tmux=tmux)
    load(stop, scope)
    try:
        scope['task_stop']('/virtual', dict(targetCommandId='c', projectId='p', workerId='w'), 'w')
        raise AssertionError('unconfirmed cancellation cannot complete')
    except (ValueError, RuntimeError) as error:
        assert ('TASK_OWNER_MISMATCH' if changed else 'TASK_CANCEL_UNCONFIRMED') in str(error)
    assert len(closed) == (0 if changed else 1)

scope = dict(json=json, root='/virtual', worker_id='w', secret='test', epoch='epoch', mutex=threading.RLock(),
             remembered=set(), task_inventory=lambda *a, **k: [job], task_public_observation=lambda *a: dict(job, status='queued'))
load(post, scope)
class Request:
    def __init__(self, payload):
        body = json.dumps(dict(action='accept', epoch='epoch', payload=payload)).encode()
        self.headers = {'Authorization': 'Bearer test', 'Content-Length': str(len(body))}
        self.rfile, self.wfile = io.BytesIO(body), io.BytesIO()
    def send_response(self, *args): pass
    def send_header(self, *args): pass
    def end_headers(self): pass

for key, value in [('workerId', 'other'), ('experimentIndex', 9), ('collectionResultCsv', 'tmp/other.csv')]:
    request = Request({**job, key: value})
    scope['do_POST'](request)
    assert json.loads(request.wfile.getvalue()) == dict(ok=False, error='TASK_COMMAND_ID_CONFLICT')
request = Request(dict(job))
scope['do_POST'](request)
assert json.loads(request.wfile.getvalue())['ok'] is True

# Initial admission accepts stable fields in options. The same request must stay idempotent.
nested = {key: value for key, value in job.items() if key in ("commandId", "projectId", "workflowId", "outputDir")}
nested["options"] = {key: value for key, value in job.items() if key not in nested}
request = Request(nested)
scope['do_POST'](request)
assert json.loads(request.wfile.getvalue())['ok'] is True, 'same nested identity must remain idempotent'

request = Request({**job, "options": {"workerId": "ignored-by-root", "experimentIndex": 9}})
scope['do_POST'](request)
assert json.loads(request.wfile.getvalue())['ok'] is True, 'top-level identity keeps admission precedence'

print('task identity boundaries passed')
