import ast, builtins, json, os, pathlib, tempfile, threading, time, re
source = pathlib.Path(__file__).parents[2] / 'src/clusterAgentRuntime.legacy.ts'
text = source.read_text(encoding='utf-8').split('`', 1)[1].rsplit('`', 1)[0]
tree = ast.parse(re.sub(r'^\$\{[^\n]+\}\s*$', '', text, flags=re.M))
names = {'operation_journal_signature', 'operation_journal_index', 'read_operation_events'}
scope = dict(os=os, time=time, OPERATION_JOURNAL_CACHE={}, OPERATION_JOURNAL_CACHE_LOCK=threading.Lock(),
             path_for=lambda root, name: os.path.join(root, name), prune_operation_journal_cache=lambda *args: None,
             parse_event_line=lambda line: json.loads(line) if line.strip() else None,
             event_operation_keys=lambda event: [event['operationId']],
             operation_summary_from_events=lambda key, rows: {'operationId': key, 'eventCount': len(rows), 'updatedAt': rows[-1]['generatedAt']})
exec(compile(ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[]), str(source), 'exec'), scope)
root = tempfile.mkdtemp(prefix='se-operation-journal-')
file = pathlib.Path(root) / 'events.jsonl'
initial = ''.join(json.dumps({'operationId': 'old', 'generatedAt': str(index)}) + '\n' for index in range(2000))
file.write_text(initial, encoding='utf-8')
count = [0, 0]
class CountingFile:
    def __init__(self, target): self.target = target
    def __enter__(self): return self
    def __exit__(self, *args): self.target.close()
    def __getattr__(self, key): return getattr(self.target, key)
    def read(self, *args):
        data = self.target.read(*args); count[1] += len(data); return data
    def __iter__(self):
        for data in self.target: count[1] += len(data); yield data
def opened(*args, **kwargs):
    count[0] += 1
    return CountingFile(builtins.open(*args, **kwargs))
scope['open'] = opened
read = scope['read_operation_events']
assert len(read(root, 'old', 4000)) == 2000
baseline = count[1]
for index in range(5):
    with builtins.open(file, 'a', encoding='utf-8') as output: output.write(json.dumps({'operationId': 'new', 'generatedAt': str(index)}) + '\n')
    assert len(read(root, 'new')) == index + 1
assert count[1] - baseline < 4096, ('appends reread old journal', count)
with builtins.open(file, 'a', encoding='utf-8') as output: output.write('{"operationId":"partial",')
assert not read(root, 'partial')
with builtins.open(file, 'a', encoding='utf-8') as output: output.write('"generatedAt":"done"}\n')
assert len(read(root, 'partial')) == 1
replacement = pathlib.Path(root) / 'replacement.jsonl'
replacement.write_text('{"operationId":"rotated","generatedAt":"now"}\n', encoding='utf-8')
os.replace(replacement, file)
assert not read(root, 'new') and len(read(root, 'rotated')) == 1
print(json.dumps({'ok': True, 'appendBytes': count[1] - baseline, 'initialBytes': baseline}))
