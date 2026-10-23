"""Private tmux with an older server environment and the current Agent prefix."""
import pathlib
setup = pathlib.Path(__file__).with_name('tmuxTaskLifecycle.fixture.py').read_text(encoding='utf-8').split('\ntry:\n', 1)[0]
exec(compile(setup, 'scheduler_prefix_setup', 'exec'))
try:
    os.environ['SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX'] = 'stale-owner'
    namespace['task_tmux'](['new-session', '-d', '-s', 'unrelated-user', 'sleep 20'])
    os.environ['SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX'] = 'configured-owner'
    namespace['task_queue_rpc'](root, 'worker', 'accept', job(0), ensure=True)
    wait_for(lambda: pathlib.Path(root, 'started-command-0').is_file())
    rows = namespace['task_inventory'](root)
    assert len(rows) == 1 and rows[0]['commandId'] == 'command-0', rows
    sessions = namespace['task_tmux'](['list-sessions', '-F', '#{session_name}']).splitlines()
    assert all(name == 'unrelated-user' or name.startswith('configured-owner-') for name in sessions), sessions
    assert namespace['task_tmux'](['has-session', '-t', '=unrelated-user']) == ''
    print(json.dumps(dict(ok=True, configuredPrefix=True, unchangedOtherUser=True)))
finally:
    close_fixture_tmux_windows(lambda args: subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=2), private_root=root)
