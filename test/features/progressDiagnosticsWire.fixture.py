"""Only extracted reader functions; no Agent/Scheduler startup or remote I/O."""
import ast
import hashlib
import io
import json
import os
import pathlib
import posixpath
import re
import threading
import types

root = pathlib.Path(__file__).resolve().parents[2]
def functions(relative):
    source = (root / relative).read_text(encoding='utf-8').split('String.raw`', 1)[1].rsplit('`', 1)[0]
    return [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef)]

data = b'ordinary output\n' * 40000 + b'Traceback (most recent call last):\n  File "train.py", line 1\nValueError: late failure\n'
info = types.SimpleNamespace(st_dev=1, st_ino=2, st_size=len(data), st_mtime_ns=3)
fake_path = types.SimpleNamespace(isabs=posixpath.isabs, relpath=posixpath.relpath, join=posixpath.join,
                                 realpath=lambda p: p, isfile=lambda p: True)
ns = dict(os=types.SimpleNamespace(path=fake_path, stat=lambda p: info), json=json, re=re, hashlib=hashlib,
          threading=threading, task_safe_path=lambda root, p: root + '/' + p,
          worker_task_console_log=lambda c: 'logs/' + c, open=lambda *args: io.BytesIO(data))
exec(compile(ast.Module(body=functions('src/runtime/RuntimeLogDiagnostics.ts'), type_ignores=[]), 'reader-only', 'exec'), ns)
report = ns['task_log_diagnostics']('/project', {'commandId': 'c'}, terminal=True)
assert report['scanComplete'] and report['bytesRead'] == len(data), report
assert report['count'] == 1 and report['state'] == 'anomalous', report

query = dict(commandId='c', projectId='p', workerId='w', outputDir='work/c')
manifest = dict(runId='c', status='completed', present=True, verified=True, identityMatches=True,
                artifactsComplete=True, exitCode=0, runtimeDiagnostics=dict(logPath='logs/c'))
report['exceptions'][0]['summary'] = 'large diagnostic detail' * 2000
ns.update(now_iso=lambda: 'remote-time', task_manifest_observation=lambda *args: manifest,
          task_log_diagnostics=lambda *args, **kwargs: report)
selected = [n for n in functions('src/runtime/TmuxTaskLifecycle.ts') if n.name == 'task_result_query']
exec(compile(ast.Module(body=selected, type_ignores=[]), 'result-query-only', 'exec'), ns)
plain = ns['task_result_query']('/project', [query], diagnostics_only=True)
compact = ns['task_result_query']('/project', [query], diagnostics_only=True, compact=True)
observed = compact['tasks'][0]['observation']
assert observed['runtimeDiagnostics']['count'] == 1 and observed['runtimeDiagnostics']['scanComplete']
assert observed['commandId'] == 'c' and observed['projectId'] == 'p' and observed['workerId'] == 'w'
assert len(json.dumps(compact)) < len(json.dumps(plain)) / 10
manifest['identityMatches'] = False
manifest['verified'] = False
metadata = ns['task_result_query']('/project', [query], compact=True)['tasks'][0]['observation']
assert metadata['result']['identityMatches'] is False and metadata['artifactIssue']
manifest['exitCode'] = 7
assert ns['task_result_query']('/project', [query], compact=True)['tasks'][0]['observation']['result']['exitCode'] == 7
print(json.dumps({'ok': True, 'plainBytes': len(json.dumps(plain)), 'compactBytes': len(json.dumps(compact)),
                  'scannedBytes': report['bytesRead']}))
