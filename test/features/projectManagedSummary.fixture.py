"""Extract the production collection function; no runtime entry point or research data."""
import json
import os
import pathlib
import sys
import tempfile
repo = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / 'test/_helpers'))
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(str(repo / 'dist/runtime/cluster_agent.py'), ['parse_results_action'])
# Mac 适配：posix-v1 严格链路以 read_project_metric_policy(root, strict_paths=True, snapshots=...) 读取策略、
# 并要求 Plan/来源 CSV 为真实项目文件；桩全部保持原返回值（业务断言强度不变），
# 仅在唯一的临时目录里搭最小真实项目，且桩签名容忍严格链路的关键字参数。
root = tempfile.mkdtemp(prefix='se-project-managed-')
# 结果候选须符合现行资格契约（experiments/results 前缀；tmp/ 不在 RESULT_TOP_DIRS），桩不读内容，仅走真实严格校验。
pathlib.Path(root, 'experiments/plans').mkdir(parents=True)
pathlib.Path(root, 'experiments/results').mkdir(parents=True)
pathlib.Path(root, 'experiments/plans/owned.yaml').write_text(
    "suite: owned\nseeds: [1]\ncases:\n  - case: alpha\nresult_csv: experiments/results/owned.csv\n", encoding='utf-8')
pathlib.Path(root, 'experiments/results/owned.csv').write_text(
    'case,seed,method,custom_project_metric\nalpha,1,demo,0.7\n', encoding='utf-8')
agent.read_project_metric_policy = lambda root, strict_paths=False, snapshots=None: {}
agent.selected_result_candidates = lambda *_: ['experiments/results/owned.csv']
agent.structured_result_candidate = lambda _: True
agent.normalize_result_candidate = lambda value: value
agent.plan_suite_value = lambda *_: 'owned'
agent.parse_result_file = lambda *_, **__: [{'metrics': {'custom_project_metric': 0.7}}]
agent.ordered_metric_list = lambda values, _: list(values)
agent.apply_result_ownership = lambda summary, _: summary
agent.apply_final_evidence_summary = lambda _, summary, **__: summary
agent.write_plan_seed_aggregate = lambda *_: None
agent.write_results_summary_v2 = lambda *_: 'summary.csv'
agent.relpath = lambda _, value: value
agent.append_event = lambda *_: None
def forbidden(*_):
    raise AssertionError('automatic scientific claim evaluation')
agent.evaluate_claim_evidence = forbidden
agent.apply_claim_evidence_summary = forbidden
summary = agent.parse_results_action(root, selected=['experiments/results/owned.csv'], plan='experiments/plans/owned.yaml')
assert summary['results'][0]['metrics'] == {'custom_project_metric': 0.7}
assert summary['projectScientificValidation'] == {'executed': False, 'responsibility': 'project'}
assert 'claimEvidence' not in summary
print(json.dumps({'ok': True, 'scientificCalls': 0, 'metric': summary['metrics']}))
