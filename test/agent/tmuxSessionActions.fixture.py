"""Extract production functions only; never contact a user tmux server."""
import ast
import base64
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "_helpers"))
from closeFixtureTmuxWindows import close_fixture_tmux_windows
source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
nodes = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and
         (node.name in ("kill_tmux_window_response", "manage_tmux_session_response", "task_inventory", "task_tmux", "task_read_job"))]
socket = "se-controls-" + uuid.uuid4().hex
actual_run = subprocess.run
calls = []
def isolated(args, **kwargs):
    assert args[0] == "tmux"
    calls.append(args)
    return actual_run(["tmux", "-L", socket] + args[1:], **kwargs)
subprocess.run = isolated
scope = dict(subprocess=subprocess, os=os, re=re, json=json, base64=base64, hashlib=hashlib, SCHEMA_VERSION=1)
exec(compile(ast.Module(body=nodes, type_ignores=[]), "production-controls", "exec"), scope)
def tmux(*args):
    result = isolated(["tmux", *args], capture_output=True, text=True, timeout=2)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()
def identities(session):
    return [dict(session=session, windowId=row.split('|')[0], windowName=row.split('|')[1],
                 paneIds=tmux('list-panes','-t',row.split('|')[0],'-F','#{pane_id}').splitlines())
            for row in tmux('list-windows','-t','='+session,'-F','#{window_id}|#{window_name}').splitlines()]
def action(session, kind, frozen=None, confirm=True):
    return scope['kill_tmux_window_response'](dict(session=session, sessionAction=kind,
             identities=identities(session) if frozen is None else frozen, confirm=confirm), 'worker_telemetry')
try:
    os.environ.pop('SIMPLE_EXPERIMENT_TMUX_SESSION', None)
    tmux('new-session','-d','-s','ordinary','-n','first')
    tmux('new-session','-d','-s','unrelated','-n','keep')
    tmux('new-window','-d','-t','ordinary','-n','second')
    before=identities('ordinary')
    response,status=action('ordinary','clear',confirm=False)
    assert status==403 and identities('ordinary')==before, response
    tmux('new-window','-d','-t','ordinary','-n','unconfirmed')
    response,status=action('ordinary','close',before)
    assert not response['ok'] and len(identities('ordinary'))==3, response
    response,status=action('ordinary','clear')
    assert status==200 and response.get('verified') and len(identities('ordinary'))==1, response
    assert identities('ordinary')[0]['windowName']=='bash'
    assert all(item['windowId']!=response['idleWindowId'] for item in before)
    response,status=action('ordinary','close')
    assert status==200 and response.get('verified'), response
    assert isolated(['tmux','has-session','-t','=ordinary'],capture_output=True,timeout=2).returncode!=0
    assert identities('unrelated')[0]['windowName']=='keep'
    tmux('new-session','-d','-s','protected-agent','-n','agent')
    response,status=action('protected-agent','close')
    assert status==403 and identities('protected-agent'), response
    tmux('new-session','-d','-s','unusual-name','-n','agent')
    response,status=action('unusual-name','clear')
    assert not response['ok'] and identities('unusual-name'), response
    # Native task evidence remains readable without any worker snapshot file.
    pane=tmux('display-message','-p','-t','unrelated:keep','#{pane_id}')
    job=dict(root='/fixture-project',lifecycleProtocol=2,pane=pane,commandId='native-job',workerId='w1',gpuId='0')
    tmux('set-option','-w','-t',pane,'@se_job',base64.urlsafe_b64encode(json.dumps(job).encode()).decode())
    tmux('set-option','-w','-t',pane,'@se_phase','running')
    found=scope['task_inventory']('/fixture-project')
    assert len(found)==1 and found[0]['tmuxSession']=='unrelated' and found[0]['commandId']=='native-job', found
    assert not scope['task_inventory']('/other-project')
    print('ok: real session actions, native tasks, no snapshots')
finally:
    close_fixture_tmux_windows(lambda args: isolated(["tmux", *args], capture_output=True, text=True, timeout=2), socket_name=socket)
