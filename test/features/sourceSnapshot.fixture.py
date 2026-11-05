"""Private filesystem and AST-only production checks. Never invoke project functions."""
import ast, hashlib, json, os, pathlib, re, sys, tempfile
config=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
source=pathlib.Path(config['runtime']).read_text(encoding='utf-8')
embedded=source.split('String.raw`',1)[1].rsplit('`;',1)[0] if 'String.raw`' in source else source
tree=ast.parse(embedded)
selected=[node for node in tree.body if isinstance(node,ast.FunctionDef) and (node.name.startswith(('plan_scope_','plan_source_')) or node.name in ('verify_plan_execution_source','inspect_plan_code_scope'))]
ns=dict(os=os,pathlib=pathlib,re=re,hashlib=hashlib,json=json,now_iso=lambda:'now')
exec(compile(ast.Module(body=selected,type_ignores=[]),'actual-source-functions','exec'),ns)
agent=pathlib.Path(config['agent']).read_text(encoding='utf-8')
actual=re.search(r'(?m)^def _code_sync_stat_record\([^\n]*\):\n[\s\S]*?(?=\ndef )',agent)
assert actual,'actual byte verifier'
exec(compile(actual.group(0),'actual-byte-verifier','exec'),ns)
digest_function=re.search(r'(?m)^def durable_code_manifest_digest\([^\n]*\):\n[\s\S]*?(?=\ndef )',agent)
assert digest_function
exec(compile(digest_function.group(0),'actual-original-inventory-digest','exec'),ns)
protocol=pathlib.Path(config['protocol']).read_text(encoding='utf-8')
base=pathlib.Path(tempfile.mkdtemp(prefix='source-snapshot-static-'))
plan='experiments/plans/current.yaml';module='experiments/simple_adapter/code_snapshot.py'
files={plan:'train_command: python train.py\n','train.py':'from experiments.simple_adapter.code_snapshot import backup_code\nbackup_code(runtime_output, cfg)\n',module:protocol,
 'models/core.py':'from models.missing_historical_module import never_execute\n',
 'configs/unused.yaml':'base_config: missing_history.yaml\n',
 'README.md':'private source documentation\n','docs/baseline-lock.json':'{"record":"experiments/results/history.json","base_config":"missing.yaml"}',
 'experiments/results/old.py':'excluded historical code\n','experiments/runs/old.yaml':'excluded run\n','data/masks/private.py':'excluded mask\n',
 'models/__pycache__/stale.py':'excluded cache\n','models/weights.bin':'excluded binary\n','docs/unlisted.md':'not an explicit file\n','configs/notes.txt':'not selected\n'}
expected={plan,'train.py',module,'models/core.py','configs/unused.yaml','README.md','docs/baseline-lock.json'}
def project(name,changes=None,omit=()):
 root=base/name;root.mkdir()
 for relative,text in {**files,**(changes or {})}.items():
  if relative in omit: continue
  file=root/relative;file.parent.mkdir(parents=True,exist_ok=True);file.write_text(text,encoding='utf-8')
 return root
def revision(root): return hashlib.sha256((root/plan).read_bytes()).hexdigest()
def scope(root): return ns['plan_source_scope'](str(root),plan,revision(root))
cases=[]
root=project('initial');paths,notes=scope(root)
assert set(paths)==expected,(paths,expected)
assert not (root/'work_dirs').exists() and not (root/'code_backup').exists()
cases.extend(['whole_backup_without_output_files','literal_roots_and_exact_directory_filter','json_integrity_not_recursive_configuration'])
manifest={name:dict(size=(root/name).stat().st_size,sha256=hashlib.sha256((root/name).read_bytes()).hexdigest()) for name in paths}
baseline=dict(manifest=manifest,digest=ns['plan_source_digest'](manifest))
row=dict(projectId='snapshot-fixture',planFile=plan,planRevision=revision(root),codeFingerprint='original-code-proof')
inventory={name:dict(size=(root/name).stat().st_size,sha256=hashlib.sha256((root/name).read_bytes()).hexdigest()) for name in files}
row['codeFingerprint']=ns['durable_code_manifest_digest'](inventory)
def proof(items,fingerprint): return {'proofs':{'original':{'projectId':row['projectId'],'codeFingerprint':fingerprint,'files':[dict(path=name,**value) for name,value in items.items()]}}}
ns['code_sync_proof_document']=lambda _root:proof(inventory,row['codeFingerprint'])
fresh=ns['inspect_plan_code_scope'](str(root),row)
assert fresh['executionSource']==baseline
cases.append('complete_snapshot_bound_to_original_code_inventory')
partial={name:value for name,value in inventory.items() if name!='docs/baseline-lock.json'}
partial_fingerprint=ns['durable_code_manifest_digest'](partial)
ns['code_sync_proof_document']=lambda _root:proof(partial,partial_fingerprint)
try: ns['inspect_plan_code_scope'](str(root),dict(row,codeFingerprint=partial_fingerprint));raise AssertionError('accepted unapproved snapshot file')
except ValueError as error: assert 'ORIGINAL_DEPENDENCY_MISSING' in str(error) and 'docs/baseline-lock.json' in str(error),str(error)
cases.append('snapshot_file_missing_from_original_inventory_rejected')
assert ns['inspect_plan_code_scope'](str(root),{**row,'executionSource':baseline})['ok']
if 'plan_scope_snapshot_protocol' in ns:
 records=ns['plan_scope_snapshot_protocol'](ast.parse(protocol));assert records
 generated={ast.unparse(node.func) for record in records for node in record['generated']}
 integrity={ast.unparse(node.func) for record in records for node in record['integrity']}
 assert generated=={'target.read_bytes','complete.read_text'},generated
 assert integrity=={'path.read_bytes','shutil.copy2'},integrity
 cases.extend(['source_digest_and_copy_source_are_integrity','copied_bytes_verification_is_output','reuse_marker_verification_is_output'])
