import ast, hashlib, json, os, pathlib, re, sys, tempfile
from unittest.mock import patch
config = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
source = pathlib.Path(config['source']).read_text(encoding='utf-8')
if 'String.raw`' in source:
    embedded = source.split('String.raw`', 1)[1].rsplit('`;', 1)[0]
    agent = pathlib.Path(config['source']).parent.parent.joinpath('clusterAgentRuntime.legacy.ts').read_text(encoding='utf-8')
    native = pathlib.Path(config['source']).parent.joinpath('TmuxTaskLifecycle.ts').read_text(encoding='utf-8')
else:
    agent = native = source
    tree = ast.parse(source)
    embedded = ast.unparse(ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and
        (node.name.startswith(('plan_scope_', 'plan_source_')) or node.name in ('inspect_plan_code_scope', 'verify_plan_execution_source', '_code_sync_stat_record'))], type_ignores=[]))
ns = dict(os=os, pathlib=pathlib, re=re, hashlib=hashlib, json=json, now_iso=lambda:'now')
exec(compile(embedded, 'isolated-source-and-assets', 'exec'), ns)
def production(text, name):
    match = re.search(r'(?m)^def '+name+r'\([^\n]*\):\n[\s\S]*?(?=\n(?:def |class |[A-Z][A-Z_]+\s*=)|\Z)', text)
    assert match, name
    return match.group(0)
for name in ('_code_sync_stat_record', 'resolve_durable_code_sync_proof'): exec(compile(production(agent,name),'actual-admission-function','exec'),ns)
exec(compile(production(native,'task_queue_job'),'actual-task-admission-function','exec'),ns)
base = pathlib.Path(tempfile.mkdtemp(prefix='plan-assets-scope-'))
root, shared, intermediary = base/'project', base/'shared model', base/'previous-project-cache'
root.mkdir(); shared.mkdir(); intermediary.mkdir()
def write(relative, text):
    target=root/relative; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(text, encoding='utf-8')
def sha(relative): return hashlib.sha256((root/relative).read_bytes()).hexdigest()
(root/'artifacts').mkdir()
(root/'artifacts/model_cache').symlink_to(intermediary, target_is_directory=True)
(intermediary/'biomedclip').symlink_to(shared, target_is_directory=True)
(shared/'open_clip_pytorch_model.bin').write_bytes(b'fixture weight')
plan='experiments/plans/current.yaml'
write(plan, 'train_command: python train.py\n')
write('train.py', 'from selection import validate\nvalidate()\n')
write('selection.py', 'from review import choose_candidate\ndef validate():\n    return choose_candidate()\n')
write('review.py', "def choose_candidate(): return 1\ndef check_review():\n    from tools.check_experiment_config import run_checks\n    return run_checks()\nif __name__ == '__main__':\n    check_review()\n")
write('tools/check_experiment_config.py', 'import importlib\ndef run_checks():\n    importlib.import_module(runtime_module)\n')
write('tools/check_dpl_real_assets.py', "import hashlib\nfrom pathlib import Path\ndef main():\n    assets=Path('artifacts/model_cache/biomedclip')\n    return hashlib.sha256((assets/'open_clip_pytorch_model.bin').read_bytes()).hexdigest()\nif __name__ == '__main__':\n    main()\n")
paths, notes = ns['plan_source_scope'](str(root),plan,sha(plan),['tools/check_dpl_real_assets.py'])
assert set(paths)=={plan,'train.py','selection.py','review.py'}, paths
cases=['unrelated_functions_and_main_excluded']
def rejected(label, operation, code):
    try:
        operation()
        raise AssertionError('accepted '+label)
    except ValueError as error:
        assert code in str(error), (label,str(error))
        cases.append(label)
