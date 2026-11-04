"""Execute selected production functions and HTTP branches only, never full Agent/project code."""
import ast, copy, hashlib, json, os, pathlib, re, sys, tempfile, threading, time, traceback, types
config=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
tree=ast.parse(pathlib.Path(config['agent']).read_text(encoding='utf-8'))
names={'verify_plan_execution_source','inspect_plan_code_scope','_code_sync_stat_record','start_plan_scope_request','code_sync_request_state'}
selected=[node for node in tree.body if isinstance(node,ast.FunctionDef) and (node.name in names or node.name.startswith(('plan_scope_','plan_source_')))]
ns=dict(os=os,pathlib=pathlib,re=re,hashlib=hashlib,json=json,copy=copy,threading=threading,time=time,traceback=traceback,
        CODE_SYNC_REQUEST_LOCK=threading.RLock(),CODE_SYNC_REQUESTS={},now_iso=lambda:'now')
exec(compile(ast.Module(body=selected,type_ignores=[]),'isolated-agent-functions','exec'),ns)
base=pathlib.Path(tempfile.mkdtemp(prefix='plan-operation-real-'));root=base/'project';root.mkdir();(root/'plans').mkdir()
assetdir=base/'shared-assets';assetdir.mkdir();asset=assetdir/'weight.bin';asset.write_bytes(b'private fixture weight')
(root/'assets').mkdir();(root/'assets/weight.bin').write_bytes(asset.read_bytes())
# Native paths work on both desktop platforms; no real server/config/weight is accessed.
declaration=dict(path='assets/weight.bin',allowed_root=str((root/'assets').resolve()),target=str((root/'assets/weight.bin').resolve()),sha256=hashlib.sha256(asset.read_bytes()).hexdigest(),approval='user-confirmed')
plan='plans/中文 空格.yaml';(root/plan).write_text('train_command: python train.py\nsource_dependencies:\n  assets: '+json.dumps([declaration])+'\n',encoding='utf-8');(root/'train.py').write_text('VALUE=1\n',encoding='utf-8')
manifest={file:dict(size=(root/file).stat().st_size,sha256=hashlib.sha256((root/file).read_bytes()).hexdigest()) for file in (plan,'train.py')}
assets={declaration['path']:ns['plan_scope_asset_snapshot'](str(root),declaration)}
source=dict(manifest=manifest,assets=assets,digest=ns['plan_source_digest'](manifest,assets))
query=dict(projectId='project',planFile=plan,planRevision=manifest[plan]['sha256'],codeFingerprint='actual-proof-identity',executionSource=source)
ns.update(root=str(root),args=types.SimpleNamespace(worker_id='worker-a'),unquote=lambda value:value)
# Compile only the exact POST source-check and GET operation branches into a fake HTTP handler.
branches={}
for node in ast.walk(tree):
    if not isinstance(node,ast.If): continue
    if isinstance(node.test,ast.Compare) and isinstance(node.test.left,ast.Name) and node.test.left.id=='route' and len(node.test.comparators)==1 and isinstance(node.test.comparators[0],ast.Constant) and node.test.comparators[0].value=='/api/code-sync/plan-scope': branches['post']=node
    if isinstance(node.test,ast.Name) and node.test.id=='operation_route': branches['get']=node
assert set(branches)=={'post','get'}
for name,branch in branches.items():
    function=ast.parse('def '+name+'(self,route):\n    pass').body[0];function.body=branch.body
    exec(compile(ast.fix_missing_locations(ast.Module(body=[function],type_ignores=[])),'actual-http-branch','exec'),ns)
class Handler:
    def __init__(self,payload): self.payload=payload
    def read_request_body(self,_route): return json.dumps(self.payload,ensure_ascii=False).encode('utf-8')
    def send_json(self,value,status=200): return value,status
def post(op,**patch): return ns['post'](Handler(dict(query,operationId=op,**patch)),'/api/code-sync/plan-scope')
def get(op): return ns['get'](Handler({}),'/api/operations/'+op)[0]
def finish(op):
    # Test-only bounded join/observation, not production retries or a performance threshold.
    for _ in range(1000):
        row=get(op)
        if row['status'] in ('completed','failed'): return row
        time.sleep(.001)
    raise AssertionError('fixture operation did not finish')
actual=ns['inspect_plan_code_scope'];entered=threading.Event();release=threading.Event();calls=[]
def held(*args):
    calls.append(args[1]['planFile']);entered.set();assert release.wait(2),'fixture gate';return actual(*args)
ns['inspect_plan_code_scope']=held
first,status=post('original');assert status==202;assert entered.wait(1)
assert post('original')[0]['operationId']=='original';assert post('alias')[0]['operationId']=='alias';assert len(calls)==1
before=get('original');assert before['status']=='running';assert before['readOnly'] and before['remoteExecution']=='not_started'
assert get('original')['progressSequence']==before['progressSequence'],'polling cannot manufacture progress'
assert 'requestDigest' not in before
bad,status=post('original',codeFingerprint='changed');assert status==400 and 'INPUT_CONFLICT' in bad['error']
assert ns['code_sync_request_state'](str(root),'worker-b','original') is None
assert ns['code_sync_request_state'](str(base),'worker-a','original') is None
release.set();done=finish('original');assert done['status']=='completed',done
assert get('alias')['result']==done['result'];assert get('alias')['operationId']=='alias'
assert done['progressSequence']>before['progressSequence']
for phase in ('dependencyAnalysisMs','sourceVerificationMs','assetResolutionMs','assetHashReadMs','resultPreparationMs'): assert phase in done['timings'] and done['timings'][phase]>=0,(phase,done)
assert done['result']['executionSource']==source
ns['inspect_plan_code_scope']=actual
post('fresh');assert finish('fresh')['status']=='completed'
(root/'train.py').write_text('VALUE=2\n',encoding='utf-8');post('changed');failed=finish('changed');assert failed['status']=='failed' and 'changed' in failed['error'].lower(),failed
(root/'train.py').write_text('VALUE=1\n',encoding='utf-8');(root/'assets/weight.bin').write_bytes(b'wrong fixture weight!!');post('asset-changed');asset_failed=finish('asset-changed');assert 'PLAN_ASSET_DIGEST_MISMATCH' in asset_failed['error'],asset_failed
legacy,status=ns['post'](Handler(query),'/api/code-sync/plan-scope');assert status==400 and legacy['readOnly'],'synchronous path retains real validation'
assert len(ns['CODE_SYNC_REQUESTS'])==5
print(json.dumps(dict(cases=14,noTraining=True,actualHttpBranches=True,actualSourceAndAssetChecks=True,phaseTimings=sorted(done['timings']),aliasSharesWork=True,rootAndWorkerIsolation=True)))
