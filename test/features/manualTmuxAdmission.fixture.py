"""A separate bounded real tmux case; reuse only fixture setup and extracted task functions."""
import pathlib
setup = pathlib.Path(__file__).with_name('tmuxTaskLifecycle.fixture.py').read_text(encoding='utf-8').split('\ntry:\n', 1)[0]
exec(compile(setup, 'lifecycle_fixture_setup', 'exec'))
try:
    # Only the actual Agent entry function is extracted. Task children use the CPU probe executor.
    started_at = time.monotonic()
    def phase(name):
        print(name, round(time.monotonic()-started_at, 3), file=sys.stderr, flush=True)
    entry = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'execute_worker_command')
    agent = dict(namespace)
    exec(compile(ast.Module(body=[entry], type_ignores=[]), 'agent_entry', 'exec'), agent)
    phase('entry_ready')
    messages = json.loads(sys.argv[2]) if len(sys.argv) > 2 else [job(4), dict(job(5),dispatchPolicy='manual',gpuId='0'), dict(job(6),dispatchPolicy='manual',gpuId='0')]
    script = program.read_text(encoding='utf-8').replace('return ([{"id":"0"},{"id":"1"}], "")',
        'return ([{"id":"0","memoryTotalMb":24576,"memoryUsedMb":0},{"id":"1","memoryTotalMb":24576,"memoryUsedMb":24576}], "")')
    program.write_text(script, encoding='utf-8')
    auto,manual_a,manual_b = messages
    # Keep manual probes alive until the automatic admission assertion; wall-clock sleeps race with tmux/WSL latency.
    release = pathlib.Path(root, 'release-manual-probes')
    probe_source = probe.read_text(encoding='utf-8')
    probe_source = probe_source.replace('time.sleep(1.2 if case=="slow" else 0.1)',
        'if command in ' + repr((manual_a['commandId'], manual_b['commandId'])) + ':\n'
        ' deadline=time.monotonic()+6\n'
        ' while not pathlib.Path(root,"release-manual-probes").exists() and time.monotonic()<deadline: time.sleep(.02)\n'
        ' if not pathlib.Path(root,"release-manual-probes").exists(): sys.exit(9)\n'
        'else: time.sleep(.1)')
    probe.write_text(probe_source, encoding='utf-8')
    install_fixture_budget_observer(2048)
    pathlib.Path(root, 'fixture-budget-calibrated').touch()
    calibration = dict(manual_a, commandId='calibration-0', runKey='calibration-0', experimentIndex=0,
        globalJobId=manual_a['workflowId']+':0', outputDir='work/calibration0', collectionResultCsv='tmp/result/calibration0.csv')
    namespace['task_queue_rpc'](root, 'worker', 'accept', calibration, ensure=True)
    wait_for(lambda: any(row['commandId'] == 'calibration-0' and row['dead'] and namespace['task_budget_read'](row).get('ready') for row in namespace['task_inventory'](root)))
    # An uncertain original request may not have reached this Scheduler at all.
    # Cancel its exact identity first: a late accept must remain fenced out.
    uncertain = job(3)
    namespace['task_stop'](root, {'targetCommandId': uncertain['commandId'], 'projectId': 'project'}, 'worker')
    observed = next(row['observation'] for row in namespace['task_query'](root, [uncertain])['tasks']
                    if row['observation']['commandId'] == uncertain['commandId'])
    assert observed['cancelled'] and not observed.get('tmux')
    try:
        namespace['task_queue_rpc'](root, 'worker', 'accept', uncertain, ensure=True)
        raise AssertionError('late original request must not launch after exact cancellation')
    except RuntimeError as exc:
        assert 'TASK_CANCELLED' in str(exc), str(exc)
    assert not any(row['commandId'] == uncertain['commandId'] for row in namespace['task_inventory'](root))
    for manual in (manual_a, manual_b):
        agent['execute_worker_command'](root,manual,'worker')
    phase('manuals_queued')
    started = lambda row: pathlib.Path(root, 'started-' + row['commandId'])
    wait_for(lambda: started(manual_a).exists() and started(manual_b).exists())
    phase('manuals_running')
    agent['execute_worker_command'](root,auto,'worker')
    phase('auto_queued')
    assert all(row['tmuxSession'] == 'my-tasks-gpu-0' for row in namespace['task_inventory'](root)
               if row['commandId'] in (manual_a['commandId'], manual_b['commandId'])), 'Host-selected prefix must reach real task windows'
    assert not started(auto).exists(), 'the two manual jobs fill the card quota'
    reports = [json.loads(started(row).read_text()) for row in (manual_a, manual_b)]
    assert all(row['gpu'] == '0' for row in reports) and abs(reports[0]['at'] - reports[1]['at']) < 0.8
    stopped = namespace['task_stop'](root, {'targetCommandId': manual_a['commandId'], 'projectId':'project'}, 'worker')
    assert stopped['status'] == 'completed'
    assert any(row['commandId'] == manual_b['commandId'] and not row['dead'] for row in namespace['task_inventory'](root)), 'closing one task must preserve its same-GPU neighbor'
    # The exact stop releases one real slot; no hardware or task-state file is rewritten.
    wait_for(lambda: started(auto).exists())
    phase('auto_running')
    assert next(row for row in namespace['task_inventory'](root) if row['commandId'] == auto['commandId'])['tmuxSession'] == 'my-tasks-gpu-0'
    assert any(not row['dead'] for row in namespace['task_inventory'](root) if row['commandId'] in (manual_a['commandId'], manual_b['commandId']))
    release.touch()
    wait_for(lambda: all(row['dead'] for row in namespace['task_inventory'](root)))
    print(json.dumps(dict(ok=True, realTmux=True, manualConcurrent=True, autoWithManual=True, exactStopIsolated=True, unknownRequestFenced=True)))
finally:
    # Fixture-owned server under this newly created private TMUX_TMPDIR only.
    close_fixture_tmux_windows(lambda args: subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=2), private_root=root)
