"""Isolated tmux, synthetic cards, CPU probes; no research execution."""
import pathlib
setup = pathlib.Path(__file__).with_name('tmuxTaskLifecycle.fixture.py').read_text(encoding='utf-8').split('\ntry:\n', 1)[0]
exec(compile(setup, 'gpu_card_limit_setup', 'exec'))
try:
    probe.write_text(probe.read_text(encoding='utf-8').replace('time.sleep(1.2 if case=="slow" else 0.1)',
        'deadline=time.monotonic()+7\nwhile not pathlib.Path(root,"release-"+command).exists() and time.monotonic()<deadline: time.sleep(.02)'), encoding='utf-8')
    observer = '''
_fixture_admission = task_admission_gpu
def task_admission_gpu(row, gpus, occupied):
    chosen = _fixture_admission(row, gpus, occupied)
    if row.get("commandId") == "command-2":
        pathlib.Path(os.environ["TMUX_TMPDIR"], "last-limit").write_text(json.dumps({"cap": row["options"].get("gpuMaxConcurrentCards"), "occupied": occupied, "chosen": chosen}), encoding="utf-8")
    return chosen
'''
    program.write_text(program.read_text(encoding='utf-8').replace('if __name__=="__main__":', observer + '\nif __name__=="__main__":'), encoding='utf-8')
    settings = dict(gpuQuotaScheduling=1, gpuJobsPerCard=2, gpuMinFreeMemoryGb=22, gpuMaxConcurrentCards=1)
    for i in range(3):
        payload = dict(job(i), gpuId='1' if i == 0 else '0', options=settings)
        if i == 0:
            payload['dispatchPolicy'] = 'manual'
        namespace['task_queue_rpc'](root, 'worker', 'accept', payload, ensure=True)
    wait_for(lambda: sum(not row['dead'] and row['phase'] == 'running' for row in namespace['task_inventory'](root)) == 2)
    rows = namespace['task_inventory'](root)
    assert {row['gpuId'] for row in rows if row['phase'] == 'running'} == {'1'}
    assert next(row for row in rows if row['commandId'] == 'command-2')['phase'] == 'queued'
    identities = {row['commandId']: row['tmuxWindowId'] for row in rows}
    namespace['task_queue_rpc'](root, 'worker', 'configure', dict(settings, gpuMaxConcurrentCards=0))
    # A delayed duplicate carrying the former cap must not relax a current
    # explicitly saved limit or create another execution window.
    namespace['task_queue_rpc'](root, 'worker', 'accept', dict(job(2), gpuId='0', options=settings), ensure=True)
    for i in range(2):
        pathlib.Path(root, 'release-command-' + str(i)).touch()
    def paused_observed():
        observed = json.loads(pathlib.Path(root, 'last-limit').read_text(encoding='utf-8'))
        return observed['cap'] == 0 and not observed['occupied'] and observed['chosen'] is None
    wait_for(paused_observed)
    assert identities == {row['commandId']: row['tmuxWindowId'] for row in namespace['task_inventory'](root)}
    namespace['task_queue_rpc'](root, 'worker', 'configure', settings)
    wait_for(lambda: pathlib.Path(root, 'started-command-2').is_file())
    assert json.loads(pathlib.Path(root, 'started-command-2').read_text())['gpu'] == '0'
    pathlib.Path(root, 'release-command-2').touch()
    print(json.dumps(dict(ok=True, concurrentCards=1, jobsOnCard=2, pausedWithoutStopping=True)))
finally:
    close_fixture_tmux_windows(lambda args: subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=2), private_root=root)