# A real call to the checker cannot be silently clipped; unresolved imports need
# a finite explicit declaration, not a recursive tools/ scan.
original_train=(root/'train.py').read_text(encoding='utf-8')
write('train.py',original_train+'\nfrom review import check_review\ncheck_review()\n')
rejected('reachable_dynamic_import_requires_declaration',lambda:ns['plan_source_scope'](str(root),plan,sha(plan)),'DYNAMIC_IMPORT_UNDECLARED')
write('train.py',"from tools.check_dpl_real_assets import main\nmain()\n")
rejected('called_main_keeps_real_integrity_dependency',lambda:ns['plan_source_scope'](str(root),plan,sha(plan)),'PLAN_SOURCE_LINK')
write(plan,'train_command: python -m tools.check_dpl_real_assets\n')
rejected('module_main_entry_keeps_real_integrity_dependency',lambda:ns['plan_source_scope'](str(root),plan,sha(plan)),'PLAN_SOURCE_LINK')
write('train.py',"import importlib\nimportlib.import_module('review')\n")
write(plan,'train_command: python train.py\n')
assert 'tools/check_experiment_config.py' not in ns['plan_source_scope'](str(root),plan,sha(plan))[0]
cases.append('literal_import_does_not_execute_main')
write('train.py',"__import__('tools.check_dpl_real_assets').main()\n")
rejected('literal_import_called_member_is_reached',lambda:ns['plan_source_scope'](str(root),plan,sha(plan)),'PLAN_SOURCE_LINK')
for command_text in ["from importlib import import_module as load\nload(name='tools.check_dpl_real_assets').main()\n", "import importlib\nname='tools.check_dpl_real_assets'\nmodule=importlib.import_module(name=name)\nmodule.main()\n"]:
    write('train.py',command_text)
    rejected('import_alias_keyword_or_module_assignment_reached',lambda:ns['plan_source_scope'](str(root),plan,sha(plan)),'PLAN_SOURCE_LINK')
write('train.py',"import tools.check_dpl_real_assets as checker\ngetattr(checker, 'main')()\n")
rejected('literal_getattr_member_is_reached',lambda:ns['plan_source_scope'](str(root),plan,sha(plan)),'PLAN_SOURCE_LINK')
write('train.py',"import review\ngetattr(review, runtime_member)()\n")
rejected('dynamic_member_requires_finite_code_declaration',lambda:ns['plan_source_scope'](str(root),plan,sha(plan)),'DYNAMIC_CALL_UNDECLARED')
write('pkg/__init__.py','from .reader import run\n')
write('pkg/reader.py',"from tools.check_dpl_real_assets import main\ndef run(): return main()\n")
write('train.py','import pkg\npkg.run()\n')
rejected('package_reexport_reaches_actual_member',lambda:ns['plan_source_scope'](str(root),plan,sha(plan)),'PLAN_SOURCE_LINK')
write('train.py','import pkg\ngetattr(pkg,runtime_member)()\n')
rejected('package_dynamic_member_requires_declaration',lambda:ns['plan_source_scope'](str(root),plan,sha(plan)),'DYNAMIC_CALL_UNDECLARED')
write('decorated.py',"from pathlib import Path\ndef at_definition(function): return function()\n@at_definition\ndef hidden_read():\n    return Path('artifacts/model_cache/biomedclip/open_clip_pytorch_model.bin').read_bytes()\n")
write('train.py','import decorated\n')
rejected('decorator_definition_time_read_is_not_dropped',lambda:ns['plan_source_scope'](str(root),plan,sha(plan)),'PLAN_SOURCE_LINK')

weight='artifacts/model_cache/biomedclip/open_clip_pytorch_model.bin'
config_asset='artifacts/model_cache/biomedclip/open_clip_config.json'
tokenizer_asset='artifacts/model_cache/biomedclip/tokenizer/tokenizer.json'
# One extra chunk proves bounded streaming; this is a correctness assertion,
# not a load/performance threshold. No real model is used or deserialized.
(shared/'open_clip_pytorch_model.bin').write_bytes(b'w'*(4*1024*1024+31))
(shared/'open_clip_config.json').write_text('{"model_cfg":{}}',encoding='utf-8')
(shared/'tokenizer').mkdir()
(shared/'tokenizer/tokenizer.json').write_text('{"tokenizer":"fixture"}',encoding='utf-8')
def authorization(relative):
    target=(root/relative).resolve(strict=True)
    return dict(path=relative,allowed_root=str(shared),target=str(target),sha256=hashlib.sha256(target.read_bytes()).hexdigest(),approval='user-confirmed')
