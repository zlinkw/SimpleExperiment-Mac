import argparse
import ast
import json
import os
import pathlib
import sys
import io
import threading
import types

agent_tree=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
ns={}
nodes=[n for n in agent_tree.body if isinstance(n,ast.FunctionDef) and n.name in ('api_capabilities','api_openapi','run_agent')]
exec(compile(ast.Module(body=nodes,type_ignores=[]),'retired_hub_api','exec'),ns)
for name in ('api_capabilities','api_openapi'):
    try:
        ns[name]('/unused',mode='hub_control')
        raise AssertionError('Hub execution remained enabled')
    except ValueError as error:
        assert 'HUB_REMOVED' in str(error)
try:
    ns['run_agent'](argparse.Namespace(project_dir='/unused'))
    raise AssertionError('retired Hub collector started')
except ValueError as error:
    assert 'HUB_REMOVED' in str(error)
class Sink(io.StringIO):
    def __exit__(self, *args):
        return False
sink = Sink()
event_ns = dict(json=json, os=types.SimpleNamespace(makedirs=lambda *a, **k: None, environ={'SIMPLE_EXPERIMENT_WORKER_ID':'chosen-worker'}),
    EVENT_APPEND_LOCK=threading.RLock(), SCHEMA_VERSION=1, MAX_AGENT_EVENT_RECORD_BYTES=1024,
    prune_runtime_memory_state=lambda:None, agent_dir=lambda root:root, read_seq=lambda root:0, now_iso=lambda:'now',
    compact_terminal_event=lambda *args:None, open=lambda *args,**kwargs:sink, path_for=lambda *args:'unused',
    write_seq=lambda *args:None, compact_journal=lambda *args:None, prune_agent_state=lambda *args:None,
    maybe_auto_run_completion_pipeline=lambda *args:None)
emit=next(n for n in agent_tree.body if isinstance(n,ast.FunctionDef) and n.name=='append_event')
exec(compile(ast.Module(body=[emit],type_ignores=[]),'worker_events','exec'),event_ns)
for payload in ({'type':'agent_heartbeat','payload':{}},{'type':'unknown','payload':{'large':'x'*4096}}):
    emitted=event_ns['append_event']('/unused',payload)
    assert emitted['source']=='worker_telemetry' and emitted['workerId']=='chosen-worker'
    assert 'hubId' not in emitted
scheduler=ast.parse(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'))
main=next(n for n in scheduler.body if isinstance(n,ast.FunctionDef) and n.name=='main')
ns=dict(argparse=argparse,os=os,normalize_default_result_csv_dir=lambda p:p)
exec(compile(ast.Module(body=[main],type_ignores=[]),'worker_main','exec'),ns)
sys.argv=['scheduler','--plan','unused.yaml']
try:
    ns['main']()
    raise AssertionError('global scheduler was started')
except SystemExit as error:
    assert 'GLOBAL_SCHEDULER_REMOVED' in str(error),str(error)
print(json.dumps({'hubApiRejected':True,'globalSchedulerRejected':True}))