def reject(label,root,fragment,baseline=baseline):
 try:
  ns['verify_plan_execution_source'](str(root),row,baseline)
  raise AssertionError('accepted '+label)
 except ValueError as error: assert fragment in str(error),(label,str(error))
 cases.append(label)
reject('source_content_change',project('changed',{'models/core.py':files['models/core.py'].replace('never_execute','never_executf')}),'changed')
reject('membership_addition',project('added',{'models/new.py':'VALUE=2\n'}),'DEPENDENCIES_CHANGED')
reject('membership_removal',project('removed',omit=('models/core.py',)),'DEPENDENCIES_CHANGED')
ignored=project('ignored-addition',{'experiments/results/new.py':'ignored result\n','configs/new.txt':'ignored suffix\n'})
assert ns['verify_plan_execution_source'](str(ignored),row,baseline)['fileCount']==len(expected)
cases.append('ignored_files_do_not_change_source_set')
reuse=project('existing-snapshot')
marker=reuse/'work_dirs/plan/code_backup/previous/.complete';marker.parent.mkdir(parents=True);marker.write_text('private existing snapshot marker\n',encoding='utf-8')
before=marker.read_bytes();assert ns['verify_plan_execution_source'](str(reuse),row,baseline)['fileCount']==len(expected);assert marker.read_bytes()==before
cases.append('existing_snapshot_not_a_prestart_input_or_modified')
outside=base/'outside';outside.mkdir();(outside/'external.py').write_text('external bytes',encoding='utf-8')
for label,logical,directory in [('source_file_link','models/link.py',False),('source_directory_link','models/linkdir',True),('ignored_directory_link','experiments/results/linkdir',True)]:
 linked=project(label);(linked/logical).symlink_to(outside if directory else outside/'external.py',target_is_directory=directory)
 try: scope(linked);raise AssertionError('accepted '+label)
 except ValueError as error: assert 'PLAN_SOURCE_LINK' in str(error),str(error)
 cases.append(label)
for label,target in [('source_link_loop','loop.py'),('source_broken_link','missing.py')]:
 linked=project(label);(linked/'models/loop.py').symlink_to(target)
 try: scope(linked);raise AssertionError('accepted '+label)
 except ValueError as error: assert 'PLAN_SOURCE_LINK' in str(error),str(error)
 cases.append(label)
