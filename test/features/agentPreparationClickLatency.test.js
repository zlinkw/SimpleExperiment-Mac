const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");
const extension = readSource("src/extension.ts");

test("Agent button avoids logging the entire live panel state before showing loading", () => {
  const start = panel.indexOf('const button = event.target.closest("button[data-command]")');
  const end = panel.indexOf("const payload = payloadFromButton(button)", start);
  assert.ok(start >= 0 && end > start);
  const clickPrelude = panel.slice(start, end);
  assert.doesNotMatch(clickPrelude, /console\.log\([^;]*lastState/);
});

test("Agent preflight refreshes Xshell data without redundant panel state posts", async () => {
  const prepareStart = extension.indexOf("async prepareAgentsForFirstRun(showMessage = true)");
  const prepareEnd = extension.indexOf("async configureXshellRealtimeTunnel()", prepareStart);
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
  const prepare = extension.slice(prepareStart, prepareEnd);
  assert.match(prepare, /syncXshellConfigBeforeNetwork\("prepare agents for first run",\s*\{\s*postState:\s*false\s*\}\)/);

  const methodStart = extension.indexOf("async syncXshellConfigBeforeNetwork(");
  const methodEnd = extension.indexOf("withXshellDerivedFields(config)", methodStart);
  assert.ok(methodStart >= 0 && methodEnd > methodStart);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext("this.run = ({" + extension.slice(methodStart, methodEnd) + "}).syncXshellConfigBeforeNetwork", sandbox);
  let posts = 0;
  const host = {
    refreshXshellSessionLibrary: async (options = {}) => { if (options.postState !== false) posts++; },
    refreshLocalSshConfig: async () => {},
    assertSshTransportIdentities: async () => {},
    sftpSharedTargets: () => [],
    syncConfiguredXshellSessions: async (_reason, postStateOnUnchanged = true) => { if (postStateOnUnchanged) posts++; },
  };
  await sandbox.run.call(host, "prepare agents for first run", { postState: false });
  assert.equal(posts, 0);
});

test("unchanged Xshell configuration skips state delivery only when requested", async () => {
  const start = extension.indexOf("async syncConfiguredXshellSessions(");
  const end = extension.indexOf("async syncXshellConfigBeforeNetwork(", start);
  assert.ok(start >= 0 && end > start);
  const sandbox = { XshellTunnelSetup_1: { publicXshellSetupSummary: (value) => value } };
  vm.createContext(sandbox);
  vm.runInContext("this.run = ({" + extension.slice(start, end) + "}).syncConfiguredXshellSessions", sandbox);
  let posts = 0;
  const host = {
    setupConfig: { id: "worker-a" },
    withXshellDerivedFields: (config) => ({ ...config }),
    postState: () => { posts++; },
    applySetupDraft: async () => { throw new Error("unexpected config write"); },
  };
  await sandbox.run.call(host, "prepare agents for first run", false);
  assert.equal(posts, 0);
  await sandbox.run.call(host, "other caller");
  assert.equal(posts, 1);
});
