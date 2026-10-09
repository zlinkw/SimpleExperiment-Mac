const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

test("tmux UI groups task windows under a physical GPU card", () => {
  const panel = readSource("src/ui/PanelHtml.ts");
  assert.match(panel, /tmuxGpuIdFromSession/);
  assert.match(panel, /workerLabel \+ " · GPU " \+ gpuId/);
  assert.match(panel, /data-tmux-task-target=/);
  assert.match(panel, /tmuxTaskWindowLabel\(win\)/);
  assert.match(panel, /caseName \+ " · " \+ seedText \+ " · " \+ tmuxTaskStatusLabel/);
  assert.match(panel, /failedCount/);
  assert.match(panel, /gpu-slot:/);
});

test("Agent tmux list associates a retained pane with case seed and physical GPU", () => {
  const runtime = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const script = String.raw`
import importlib.util, json, pathlib, tempfile, threading, types, urllib.request
from http.server import ThreadingHTTPServer
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(runtime)}))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
agent.start_worker_telemetry_sampler = lambda *a, **k: None
agent.start_gpu_log_tail_sampler = lambda *a, **k: None
agent.start_worker_hub_uplink = lambda *a, **k: None
agent.start_worker_local_command_processor = lambda *a, **k: None
agent.tmux_available = lambda: True
servers = []
class CapturedServer(ThreadingHTTPServer):
    def serve_forever(self):
        servers.append(self); threading.Thread(target=lambda: ThreadingHTTPServer.serve_forever(self), daemon=True).start()
agent.ThreadingHTTPServer = CapturedServer
def fake_run(args, **kwargs):
    if args[1] == "list-sessions": return types.SimpleNamespace(returncode=0, stdout="zlk-gpu-1|1|0|0\n", stderr="")
    if args[1] == "list-windows": return types.SimpleNamespace(returncode=0, stdout="0|run-123|1|1\n", stderr="")
    if args[1] == "list-panes": return types.SimpleNamespace(returncode=0, stdout="0|1|python|80|24|%7|task\n", stderr="")
    return types.SimpleNamespace(returncode=0, stdout="", stderr="")
agent.subprocess.run = fake_run
with tempfile.TemporaryDirectory() as root:
    agent.atomic_write(agent.path_for(root, "gpu_snapshot.json"), {"gpu": [{"index": 0}, {"index": 1}]})
    agent.atomic_write(agent.path_for(root, "worker_task_snapshot.json"), {"tasks": [{"commandId":"run-a","tmuxPane":"%7","gpuId":"1","case":"bus_p30","seed":43,"status":"failed","planFile":"plan.yaml"}]})
    agent.serve_http(types.SimpleNamespace(host="127.0.0.1", port=0, token="secret", mode="worker_telemetry", project_dir=root, worker_id="nwpu3"))
    local = servers[0]
    request = urllib.request.Request(f"http://127.0.0.1:{local.server_port}/api/tmux/list", headers={"X-Simple-Agent-Token":"secret"})
    result = json.load(urllib.request.urlopen(request, timeout=5))
    local.shutdown(); local.server_close()
assert result["workerId"] == "nwpu3", result
assert result["gpuIds"] == ["0", "1"], result
task = result["sessions"][0]["windows"][0]["task"]
assert task["case"] == "bus_p30" and task["seed"] == 43 and task["status"] == "failed", task
print("ok")
`;
  const result = spawnSync("python", ["-X", "utf8", "-c", script], { encoding: "utf8", cwd: path.join(__dirname, "../..") });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("tmux list forwards GPU inventory and task metadata", () => {
  const agent = readSource("src/clusterAgentRuntime.ts");
  const extension = readSource("src/extension.ts");
  const scheduler = readSource("src/clusterSchedulerRuntime.ts");
  assert.match(agent, /tasks_by_pane/);
  assert.match(agent, /"task": task_meta/);
  assert.match(agent, /"gpuIds": gpu_ids/);
  assert.match(extension, /gpuIds: result\?\.gpuIds \|\| \[\]/);
  assert.match(scheduler, /"case": str\(case_name or ""\)/);
  assert.match(scheduler, /"seed": seed/);
});
