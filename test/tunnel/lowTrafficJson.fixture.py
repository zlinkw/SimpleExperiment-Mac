"""Exercise the real response writer only, never import the Agent main loop."""
import ast
import gzip
import io
import json
from pathlib import Path
import textwrap

source = (Path(__file__).resolve().parents[2] / 'src/clusterAgentRuntime.legacy.ts').read_text(encoding='utf-8')
start = source.index('        def send_json(self, payload, status=200):')
end = source.index('\n        def ', start + 1)
namespace = dict(json=json)
exec(compile(ast.parse(textwrap.dedent(source[start:end])), 'actual-json-writer', 'exec'), namespace)

class Response:
    def __init__(self, headers):
        self.headers = headers
        self.sent = {}
        self.wfile = io.BytesIO()
    def send_response(self, status):
        self.status = status
    def send_header(self, key, value):
        self.sent[key] = value
    def end_headers(self):
        pass

payload = dict(tasks=[dict(commandId=f'command-{i}', projectId='project', workerId='worker', outputDir=f'work_dirs/case/seed{i}',
                           observation=dict(lifecycleProtocol=2, tmux=dict(dead=False, phase='running'))) for i in range(72)])
normal = Response({'Accept-Encoding': 'gzip'})
namespace['send_json'](normal, payload)
raw = normal.wfile.getvalue()
assert 'Content-Encoding' not in normal.sent
compact = Response({'Accept-Encoding': 'gzip, deflate', 'X-Simple-Low-Traffic': '1'})
namespace['send_json'](compact, payload, status=409)
wire = compact.wfile.getvalue()
assert compact.sent.get('Content-Encoding') == 'gzip'
assert compact.status == 409 and gzip.decompress(wire) == raw
assert int(compact.sent['Content-Length']) == len(wire) and len(wire) < len(raw)
refused = Response({'Accept-Encoding': 'gzip;q=0, identity', 'X-Simple-Low-Traffic': '1'})
namespace['send_json'](refused, payload)
assert refused.wfile.getvalue() == raw and 'Content-Encoding' not in refused.sent
print(json.dumps(dict(normalBytes=len(raw), wireBytes=len(wire), jobs=72)))
