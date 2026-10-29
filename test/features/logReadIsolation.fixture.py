"""Extracted reader only: emulate one NFS read waiting; never run a runtime."""
import ast, io, os, posixpath, pathlib, sys, threading, types, json, re, hashlib
source=pathlib.Path(sys.argv[1]).read_text(encoding='utf8').split('String.raw`',1)[1].rsplit('`',1)[0]
nodes=[n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef)]
entered=threading.Event();release=threading.Event();fast_done=threading.Event();reports={}
data=b'normal output\n'
class Stream(io.BytesIO):
    def __init__(self,path):super().__init__(data);self.path=path
    def read(self,size=-1):
        if self.path.endswith('/slow.log') and size==256*1024:
            entered.set();assert release.wait(3),'bounded slow read'
        return super().read(size)
fake_path=types.SimpleNamespace(isabs=posixpath.isabs,relpath=posixpath.relpath,join=posixpath.join,realpath=lambda p:p,isfile=lambda p:True)
fake_os=types.SimpleNamespace(path=fake_path,stat=lambda p:types.SimpleNamespace(st_dev=1,st_ino=hash(p),st_size=len(data),st_mtime_ns=1))
ns=dict(os=fake_os,json=json,re=re,hashlib=hashlib,threading=threading,task_safe_path=lambda root,rel:root+'/'+rel,
        worker_task_console_log=lambda command:'logs/'+command+'.log',open=lambda path,mode:Stream(path))
exec(compile(ast.Module(body=nodes,type_ignores=[]),'log-reader-only','exec'),ns)
def read(command):
    reports[command]=ns['task_log_diagnostics']('/project',{'commandId':command},terminal=True)
    if command=='fast':fast_done.set()
slow=threading.Thread(target=read,args=('slow',));fast=threading.Thread(target=read,args=('fast',))
slow.start()
try:
    assert entered.wait(1),'slow read started: '+str(reports)
    fast.start()
    assert fast_done.wait(.5),'one NFS log read held the global lock and blocked another job'
    assert reports['fast']['scanComplete'] and reports['fast']['state']=='clear'
    duplicate=ns['task_log_diagnostics']('/project',{'commandId':'slow'},terminal=True)
    assert not duplicate['scanComplete'] and '正在读取' in duplicate['reason'],'same-log retry must not queue another blocking read'
finally:
    release.set();slow.join(2)
    if fast.ident is not None:fast.join(2)
assert not slow.is_alive() and not fast.is_alive()
print('different logs are independent; one job retains serialized parsing')
