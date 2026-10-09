const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extension = readSource("src/extension.ts");
const panel = readSource("src/ui/PanelHtml.ts");
const agentSource = readSource("src/clusterAgentRuntime.ts");

test("public setup defaults to system Python without changing explicit Conda environments", () => {
  const setup = require(path.join(root, "dist/tunnel/XshellTunnelSetup.js"));
  const policy = require(path.join(root, "dist/tunnel/AgentTmuxPolicy.js"));

  assert.equal(packageJson.contributes.configuration.properties["simpleExperiment.tunnel.condaEnv"].default, "");
  assert.equal(packageJson.contributes.configuration.properties["simpleExperiment.tunnel.remoteTmuxSessionPrefix"].default, "simple");
  assert.deepEqual(packageJson.contributes.configuration.properties["simpleExperiment.remote.allowedRoots"].default, []);
  assert.deepEqual(packageJson.contributes.configuration.properties["simpleExperiment.remote.deniedRoots"].default, []);
  assert.equal(setup.defaultXshellTunnelSetupConfig.condaEnv, "");
  assert.equal(setup.normalizeXshellSetupConfig({ condaEnv: "" }).condaEnv, "");
  assert.equal(setup.normalizeXshellSetupConfig({ condaEnv: " torch2 " }).condaEnv, "torch2");
  assert.equal(setup.workerTunnelToXshellSetupConfig({ ...setup.defaultXshellTunnelSetupConfig, condaEnv: "torch2" }, { id: "w1", condaEnv: "" }).condaEnv, "");
  assert.equal(setup.workerTunnelToXshellSetupConfig({ ...setup.defaultXshellTunnelSetupConfig, condaEnv: "torch2" }, { id: "w1" }).condaEnv, "torch2");

  const blank = policy.agentTmuxStartupCommand({ role: "hub", port: 18765, installDir: "/srv/agent", workDir: "/srv/demo", condaEnv: "" });
  assert.match(blank, /SIMPLE_EXPERIMENT_CONDA_ENV=''/);
  assert.match(blank, /SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV='0'/);
  assert.match(blank, /SIMPLE_EXPERIMENT_AGENT_TMUX_V20=1/);
  assert.match(blank, /if \[ -n "\$SIMPLE_EXPERIMENT_CONDA_ENV" \]; then :/);

  const explicit = policy.agentTmuxStartupCommand({ role: "worker", endpointId: "w1", port: 18766, installDir: "/srv/agent", workDir: "/srv/demo", condaEnv: "torch2" });
  assert.match(explicit, /SIMPLE_EXPERIMENT_CONDA_ENV='torch2'/);
  assert.match(explicit, /SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV='1'/);
  assert.match(explicit, /conda activate "\$SIMPLE_EXPERIMENT_CONDA_ENV"/);
});

test("generated runtimes use system Python for blank environment and fail closed for explicit Conda", () => {
  const agentPath = path.join(root, "dist/runtime/cluster_agent.py");
  const schedulerPath = path.join(root, "dist/runtime/cluster_scheduler.py");
  const script = `
import importlib.util, json, os, sys
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module
agent = load("simple_experiment_agent", ${JSON.stringify(agentPath)})
os.environ["SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX"] = "zlk"
scheduler = load("simple_experiment_scheduler", ${JSON.stringify(schedulerPath)})
blank = agent.simple_runtime_env({})
explicit = agent.simple_runtime_env({"SIMPLE_EXPERIMENT_CONDA_ENV": "/path/to/conda_envs/torch2"})
try:
    agent.simple_runtime_python({"SIMPLE_EXPERIMENT_CONDA_ENV": "torch2"})
    invalid_name_rejected = False
except RuntimeError:
    invalid_name_rejected = True
print(json.dumps({
    "blank": blank,
    "blank_python": agent.simple_runtime_python(blank),
    "explicit": explicit,
    "explicit_python": agent.simple_runtime_python(explicit),
    "invalid_name_rejected": invalid_name_rejected,
    "agent_activation": agent.simple_conda_activation_script(),
    "prefixed_tmux": agent.simple_tmux_name("worker-w1-1"),
    "scheduler_blank_name": scheduler.simple_conda_env_name({}),
    "scheduler_blank_activation": scheduler.simple_conda_activation_script({}),
    "scheduler_blank_python": scheduler.runtime_python_command({}),
    "scheduler_explicit_activation": scheduler.simple_conda_activation_script({"SIMPLE_EXPERIMENT_CONDA_ENV": "/path/to/conda_envs/torch2", "SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV": "1"}),
}))
`;
  const result = spawnSync("python", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.blank.SIMPLE_EXPERIMENT_CONDA_ENV, "");
  assert.equal(value.blank.SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV, "0");
  assert.equal(value.blank_python, value.scheduler_blank_python);
  assert.equal(value.explicit.SIMPLE_EXPERIMENT_CONDA_ENV, "/path/to/conda_envs/torch2");
  assert.equal(value.explicit.SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV, "1");
  assert.equal(value.explicit_python, "/path/to/conda_envs/torch2/bin/python");
  assert.equal(value.invalid_name_rejected, true);
  assert.match(value.agent_activation, /if \[ -n "\$SIMPLE_EXPERIMENT_CONDA_ENV" \]; then :/);
  assert.equal(value.prefixed_tmux, "zlk-worker-w1-1");
  assert.equal(value.scheduler_blank_name, "");
  assert.equal(value.scheduler_blank_activation, "true");
  assert.match(value.scheduler_explicit_activation, /conda activate "\$SIMPLE_EXPERIMENT_CONDA_ENV"/);
});

test("settings and confirmations explain the effective runtime environment", () => {
  assert.match(extension, /function condaEnvPatch\(patch, key, fallback = ""\)/);
  assert.match(extension, /return condaEnv \? `Conda \$\{condaEnv\}` : "系统 Python（未指定 Conda）"/);
  assert.match(extension, /skipIfRemoteCommandIncludes: \[target\.command\]/);
  assert.match(panel, /configInput\("hub", "remoteTmuxSessionPrefix", "tmux 会话前缀"/);
  assert.match(panel, /if \(!hubParticipates\) cards\.push\([\s\S]{0,500}data-anchor="servers-session-defaults"[\s\S]{0,700}remoteTmuxSessionPrefix/);
  assert.match(extension, /remoteTmuxSessionPrefix: preservedStringPatch\(patch, "remoteTmuxSessionPrefix"/);
  assert.match(agentSource, /conda_declared = any\(key in command/);
  assert.match(agentSource, /env\["SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV"\] = "1" if conda_env else "0"/);
  assert.match(panel, /Conda 环境绝对路径（可选，必填完整路径）/);
  assert.match(panel, /留空使用系统 Python/);
});
