"""Real isolated Scheduler windows with synthetic devices and CPU-only fixture tasks."""
import math, pathlib
setup = pathlib.Path(__file__).with_name('tmuxTaskLifecycle.fixture.py').read_text(encoding='utf-8').split('\ntry:\n', 1)[0]
exec(compile(setup, 'memory_budget_controller_setup', 'exec'))
try:
    install_fixture_budget_observer(4096)
    probe.write_text(probe.read_text(encoding='utf-8').replace('time.sleep(1.2 if case=="slow" else 0.1)',
        'deadline=time.monotonic()+7\nwhile not pathlib.Path(root,"release-"+command).exists() and time.monotonic()<deadline: time.sleep(.02)'), encoding='utf-8')
    policy = dict(gpuQuotaScheduling=1, gpuMemoryBudgetScheduling=1, gpuJobsPerCard=3, gpuMinFreeMemoryGb=2)
    for index in range(4):
        namespace['task_queue_rpc'](root, 'worker', 'accept', dict(job(index), case='slow', gpuId='0', options=policy), ensure=True)
    wait_for(lambda: any(row['phase'] == 'running' for row in namespace['task_inventory'](root)))
    rows = namespace['task_inventory'](root)
    assert sum(row['phase'] == 'running' for row in rows) == 1, rows
    scout = next(row for row in rows if row['phase'] == 'running')
    reservation = namespace['task_budget_read'](scout)
    assert reservation['probe'] and not reservation['ready']
    # Inject an observed-window result at the device boundary; no training or wall-clock benchmark.
    pathlib.Path(root, 'fixture-budget-calibrated').touch()
    wait_for(lambda: sum(row['phase'] == 'running' for row in namespace['task_inventory'](root)) == 3)
    rows = namespace['task_inventory'](root)
    pending = next(row for row in rows if row['phase'] == 'queued')
    assert sum(row['phase'] == 'queued' for row in rows) == 1, rows
    assert all(namespace['task_budget_read'](row).get('budgetMb', 0) > 0 for row in rows if row['phase'] == 'running')
    pathlib.Path(root, 'fixture-budget-oom').touch()
    namespace['task_queue_rpc'](root, 'worker', 'configure', dict(policy, gpuMaxConcurrentCards=0))
    assert next(row for row in namespace['task_inventory'](root) if row['commandId'] == pending['commandId'])['phase'] == 'queued'
    print(json.dumps(dict(controller=True, probeExclusive=True, sharedReservations=3)))
finally:
    close_fixture_tmux_windows(lambda args: subprocess.run(['tmux', *args], capture_output=True, text=True, timeout=2), private_root=root)
