const test = require("node:test");
const assert = require("node:assert/strict");

const {
  agentTmuxStartupCommand,
  defaultAgentTmuxSessionName,
  isValidRemoteTmuxSessionName,
} = require("../../dist/tunnel/AgentTmuxPolicy.js");

test("agent tmux policy supports configurable remote session prefixes", () => {
  assert.equal(defaultAgentTmuxSessionName("hub"), "simple-hub-agent");
  assert.equal(defaultAgentTmuxSessionName("worker", "nwpu5"), "simple-worker-nwpu5-agent");
  assert.equal(defaultAgentTmuxSessionName("worker", "nwpu5", "zlk"), "zlk-worker-nwpu5-agent");
  assert.equal(isValidRemoteTmuxSessionName("simple-worker-nwpu5-agent"), true);
  assert.equal(isValidRemoteTmuxSessionName("zlk-worker-nwpu5-agent"), true);
  assert.equal(isValidRemoteTmuxSessionName("-worker-agent"), false);
});

test("agent tmux startup uses system Python by default and requires explicit Conda environments", () => {
  const blank = agentTmuxStartupCommand({ role: "hub", installDir: "/srv/agent", workDir: "/srv/project" });
  assert.match(blank, /SIMPLE_EXPERIMENT_AGENT_TMUX_V20=1/);
  assert.match(blank, /SIMPLE_EXPERIMENT_CONDA_ENV=''/);
  assert.match(blank, /SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV='0'/);
  assert.match(blank, /if \[ -n "\$SIMPLE_EXPERIMENT_CONDA_ENV" \]; then :/);

  const explicit = agentTmuxStartupCommand({ role: "hub", installDir: "/srv/agent", workDir: "/srv/project", condaEnv: "torch2" });
  assert.match(explicit, /SIMPLE_EXPERIMENT_CONDA_ENV='torch2'/);
  assert.match(explicit, /SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV='1'/);
  assert.match(explicit, /export SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV="\$\{SIMPLE_EXPERIMENT_REQUIRE_CONDA_ENV:-1\}"/);
  assert.match(explicit, /conda activate "\$SIMPLE_EXPERIMENT_CONDA_ENV"/);
});