root_link=project('source_root_link',omit=('models/core.py','models/__pycache__/stale.py','models/weights.bin'))
(root_link/'models').symlink_to(outside,target_is_directory=True)
try: scope(root_link);raise AssertionError('accepted source root link')
except ValueError as error: assert 'PLAN_SOURCE_LINK' in str(error),str(error)
cases.append('source_root_link_rejected')
for label,old,new in [
 ('extra_unknown_read_not_whitelisted','    files = _selected_files(_source_roots(cfg))','    unknown.read_bytes()\n    files = _selected_files(_source_roots(cfg))'),
 ('copy_verification_removed_not_whitelisted','            copied_digest.update(target.read_bytes())','            copied_digest.update(b"not copied bytes")'),
 ('reuse_validation_removed_not_whitelisted','        if complete.read_text(encoding="utf-8").strip() != digest.hexdigest():','        if False:'),
 ('output_redirect_not_whitelisted','            target = snapshot / source','            target = Path("outside") / source'),
 ('selector_changed_not_whitelisted','path.suffix in {".py", ".yaml"}','path.suffix in {".py", ".yaml", ".bin"}'),
 ('import_rebound_not_whitelisted','_IGNORED_DIRS = {"__pycache__", "_repos", ".runtime"}','_IGNORED_DIRS = {"__pycache__", "_repos", ".runtime"}\nPath = 42'),
 ('constructor_shadowed_not_whitelisted','_IGNORED_DIRS = {"__pycache__", "_repos", ".runtime"}','_IGNORED_DIRS = {"__pycache__", "_repos", ".runtime"}\ndef Path(value): return unknown'),
 ('builtin_sort_rebound_not_whitelisted','_IGNORED_DIRS = {"__pycache__", "_repos", ".runtime"}','_IGNORED_DIRS = {"__pycache__", "_repos", ".runtime"}\ndef sorted(values, **kwargs): return unknown'),
]:
 modified=project(label,{module:protocol.replace(old,new)})
 assert (modified/module).read_text(encoding='utf-8')!=protocol
 try: scope(modified);raise AssertionError('accepted '+label)
 except ValueError as error: assert 'SNAPSHOT_UNSUPPORTED' in str(error),str(error)
 cases.append(label)
# Unrelated declarations cannot prove an altered selector/output algorithm.
unsupported=project('unrelated-declarations',{module:protocol.replace('            target = snapshot / source','            target = Path("outside") / source'),plan:files[plan]+'source_dependencies:\n  inputs: [models/core.py]\n  integrity: [models/core.py]\n'})
try: scope(unsupported);raise AssertionError('unrelated declarations authorised snapshot')
except ValueError as error: assert 'SNAPSHOT_UNSUPPORTED' in str(error),str(error)
cases.append('unrelated_declarations_cannot_authorise_unknown_snapshot')
unused=project('unused-snapshot',{'train.py':'import experiments.simple_adapter.code_snapshot\n'})
(unused/'models/link.py').symlink_to(outside/'external.py')
assert set(scope(unused)[0])=={plan,'train.py',module}
cases.append('unused_snapshot_import_does_not_scan_roots')
renamed=protocol.replace('_source_roots','snapshot_roots').replace('_selected_files','snapshot_files').replace('_plan_root','snapshot_base').replace('backup_code','capture_sources').replace('_COMMON_DIRS','SOURCE_DIRS').replace('_COMMON_FILES','SOURCE_FILES').replace('_IGNORED_DIRS','IGNORED_PARTS')
renamed=re.sub(r'\bPath\b','FilePath',renamed).replace('from pathlib import FilePath','from pathlib import Path as FilePath')
alternate=project('renamed',{module:renamed,'train.py':'from experiments.simple_adapter.code_snapshot import capture_sources\ncapture_sources(runtime_output, cfg)\n'})
assert set(scope(alternate)[0])==expected
cases.append('function_global_and_Path_aliases_are_not_filename_special_cases')
relocated=project('relocated-module',{'support/snapshots.py':renamed,'train.py':'from support.snapshots import capture_sources\ncapture_sources(runtime_output, cfg)\n'},omit=(module,))
assert set(scope(relocated)[0])==(expected-{module})|{'support/snapshots.py'}
cases.append('snapshot_module_location_not_special_cased')
# Proven collection types and values, not return annotations or receiver names.
for label,code,allowed in [
 ('literal_Path_collection',"from pathlib import Path as P\nfor path in sorted(set([P('models/core.py')])):\n    path.read_bytes()\n",True),
 ('collection_item_overwritten',"from pathlib import Path\nfor path in [Path('models/core.py')]:\n    path=unknown\n    path.read_bytes()\n",False),
 ('annotation_not_trusted',"from pathlib import Path\ndef sources()->list[Path]: return dynamic_values\nfor path in sources():\n    path.read_bytes()\n",False),
 ('generic_copy_source_verified',"import shutil\nshutil.copy2('models/core.py', runtime_output)\n",True),
]:
 value=project(label,{'train.py':code})
 try:
  actual,_=scope(value);assert allowed,(label,actual);assert 'models/core.py' in actual
 except ValueError as error: assert not allowed and 'UNDECLARED' in str(error),(label,str(error))
 cases.append(label)
print(json.dumps(dict(cases=cases,wholeBackupCovered=True,noProjectExecution=True,generatedOutputsNotPrestartInputs=True,integrityJsonNotExpanded=True)))
