import { INCREMENTAL_SCOPE_METADATA_PYTHON } from "./IncrementalScopeMetadata";
/** Requested metadata generations share a durable baseline, never authoritative artifact evidence. */
export const SYNC_SCOPE_INDEX_PYTHON = String.raw`
${INCREMENTAL_SCOPE_METADATA_PYTHON}
def sync_scope_path_allowed(relative, directory=False):
    parts = relative.lower().split('/')
    blocked = {'.git', '.vscode', '.codex', '.agents', '.coding-tools', '.local-gpt', '.runtime', 'clean_dir', 'zlk_cluster', '.venv', 'venv', 'env', 'node_modules', '__pycache__', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox'}
    if any(part in blocked or part.startswith('.simple-sftp-stage-') or '.simple-sftp-partial-' in part for part in parts):
        return False
    if parts[0] == 'tmp' and len(parts) > 1 and parts[1] != 'result':
        return False
    if parts[-1].startswith('.env') or parts[-1] in ('plan_sync_ledger.json', 'project_mirror_state.json'):
        return False
    if parts[:2] == ['experiments', 'results'] and parts[-1].endswith('.csv.lock') or parts[0] == 'work_dirs' and parts[-1] == '.tb_mean.lock':
        return False
    if parts[0] != 'simple_cluster' or len(parts) < 2:
        return True
    if parts[1] in ('results', 'debug_runs'):
        return True
    if parts[1] != 'tmp':
        return False
    return len(parts) == 2 and directory or len(parts) > 2 and (parts[2] == 'tmux_logs' or parts[2] == 'cluster_scheduler' and (len(parts) == 3 and directory or len(parts) > 3 and parts[3] == 'logs' or len(parts) == 4 and parts[-1].endswith('.log')))

def scan_sync_scope_metadata(project, progress, cancelled):
    root = os.path.realpath(project)
    root_info = os.lstat(root)
    if not stat.S_ISDIR(root_info.st_mode) or os.path.islink(project):
        raise ValueError('SCOPE_INDEX_ROOT_UNAVAILABLE')
    entries = {}; pending = [('.', root)]; inspected = 0; directories = []
    while pending:
        if cancelled():
            raise ValueError('SCOPE_INDEX_CANCELLED')
        relative, full = pending.pop()
        before = os.lstat(full)
        if not stat.S_ISDIR(before.st_mode) or before.st_dev != root_info.st_dev or os.path.realpath(full) != full:
            raise ValueError('SCOPE_INDEX_UNSAFE_DIRECTORY')
        directories.append((full, before))
        if len(directories) > 10000:
            raise ValueError('SCOPE_INDEX_DIRECTORY_LIMIT')
        entries[relative] = {'p': relative, 'd': True, 'm': before.st_mtime_ns // 1000000, 'c': before.st_ctime_ns // 1000000, 'v': str(before.st_dev), 'i': str(before.st_ino), 'n': 0, 'b': 0}
        with os.scandir(full) as children:
            for child in children:
                if cancelled():
                    raise ValueError('SCOPE_INDEX_CANCELLED')
                inspected += 1
                if inspected > 100000 or len(entries) > 60000:
                    raise ValueError('SCOPE_INDEX_ENTRY_LIMIT')
                name = child.name
                if name in ('', '.', '..') or '/' in name or chr(92) in name:
                    raise ValueError('SCOPE_INDEX_UNSAFE_NAME')
                path = name if relative == '.' else relative + '/' + name
                if child.is_symlink():
                    continue
                directory = child.is_dir(follow_symlinks=False)
                if not sync_scope_path_allowed(path, directory):
                    continue
                info = os.lstat(child.path)
                if info.st_dev != root_info.st_dev:
                    raise ValueError('SCOPE_INDEX_MOUNT_BOUNDARY')
                if directory:
                    pending.append((path, child.path))
                elif stat.S_ISREG(info.st_mode):
                    entries[path] = {'p': path, 'd': False, 's': info.st_size, 'm': info.st_mtime_ns // 1000000, 'c': info.st_ctime_ns // 1000000, 'v': str(info.st_dev), 'i': str(info.st_ino)}
                else:
                    raise ValueError('SCOPE_INDEX_UNSUPPORTED_TYPE')
                if inspected % 128 == 0:
                    progress(inspected)
    # Directory identities catch additions, removals and renames during traversal.
    for full, before in directories:
        after = os.lstat(full)
        if stat.S_ISLNK(after.st_mode) or (before.st_dev, before.st_ino, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_mtime_ns):
            raise ValueError('SCOPE_INDEX_DIRECTORY_CHANGED')
    for relative, row in list(entries.items()):
        if row['d']:
            continue
        parent = relative.rsplit('/', 1)[0] if '/' in relative else '.'
        while True:
            entries[parent]['n'] += 1; entries[parent]['b'] += row['s']
            if parent == '.':
                break
            parent = parent.rsplit('/', 1)[0] if '/' in parent else '.'
    progress(inspected)
    return entries

class SyncScopeIndex:
    def __init__(self, project, scanner=None, clock=None):
        self.configured_project = os.path.abspath(project)
        self.project = os.path.realpath(project)
        cache = os.path.join(agent_dir(project), 'scope-metadata.sqlite3') if 'agent_dir' in globals() else None
        self.scanner = scanner or IncrementalScopeMetadata(self.project, cache)
        self.clock = clock or time.monotonic
        self.instance = uuid.uuid4().hex
        self.lock = threading.Lock()
        self.sessions = {}; self.snapshots = {}; self.generation = 0
        self.running = False

    def query(self, payload):
        if not isinstance(payload, dict) or payload.get('feature') != 'project-sync-scope':
            raise ValueError('SCOPE_INDEX_VIEW_REQUIRED')
        requested_root = payload.get('projectRoot')
        if not isinstance(requested_root, str) or os.path.normpath(requested_root) not in (self.project, self.configured_project):
            raise ValueError('SCOPE_INDEX_PROJECT_MISMATCH')
        view = str(payload.get('viewId') or '')
        request = str(payload.get('requestId') or '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', view) or not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', request):
            raise ValueError('SCOPE_INDEX_IDENTITY_INVALID')
        operation = payload.get('op')
        if operation not in ('refresh', 'read', 'release'):
            raise ValueError('SCOPE_INDEX_OPERATION_INVALID')
        if payload.get('afterGeneration') is not None and (type(payload['afterGeneration']) is not int or payload['afterGeneration'] < 0):
            raise ValueError('SCOPE_INDEX_GENERATION_INVALID')
        with self.lock:
            now = self.clock()
            for key, old in list(self.sessions.items()):
                if now - old['touched'] > 120:
                    self.sessions.pop(key, None)
            if operation == 'release':
                released = bool(self.sessions.get(view) and self.sessions[view]['requestId'] == request)
                if released:
                    self.sessions.pop(view, None)
                return {'ok': True, 'released': released, 'instanceId': self.instance, 'projectRoot': self.project, 'requestedProjectRoot': requested_root}
            current = self.sessions.get(view)
            if operation == 'refresh' and (not current or current['requestId'] != request):
                if not current and len(self.sessions) >= 8:
                    raise ValueError('SCOPE_INDEX_VIEW_LIMIT')
                current = {'requestId': request, 'touched': now, 'status': 'queued', 'processed': 0,
                           'base': payload.get('afterGeneration') if payload.get('instanceId') == self.instance else None}
                self.sessions[view] = current
                if not self.running:
                    self.running = True
                    try:
                        threading.Thread(target=self._run, daemon=True).start()
                    except Exception as exc:
                        self.running = False
                        current.update({'status': 'unknown', 'error': str(exc)[:1000]})
            if not current or current['requestId'] != request:
                raise ValueError('SCOPE_INDEX_REQUEST_SUPERSEDED')
            current['touched'] = now
            result = {'ok': current['status'] != 'unknown', 'instanceId': self.instance, 'requestId': request,
                      'projectRoot': self.project, 'requestedProjectRoot': requested_root,
                      'status': current['status'], 'processedEntries': current['processed']}
            if current['status'] == 'unknown':
                result['error'] = current.get('error', 'SCOPE_INDEX_QUERY_FAILED')
            if current['status'] == 'ready':
                cursor = payload.get('cursor', 0)
                if type(cursor) is not int or cursor < 0 or cursor > len(current['changes']):
                    raise ValueError('SCOPE_INDEX_CURSOR_INVALID')
                batch = []; batch_bytes = 0
                for entry in current['changes'][cursor:cursor + 512]:
                    size = len(json.dumps(entry, separators=(',', ':')).encode('utf-8'))
                    if batch and batch_bytes + size > 128 * 1024:
                        break
                    batch.append(entry); batch_bytes += size
                result.update({'generation': current['generation'], 'reset': current['reset'],
                               'acceleration': current.get('acceleration', {}),
                               'observedAt': current['observedAt'], 'entries': batch,
                               'nextCursor': cursor + len(batch) if cursor + len(batch) < len(current['changes']) else None})
            return result

    def _run(self):
        while True:
            with self.lock:
                job = next(((view, row) for view, row in self.sessions.items() if row['status'] == 'queued'), None)
                if job is None:
                    self.running = False
                    return
                view, row = job; row['status'] = 'scanning'
                base = self.snapshots.get(row['base'])
            def cancelled():
                with self.lock:
                    return self.sessions.get(view) is not row or self.clock() - row['touched'] > 120
            def progress(count):
                with self.lock:
                    row['processed'] = count
            try:
                # Retry only a read raced by changes; a failed retry remains unknown.
                for attempt in range(3):
                    try:
                        entries = self.scanner(self.project, progress, cancelled)
                        break
                    except ValueError as exc:
                        if attempt == 2 or str(exc) not in ('SCOPE_INDEX_CHANGED_DURING_REFRESH', 'SCOPE_INDEX_DIRECTORY_CHANGED'): raise
                changes = [entry for path, entry in entries.items() if base is None or base.get(path) != entry]
                if base is not None:
                    changes.extend({'p': path, 'x': True} for path in base if path not in entries)
                with self.lock:
                    if self.sessions.get(view) is not row:
                        continue
                    self.generation += 1
                    self.snapshots[self.generation] = entries
                    self.snapshots = {key: value for key, value in self.snapshots.items() if key >= self.generation - 1}
                    row.update({'status': 'ready', 'generation': self.generation, 'reset': base is None,
                                'acceleration': getattr(self.scanner, 'metrics', {}),
                                'changes': changes, 'observedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
            except Exception as exc:
                if isinstance(self.scanner, IncrementalScopeMetadata): self.scanner.gap = True
                with self.lock:
                    row.update({'status': 'unknown', 'error': str(exc)[:1000]})
`;
