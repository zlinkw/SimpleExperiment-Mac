/** Standalone metadata accelerator. The authoritative PLAN/artifact readers never consume this cache. */
export const INCREMENTAL_SCOPE_METADATA_PYTHON = String.raw`
class IncrementalScopeMetadata:
    def __init__(self, project, cache_file=None):
        self.project = os.path.realpath(project)
        self.cache_file = cache_file
        self.entries = {}; self.loaded = False; self.fd = -1; self.watches = {}; self.by_path = {}
        self.libc = None; self.gap = True; self.last_reconcile = 0; self.metrics = {}
        self.cache_accepted = False
        # inotify on remote/distributed filesystems is not evidence of all mutations.
        self.native = False
        try:
            import ctypes
            mount = ('', '')
            with open('/proc/self/mountinfo', encoding='utf-8') as stream:
                for line in stream:
                    left, right = line.rstrip().split(' - ', 1)
                    target = left.split()[4].replace(r'\040', ' ')
                    if (self.project == target or self.project.startswith(target.rstrip('/') + '/')) and len(target) > len(mount[0]):
                        mount = (target, right.split()[0])
            self.native = mount[1] in ('ext4', 'ext3', 'xfs', 'btrfs', 'tmpfs', 'overlay', 'zfs')
            if self.native:
                self.libc = ctypes.CDLL(None, use_errno=True)
                self.fd = self.libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
                if self.fd < 0: self.native = False
        except Exception:
            self.native = False

    def _watch(self, full):
        if not self.native or full in self.by_path: return
        import ctypes
        wd = self.libc.inotify_add_watch(self.fd, ctypes.c_char_p(os.fsencode(full)), 0x01000FCE | 0x02000000 | 0x04000000)
        if wd < 0:
            self.gap = True; self.native = False
            return
        self.watches[wd] = full; self.by_path[full] = wd

    def _drain(self):
        import struct
        dirty = set()
        if not self.native: return dirty
        while True:
            try: data = os.read(self.fd, 1024 * 1024)
            except BlockingIOError: break
            except OSError: self.native = False; self.gap = True; break
            if not data: self.native = False; self.gap = True; break
            offset = 0
            while offset + 16 <= len(data):
                wd, mask, cookie, size = struct.unpack_from('iIII', data, offset)
                name = os.fsdecode(data[offset + 16:offset + 16 + size].split(b'\0', 1)[0]); offset += 16 + size
                if offset > len(data): self.gap = True; break
                if mask & 0x4000 or wd not in self.watches: self.gap = True
                else:
                    full = self.watches[wd]
                    relative = os.path.relpath(full, self.project).replace(os.sep, '/')
                    child = name if relative == '.' else relative + '/' + name
                    if name and not sync_scope_path_allowed(child, bool(mask & 0x40000000)): continue
                    dirty.add(relative)
                    if mask & (0x8000 | 0x400 | 0x800):
                        self.gap = True; self.by_path.pop(full, None); self.watches.pop(wd, None)
        return dirty

    def _load(self, identity):
        self.loaded = True
        if not self.cache_file: return
        try:
            import sqlite3
            if not os.path.isfile(self.cache_file) or os.path.islink(self.cache_file) or os.path.getsize(self.cache_file) > 64 * 1024 * 1024: return
            with sqlite3.connect('file:' + self.cache_file + '?mode=ro', uri=True, timeout=1) as db:
                meta = db.execute('SELECT identity FROM scope_meta WHERE id=1').fetchone()
                if not meta or json.loads(meta[0]) != identity: return
                rows = db.execute('SELECT path, fact FROM scope_entries LIMIT 60001').fetchall()
            if len(rows) > 60000: return
            values = {}
            for name, text in rows:
                row = json.loads(text)
                if not isinstance(name, str) or name != '.' and (name.startswith('/') or chr(92) in name or any(p in ('', '.', '..') for p in name.split('/'))): return
                if row.get('p') != name or type(row.get('d')) is not bool or not all(type(row.get(k)) is int for k in ('m', 't', 'u')): return
                if not row['d'] and (type(row.get('s')) is not int or row['s'] < 0): return
                values[name] = row
            if not values.get('.', {}).get('d'): return
            for name, row in values.items():
                if name != '.' and (not values.get(name.rsplit('/', 1)[0] if '/' in name else '.', {}).get('d') or not sync_scope_path_allowed(name, row['d'])): return
            self.entries = values
            self.cache_accepted = True
        except Exception:
            self.entries = {}

    def _save(self, identity, entries, changes, removed):
        if not self.cache_file: return
        try:
            import sqlite3
            parent = os.path.dirname(self.cache_file)
            os.makedirs(parent, mode=0o700, exist_ok=True)
            if os.path.realpath(parent) != os.path.abspath(parent): return
            for name in (self.cache_file, self.cache_file + '-wal', self.cache_file + '-shm'):
                if os.path.lexists(name):
                    s = os.lstat(name)
                    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1: return
            with sqlite3.connect(self.cache_file, timeout=1) as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE IF NOT EXISTS scope_meta (id INTEGER PRIMARY KEY, identity TEXT)')
                db.execute('CREATE TABLE IF NOT EXISTS scope_entries (path TEXT PRIMARY KEY, fact TEXT NOT NULL)')
                old = db.execute('SELECT identity FROM scope_meta WHERE id=1').fetchone()
                if not self.cache_accepted or not old or json.loads(old[0]) != identity:
                    db.execute('DELETE FROM scope_entries'); changes = list(entries.values()); removed = []
                db.executemany('INSERT OR REPLACE INTO scope_entries VALUES (?,?)', [(row['p'], json.dumps(row, separators=(',', ':'))) for row in changes])
                db.executemany('DELETE FROM scope_entries WHERE path=?', [(name,) for name in removed])
                db.execute('INSERT OR REPLACE INTO scope_meta VALUES (1,?)', (json.dumps(identity),))
            self.cache_accepted = True
        except Exception:
            self.metrics['persistence'] = 'unavailable-live-result-only'

    def __call__(self, project, progress, cancelled):
        root = os.path.realpath(project); root_stat = os.lstat(project)
        if root != self.project or os.path.islink(project) or not stat.S_ISDIR(root_stat.st_mode): raise ValueError('SCOPE_INDEX_ROOT_UNAVAILABLE')
        identity = {'root': root, 'dev': str(root_stat.st_dev), 'ino': str(root_stat.st_ino), 'schema': 1}
        restored = not self.loaded
        if not self.loaded: self._load(identity)
        before = self.entries
        dirty = self._drain()
        reconcile = not self.native or self.gap or time.monotonic() - self.last_reconcile > 30
        self.gap = False
        entries = dict(before); inspected = 0; enumerated = 0; listed = 0; validated = {}; visited = set(); pending = ['.']
        children = {}
        for name in before:
            if name != '.': children.setdefault(name.rsplit('/', 1)[0] if '/' in name else '.', []).append(name)
        def info(name):
            nonlocal inspected
            if cancelled(): raise ValueError('SCOPE_INDEX_CANCELLED')
            inspected += 1
            if inspected % 128 == 0: progress(inspected)
            try: value = os.lstat(root if name == '.' else os.path.join(root, name))
            except FileNotFoundError:
                if name == '.': raise
                return None
            if stat.S_ISLNK(value.st_mode) or value.st_dev != root_stat.st_dev or not (stat.S_ISREG(value.st_mode) or stat.S_ISDIR(value.st_mode)):
                raise ValueError('SCOPE_INDEX_UNSAFE_ENTRY: ' + name)
            row = {'p': name, 'd': stat.S_ISDIR(value.st_mode), 'm': value.st_mtime_ns // 1000000, 'c': value.st_ctime_ns // 1000000,
                   'v': str(value.st_dev), 'i': str(value.st_ino), 't': value.st_mtime_ns, 'u': value.st_ctime_ns}
            if not row['d']: row['s'] = value.st_size
            return row
        def remove(name):
            for key in list(entries):
                if key == name or key.startswith(name + '/'): entries.pop(key, None)
        def stable(row): return {k:v for k,v in row.items() if k not in ('n','b')}
        while pending:
            name = pending.pop()
            if name in visited: continue
            visited.add(name)
            if len(visited) > 10000: raise ValueError('SCOPE_INDEX_DIRECTORY_LIMIT')
            row = info(name)
            if row is None: remove(name); continue
            old = before.get(name)
            if not row['d']: remove(name); entries[name] = row; continue
            full = root if name == '.' else os.path.join(root, *name.split('/'))
            if os.path.realpath(full) != full: raise ValueError('SCOPE_INDEX_UNSAFE_DIRECTORY')
            self._watch(full); validated[name] = row; entries[name] = row
            if old is None or stable(old) != row or name in dirty:
                enumerated += 1; found = set()
                with os.scandir(full) as stream:
                    count = 0
                    for child in stream:
                        count += 1; listed += 1
                        if listed > 100000: raise ValueError('SCOPE_INDEX_ENTRY_LIMIT')
                        if child.name in ('', '.', '..') or '/' in child.name or chr(92) in child.name: raise ValueError('SCOPE_INDEX_UNSAFE_NAME')
                        child_name = child.name if name == '.' else name + '/' + child.name
                        if not sync_scope_path_allowed(child_name, child.is_dir(follow_symlinks=False)): continue
                        value = info(child_name)
                        if value is None: raise ValueError('SCOPE_INDEX_DIRECTORY_CHANGED')
                        found.add(child_name)
                        if entries.get(child_name, {}).get('d') and not value['d']: remove(child_name)
                        entries[child_name] = value
                        if value['d']: pending.append(child_name)
                for child in children.get(name, []):
                    if child not in found: remove(child)
            else:
                for child in children.get(name, []):
                    if before[child]['d']: pending.append(child)
                    elif reconcile:
                        value = info(child)
                        if value is None: entries.pop(child, None)
                        elif value['d']: pending.append(child)
                        else: entries[child] = value
        for name, row in validated.items():
            if info(name) != row: raise ValueError('SCOPE_INDEX_DIRECTORY_CHANGED')
        # Consume all events generated during traversal. Never label a raced snapshot complete.
        if self._drain() or self.gap:
            self.gap = True
            raise ValueError('SCOPE_INDEX_CHANGED_DURING_REFRESH')
        if len(entries) > 60000: raise ValueError('SCOPE_INDEX_ENTRY_LIMIT')
        # Linear bottom-up aggregation, not one ancestor walk for every file.
        for row in entries.values():
            if row['d']: row['n'] = 0; row['b'] = 0
        for name in sorted(entries, key=lambda n: (n.count('/'), len(n)), reverse=True):
            if name == '.': continue
            row = entries[name]; parent = name.rsplit('/', 1)[0] if '/' in name else '.'
            if parent not in entries or not entries[parent]['d']: raise ValueError('SCOPE_INDEX_PARENT_MISSING')
            entries[parent]['n'] += row.get('n', 0) if row['d'] else 1
            entries[parent]['b'] += row.get('b', 0) if row['d'] else row['s']
        changes = [row for name,row in entries.items() if before.get(name) != row]
        removed = [name for name in before if name not in entries]
        self.metrics = {'mode': 'native-directory-deltas' if self.native and not reconcile else 'live-stat-reconciliation',
                        'restored': restored and bool(before), 'statCalls': inspected, 'enumeratedDirectories': enumerated, 'changedEntries': len(changes) + len(removed)}
        self._save(identity, entries, changes, removed)
        self.entries = entries
        if reconcile: self.last_reconcile = time.monotonic()
        progress(inspected)
        return entries
`;