authorizations=[authorization(value) for value in (weight,config_asset,tokenizer_asset)]
write('weights_loader.py',"import hashlib\nfrom pathlib import Path\ndef load():\n    return hashlib.sha256(Path('"+weight+"').read_bytes()).hexdigest()\n")
write('train.py','from weights_loader import load\nload()\n')
write('configs/model.yaml','model:\n  joint_encoder_cfg:\n    model_path: artifacts/model_cache/biomedclip\n    tokenizer_path: artifacts/model_cache/biomedclip/tokenizer\n    local_files_only: true\n')
document=dict(train_command='python train.py',base_config='configs/model.yaml',source_dependencies=dict(assets=authorizations,integrity=[weight],inputs=[config_asset,tokenizer_asset]))
def set_plan(value): write(plan,json.dumps(value,ensure_ascii=False))
set_plan(dict(train_command='python train.py',base_config='configs/model.yaml'))
rejected('local_encoder_directory_requires_exact_asset_set',lambda:ns['plan_source_scope'](str(root),plan,sha(plan)),'PLAN_ASSET_DIRECTORY_UNDECLARED')
set_plan(document)
declarations={}
source_paths,_=ns['plan_source_scope'](str(root),plan,sha(plan),assets=declarations)
assert set(declarations)=={weight,config_asset,tokenizer_asset}
assert not set(declarations).intersection(source_paths)
manifest={file:dict(size=(root/file).stat().st_size,sha256=sha(file)) for file in source_paths}
row=dict(projectId='fixture-project',planFile=plan,planRevision=sha(plan),codeFingerprint=ns['plan_source_digest'](manifest))
proof=dict(projectId=row['projectId'],codeFingerprint=row['codeFingerprint'],files=[dict(path=file,**value) for file,value in manifest.items()])
ns.update(code_sync_proof_document=lambda _:dict(proofs={'fixture':proof}),durable_code_manifest_digest=ns['plan_source_digest'],task_safe_path=ns['plan_scope_path'],task_inventory=lambda _:[])
response=ns['inspect_plan_code_scope'](str(root),row)
source_record=response['executionSource']
assert set(source_record['assets'])==set(declarations) and response['assetCount']==3
assert source_record['assets'][weight]['target']==str(shared/'open_clip_pytorch_model.bin')
assert len(source_record['assets'][weight]['links'])==2
assert ns['resolve_durable_code_sync_proof'](str(root),dict(row,executionSource=source_record))['assetCount']==3
command=dict(row,commandId='synthetic',workflowId='fixture',globalJobId='fixture:0',experimentIndex=0,workerId='worker',outputDir='work_dirs/fixture',collectionResultCsv='tmp/fixture.csv',resultPathPolicy='declared',executionSource=source_record)
assert ns['task_queue_job'](str(root),'worker',command)['executionSource']==source_record
cases.append('actual_inspection_and_two_admission_boundaries_verify_assets')

# Assert actual reads are bounded, while still hashing a real multi-chunk file.
read_sizes=[]
real_fdopen=os.fdopen
class Reader:
    def __init__(self,stream): self.stream=stream
    def __enter__(self): self.stream.__enter__();return self
    def __exit__(self,*args): return self.stream.__exit__(*args)
    def fileno(self): return self.stream.fileno()
    def read(self,size=-1):
        assert 0<size<=4*1024*1024, size
        read_sizes.append(size);return self.stream.read(size)
with patch.object(os,'fdopen',lambda *args,**kwargs:Reader(real_fdopen(*args,**kwargs))):
    assert ns['plan_scope_verify_asset'](str(root),authorizations[0],source_record['assets'][weight])==source_record['assets'][weight]
assert len(read_sizes)>=3
cases.append('large_asset_streamed_in_bounded_chunks')
class MutatingReader(Reader):
    changed=False
    def read(self,size=-1):
        data=super().read(size)
        if data and not self.changed:
            self.changed=True
            with open(shared/'open_clip_pytorch_model.bin','r+b') as output: output.write(b'v')
        return data
with patch.object(os,'fdopen',lambda *args,**kwargs:MutatingReader(real_fdopen(*args,**kwargs))):
    rejected('file_changes_during_stream_rejected',lambda:ns['plan_scope_verify_asset'](str(root),authorizations[0]),'CHANGED_DURING_READ')
