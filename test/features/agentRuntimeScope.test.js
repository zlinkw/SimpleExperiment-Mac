const assert = require("node:assert/strict");
const test = require("node:test");

const { selectAgentRuntimeTargets } = require("../../dist/features/AgentRuntimeScope.js");

const targets = [
  { id: "hub", label: "Hub", role: "hub" },
  { id: "nwpu3", label: "NWPU3", role: "worker" },
  { id: "nwpu5", label: "NWPU5", role: "worker" },
];

test("Agent runtime deployment defaults to every topology target", () => {
  assert.deepEqual(selectAgentRuntimeTargets(targets).map((target) => target.id), ["hub", "nwpu3", "nwpu5"]);
});

test("Agent runtime deployment honors an explicit serverId list", () => {
  const selected = selectAgentRuntimeTargets(targets, ["nwpu3"]);
  assert.deepEqual(selected.map((target) => target.id), ["nwpu3"]);
});

test("Agent runtime selection accepts labels and is case insensitive", () => {
  const selected = selectAgentRuntimeTargets(targets, ["NWPU5"]);
  assert.deepEqual(selected.map((target) => target.id), ["nwpu5"]);
});

test("An unmatched deployment scope stops before any upload", () => {
  assert.throws(() => selectAgentRuntimeTargets(targets, ["does-not-exist"]), /没有匹配目标/);
});
