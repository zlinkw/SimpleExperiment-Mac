"""Read current consumer declarations without executing callbacks or creating outputs."""
import argparse
import json
import os
import pathlib
import sys
repo=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(repo/'test/_helpers'))
from extractRuntimeFunctions import extract_runtime_functions
root=pathlib.Path(sys.argv[1]).resolve()
scheduler=extract_runtime_functions(str(repo/'dist/runtime/cluster_scheduler.py'),['load_plan','build_jobs','result_path_preflight','render_command'])
os.chdir(root)
rows=[]
for plan_file in sorted(pathlib.Path('experiments/plans/quality_composition').rglob('*.yaml')):
 plan=scheduler.load_plan(plan_file)
 _,jobs=scheduler.build_jobs(plan)
 report=scheduler.result_path_preflight(root,jobs,execution_mode=plan.get('mode','train_test'))
 assert report['ok'], report
 assert all(row['projectValidationExecuted'] is False for row in report['rows'])
 for job in jobs:
  contract=job.config['runtime']['result_path_contract']
  assert contract['policy']=='declared'
  assert contract['declared_result_csv']==contract['execution_result_csv']==contract['collection_result_csv']
  assert 'attempts' not in str(job.output_dir).split('/')
  assert job.config['test']['results_csv']==job.config['runtime']['result_csv']==job.config['paper']['result_csv']
  command=scheduler.render_command(job.test_command,job,pathlib.Path(job.output_dir)/'job_config.yaml',argparse.Namespace(worker_id='fixture',gpu_ids='',mode='test',debug_mode=False,plan=str(plan_file)))
  assert '--result-csv' in ' '.join(command)
 rows.append({'plan':plan_file.as_posix(),'jobs':len(jobs),'declared':True,'scientificValidationExecuted':False})
assert rows
print(json.dumps(rows))