with open(shared/'open_clip_pytorch_model.bin','r+b') as output: output.write(b'w')
rejected('missing_approval_rejected',lambda:ns['plan_scope_verify_asset'](str(root),{**authorizations[0],'approval':'measured-only'}),'AUTHORIZATION_REQUIRED')
rejected('digest_mismatch_rejected',lambda:ns['plan_scope_verify_asset'](str(root),{**authorizations[0],'sha256':'0'*64}),'DIGEST_MISMATCH')
rejected('asset_directory_not_regular_file',lambda:ns['plan_scope_verify_asset'](str(root),{**authorizations[0],'path':'artifacts/model_cache/biomedclip/tokenizer','target':str(shared/'tokenizer')}),'NOT_REGULAR')
rejected('lexical_escape_rejected',lambda:ns['plan_scope_verify_asset'](str(root),{**authorizations[0],'path':'../outside'}),'PATH_INVALID')
rejected('unapproved_directory_rejected',lambda:ns['plan_scope_verify_asset'](str(root),{**authorizations[0],'allowed_root':str(shared/'tokenizer')}),'UNAUTHORIZED_TARGET')
rejected('unknown_authorization_field_rejected',lambda:ns['plan_scope_asset_declaration']({**authorizations[0],'extra':True}),'AUTHORIZATION_REQUIRED')
bad_document={**document,'source_dependencies':{**document['source_dependencies'],'code':[weight]}}
set_plan(bad_document)
rejected('asset_cannot_be_executable_source',lambda:ns['plan_source_scope'](str(root),plan,sha(plan)),'NOT_EXECUTABLE')
set_plan(document)

def projection(name,redirect):
    directory=base/name;directory.mkdir();(directory/'artifacts').mkdir()
    (directory/'artifacts/model_cache').symlink_to(redirect,target_is_directory=True)
    for file in source_paths:
        target=directory/file;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((root/file).read_bytes())
    return directory
other=base/'other assets';other.mkdir();(other/'biomedclip').symlink_to(base/'not-authorized',target_is_directory=True)
(base/'not-authorized').mkdir();(base/'not-authorized/open_clip_pytorch_model.bin').write_bytes(b'unapproved')
unauthorized=projection('unauthorized-project',other)
rejected('unauthorized_external_target_rejected',lambda:ns['plan_scope_verify_asset'](str(unauthorized),authorizations[0]),'UNAUTHORIZED_TARGET')
broken=projection('broken-project',base/'absent-target')
rejected('broken_link_rejected',lambda:ns['plan_scope_verify_asset'](str(broken),authorizations[0]),'MISSING_OR_BROKEN_LINK')
loop=base/'cycle';loop.mkdir();(loop/'biomedclip').symlink_to('second');(loop/'second').symlink_to('biomedclip')
cyclic=projection('cyclic-project',loop)
rejected('link_cycle_rejected',lambda:ns['plan_scope_verify_asset'](str(cyclic),authorizations[0]),'LINK_LOOP')
alternate=base/'alternate-cache';alternate.mkdir();(alternate/'biomedclip').symlink_to(shared,target_is_directory=True)
changed=projection('changed-link-project',alternate)
rejected('link_replacement_same_content_rejected',lambda:ns['verify_plan_execution_source'](str(changed),row,source_record),'BINDING_CHANGED')
missing_source={**source_record,'assets':{}}
missing_source['digest']=ns['plan_source_digest'](manifest)
rejected('stripped_asset_binding_rejected',lambda:ns['verify_plan_execution_source'](str(root),row,missing_source),'ASSET_DEPENDENCIES_CHANGED')
original_weight=(shared/'open_clip_pytorch_model.bin').read_bytes()
(shared/'open_clip_pytorch_model.bin').write_bytes(b'v'*len(original_weight))
rejected('content_change_rejected_before_admission',lambda:ns['task_queue_job'](str(root),'worker',command),'DIGEST_MISMATCH')
(shared/'open_clip_pytorch_model.bin').write_bytes(original_weight)
rejected('record_tampering_rejected',lambda:ns['verify_plan_execution_source'](str(root),row,{**source_record,'assets':{weight:{}}}),'BASELINE_INVALID')
local_files={file:(root/file).read_text(encoding='utf-8') for file in source_paths}
print(json.dumps(dict(unrelatedMainExcluded=True,noTraining=True,assetCases=cases,response=response,localFiles=local_files),ensure_ascii=True))
