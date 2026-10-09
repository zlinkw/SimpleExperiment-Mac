const test = require("node:test");
const assert = require("node:assert/strict");

const { explicitConfigurationValue, nonDefaultConfigurationValue } = require("../../dist/tunnel/ConfigurationSettings.js");

test("configuration defaults do not override saved tunnel setup", () => {
  const config = {
    inspect(section) {
      if (section === "tunnel.workerRealtimeMode") return { defaultValue: "hub_only" };
      if (section === "tunnel.workerTunnels") return { defaultValue: [] };
      return undefined;
    },
  };
  const savedWorkers = [{ id: "nwpu5", enabled: true }];
  assert.equal(explicitConfigurationValue(config, "tunnel.workerRealtimeMode", "hub_plus_workers"), "hub_plus_workers");
  assert.deepEqual(explicitConfigurationValue(config, "tunnel.workerTunnels", savedWorkers), savedWorkers);
});

test("explicit user configuration still overrides saved tunnel setup", () => {
  const config = {
    inspect(section) {
      if (section === "tunnel.workerRealtimeMode") return { defaultValue: "hub_only", globalValue: "hub_only" };
      if (section === "tunnel.workerTunnels") return { defaultValue: [], globalValue: [{ id: "manual", enabled: true }] };
      return undefined;
    },
  };
  assert.equal(explicitConfigurationValue(config, "tunnel.workerRealtimeMode", "hub_plus_workers"), "hub_only");
  assert.deepEqual(explicitConfigurationValue(config, "tunnel.workerTunnels", []), [{ id: "manual", enabled: true }]);
});

test("default-valued settings do not reset saved session defaults", () => {
  const config = {
    inspect(section) {
      if (section === "tunnel.remoteTmuxSessionPrefix") {
        return { defaultValue: "simple", workspaceFolderValue: "simple", workspaceValue: undefined, globalValue: undefined };
      }
      if (section === "tunnel.condaEnv") {
        return { defaultValue: "", workspaceFolderValue: undefined, workspaceValue: "", globalValue: "" };
      }
      return undefined;
    },
  };

  assert.equal(nonDefaultConfigurationValue(config, "tunnel.remoteTmuxSessionPrefix", "zlk"), "zlk");
  assert.equal(nonDefaultConfigurationValue(config, "tunnel.condaEnv", "zlk"), "zlk");
});

test("non-default user settings override saved session defaults", () => {
  const config = {
    inspect(section) {
      if (section === "tunnel.remoteTmuxSessionPrefix") {
        return { defaultValue: "simple", workspaceFolderValue: undefined, workspaceValue: "research", globalValue: "lab" };
      }
      if (section === "tunnel.condaEnv") {
        return { defaultValue: "", workspaceFolderValue: undefined, workspaceValue: "gpu", globalValue: "torch" };
      }
      return undefined;
    },
  };

  assert.equal(nonDefaultConfigurationValue(config, "tunnel.remoteTmuxSessionPrefix", "zlk"), "research");
  assert.equal(nonDefaultConfigurationValue(config, "tunnel.condaEnv", "zlk"), "gpu");
});
