const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { readSource } = require("../_helpers/sourceReader");

test("tunnel setup is persisted globally instead of per workspace", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /globalState\.get\(keys\.setupConfig\)/);
  assert.match(source, /const setup = persistedXshellSetupConfig\(this\.setupConfig\)/);
  assert.match(source, /globalState\.update\(keys\.setupConfig, setup\)/);
  assert.doesNotMatch(source, /workspaceState\.get\([^)]*setupConfig/);
});

test("session defaults keep the last panel save unless a non-default user setting changes", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /setupConfigurationSignature: "simpleExperimentMac\.setupConfigurationSignature"/);
  assert.match(source, /hasStoredSignature && storedSignature === this\.sessionDefaultConfigurationSignature\(sessionDefaults\)/);
  assert.match(source, /const explicit = \(0, ConfigurationSettings_1\.explicitConfigurationValue\)\(config, key, savedValue === undefined \? fallback : savedValue\)/);
  assert.match(source, /!hasStoredSignature && explicit === fallback && savedValue !== undefined && savedValue !== fallback\s*\?\s*savedValue\s*:\s*explicit/);
  assert.match(source, /configuration\.update\("tunnel\.remoteTmuxSessionPrefix", next\.remoteTmuxSessionPrefix, vscode\.ConfigurationTarget\.Global\)/);
  assert.match(source, /configuration\.update\("tunnel\.condaEnv", next\.condaEnv, vscode\.ConfigurationTarget\.Global\)/);
  const save = source.slice(source.indexOf('async applySetupDraft('), source.indexOf('async saveState('));
  assert.ok(save.indexOf('await this.saveState()') < save.indexOf('configuration.update('));
  assert.match(save, /await this\.context\.globalState\.update\(keys\.setupConfigurationSignature, this\.sessionDefaultConfigurationSignature\(\)\)/);
});
