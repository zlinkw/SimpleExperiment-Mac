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

test("Agent tmux list binds a retained pane to current Worker, case, seed, physical GPU and immutable window", () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B','-X','utf8',path.join(__dirname,'tmuxGpuTaskGrouping.fixture.py'),path.resolve(__dirname,'../../dist/runtime/cluster_agent.py')],
    {encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  assert.equal(JSON.parse(result.stdout.trim()).ok,true);
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
