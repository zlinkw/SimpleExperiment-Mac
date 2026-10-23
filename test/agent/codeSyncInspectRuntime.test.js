const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const runtime = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
const root = path.join(__dirname, "../..");

test("remote code sync inspection reports modified and untracked paths before upload", () => {
  const script = `
import importlib.util, pathlib, types
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(runtime)}), ["code_sync_inspect", "subprocess"])
calls = []
def fake_run(args, **kwargs):
    calls.append(args)
    return types.SimpleNamespace(returncode=0, stdout=' M package.json\\n?? data/datasets/fixed_protocol_manifest.py\\n', stderr='')
agent.subprocess.run = fake_run
root = ${JSON.stringify(root)}
result = agent.code_sync_inspect(root, ['package.json', 'data/datasets/fixed_protocol_manifest.py'])
assert result['ok'] is True, result
assert result['files'][0]['status'] == ' M', result
assert result['files'][0]['sha256'], result
assert result['files'][1]['status'] == '??', result
assert calls[0][:4] == ['git', '-C', str(pathlib.Path(root).resolve()), 'status'], calls
assert agent.code_sync_inspect(root, ['../outside.py'])['ok'] is False
print('ok')
`;
  const result = spawnSync("python", ["-X", "utf8", "-B", (() => { const f = require("node:fs"), p = require("node:path"); const d = f.mkdtempSync(p.join(require("node:os").tmpdir(), "se-python-fixture-")); const file = p.join(d, "probe.py"); f.writeFileSync(file, script, "utf8"); console.log("kept Python fixture at " + d); return file; })()], { encoding: "utf8", cwd: root, timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
