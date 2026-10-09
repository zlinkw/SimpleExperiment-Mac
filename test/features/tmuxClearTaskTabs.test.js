const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extension = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");

function methodAt(name, from = 0) {
  const matched = new RegExp(`\\n    (?:async )?${name}\\(`).exec(extension.slice(from));
  return matched ? from + matched.index : -1;
}
function methodSource(name, nextName) {
  const start = methodAt(name);
  const end = methodAt(nextName, start + name.length);
  assert.ok(start > 0 && end > start, `${name} bounds`);
  return extension.slice(start, end)
    .replace(/body:\s*\{[^{}]*\}/g, "body")
    .replace(/([A-Za-z0-9_]+)\s*:\s*any\b/g, "$1")
    .replace(/([A-Za-z0-9_]+)\s*:\s*string\b/g, "$1")
    .replace(/([A-Za-z0-9_]+)\s*:\s*boolean\b/g, "$1")
    .replace(/([A-Za-z0-9_]+)\?\s*:\s*number\b/g, "$1")
    .replace(/<string,\s*true>/g, "")
    .replace(/\)\s*:\s*[^{;\n]+\{/g, ") {")
    .replace(/ as (?:const|any|typeof import\("[^"]+"\)|\{[^{}]*\})/g, "")
    .replace(/^\s*(async\s+)?([A-Za-z0-9_]+\()/, (_full, asyncKeyword, signature) => `${asyncKeyword || ""}function ${signature}`);
}

function install(sandbox) {
  const source = [
    "const errorMessage = (error) => String(error && error.message || error);",
    "class UiCommandCancelled extends Error {}",
    methodSource("tmuxWorkerId", "tmuxEndpoint"),
    methodSource("tmuxKillSessionFromTarget", "tmuxListStillHasTarget"),
    methodSource("tmuxListStillHasTarget", "isTmuxKillTransportFailure"),
    methodSource("isTmuxKillTransportFailure", "requestKillTmuxWindow"),
    methodSource("publishTmuxList", "readTmuxListAfterKill"),
    methodSource("readTmuxListAfterKill", "fetchOneTmuxListFromUi"),
    "async function fetchOneTmuxListFromUi(workerId) { return this.publishTmuxList(workerId, { ok: true, sessions: [] }); }",
    methodSource("requestKillTmuxWindow", "performKillTmuxWindow"),
    methodSource("performKillTmuxWindow", "openTensorBoardUrlFromUi"),
    methodSource("verifiedTmuxTaskTargets", "killTmuxWindowFromUi"),
    methodSource("clearTmuxTaskTabsFromUi", "clearTmuxTaskTabsOnce"),
    methodSource("clearTmuxTaskTabsOnce", "verifiedTmuxTaskTargets"),
  ].join("\n");
  vm.runInContext(`${source}\nthis.clearTabs = clearTmuxTaskTabsFromUi;`, sandbox);
  sandbox.vscode = {
    window: {
      showWarningMessage: async (text, _options, action) => {
        sandbox.warnings.push(text);
        return sandbox.confirm ? action : "取消";
      },
      withProgress: async (_options, work) => work({ report(update) { sandbox.progress.push(`${update.increment}|${update.message || ""}`); } }),
    },
    ProgressLocation: { Notification: 1 },
  };
  return vm.runInContext("clearTabs", sandbox);
}

function baseSandbox() {
  const calls = [];
  const windows = [
    { index: "0", target: "zlk-gpu-0:0", name: "bash" },
    { index: "2", target: "zlk-gpu-0:2", windowId: '@2', panes: [{ id: '%2' }], task: { status: "running", case: "a" } },
    { index: "3", target: "zlk-gpu-0:3", windowId: '@3', panes: [{ id: '%3' }], task: { status: "failed", case: "b" } },
    { index: "8", target: "zlk-gpu-0:8", name: "agent", task: { status: "running", case: "agent" } },
    { index: "9", target: "zlk-gpu-0-agent:9", task: { status: "running", case: "agent" } },
  ];
  const sandbox = {
    crypto: require('node:crypto'),
    TmuxWindowIdentity: require('../../dist/features/TmuxWindowIdentity'),
    calls,
    warnings: [],
    progress: [],
    posted: [],
    confirm: true,
    windows,
    workers: [{ id: "NWPU3", enabled: true }, { id: "worker-b", enabled: true }],
    tmuxClearTaskTabsInFlight: false,
    enabledWorkerConfigs() { return this.workers; },
    async requestTmuxJson() { return { ok: true, sessions: [] }; },
    view: { webview: { postMessage(payload) { sandbox.posted.push(payload); } } },
    client: { clients: new Map([["NWPU3", {
      requestJson: async (apiPath, purpose, body) => {
        apiPath = apiPath.split('?')[0];
        calls.push({ apiPath, purpose, body, workerId: "NWPU3" });
        if (apiPath === "/api/tmux/list") {
          if (sandbox.removeThreeOnNextList) {
            sandbox.removeThreeOnNextList = false;
            sandbox.windows = sandbox.windows.filter((win) => win.target !== "zlk-gpu-0:3");
          }
          return { ok: true, sessions: [
            { name: "zlk-gpu-0", windows: sandbox.windows },
            { name: "zlk-gpu-1", windows: [{ index: "1", target: "zlk-gpu-1:1", task: { status: "running" } }] },
          ] };
        }
        if (apiPath === "/api/tmux/kill-window") {
          if (body.target === "zlk-gpu-0:3" && sandbox.failThree) return { ok: false, error: "busy" };
          sandbox.windows = sandbox.windows.filter((win) => win.target !== body.target);
          return { ok: true, verified: true };
        }
        throw new Error(`unexpected ${apiPath}`);
      },
    }]]) },
  };
  vm.createContext(sandbox);
  return sandbox;
}

const message = {
  command: "clearTmuxTaskTabs",
  workerId: "NWPU3",
  session: "zlk-gpu-0",
  targets: ["zlk-gpu-0:2", "zlk-gpu-0:2", "zlk-gpu-0:3"],
};
const invalidMessage = {
  ...message,
  targets: ["zlk-gpu-0:2", "zlk-gpu-0:0", "zlk-gpu-0:8", "zlk-gpu-0-agent:9", "zlk-gpu-1:1", "zlk-gpu-0"],
};

test("clear task tabs confirms once and closes only current task windows", async () => {
  const sandbox = baseSandbox();
  const clearTabs = install(sandbox);
  const summary = await clearTabs.call(sandbox, message);
  assert.equal(sandbox.warnings.length, 1);
  assert.match(sandbox.warnings[0], /NWPU3/);
  assert.match(sandbox.warnings[0], /zlk-gpu-0/);
  assert.match(sandbox.warnings[0], /2 个任务标签/);
  const kills = sandbox.calls.filter((call) => call.apiPath === "/api/tmux/kill-window");
  assert.deepEqual(kills.map((call) => call.body.target), ["zlk-gpu-0:2", "zlk-gpu-0:3"]);
  assert.equal(kills.every((call) => call.body.confirm === true && call.body.session === "zlk-gpu-0"), true);
  assert.equal(sandbox.calls.some((call) => call.body && (call.body.target === "zlk-gpu-0:0" || call.body.target === "zlk-gpu-1:1" || call.body.target === "zlk-gpu-0")), false);
  assert.match(summary, /已关闭 2\/2/);
  assert.match(sandbox.progress.join("\n"), /正在关闭 1\/2 zlk-gpu-0:2/);
  assert.match(sandbox.progress.join("\n"), /正在关闭 2\/2 zlk-gpu-0:3/);
  assert.equal(sandbox.tmuxClearTaskTabsInFlight, false);
});

test("cancel and identity mismatches send no kill", async () => {
  const sandbox = baseSandbox();
  sandbox.confirm = false;
  const clearTabs = install(sandbox);
  await assert.rejects(() => clearTabs.call(sandbox, message), /已取消清理任务标签/);
  assert.equal(sandbox.calls.some((call) => call.apiPath === "/api/tmux/kill-window"), false);
  assert.equal(sandbox.tmuxClearTaskTabsInFlight, false);

  await assert.rejects(() => clearTabs.call(sandbox, invalidMessage), /不一致|必须提供明确/);
  await assert.rejects(() => clearTabs.call(sandbox, { ...message, workerId: "worker-b", targets: ["zlk-gpu-0:2"] }), /不一致/);
  await assert.rejects(() => clearTabs.call(sandbox, { ...message, session: "zlk-gpu-0", targets: ["zlk-gpu-0"] }), /不一致|必须提供明确/);
  await assert.rejects(() => clearTabs.call(sandbox, { ...message, session: "zlk-worker", targets: ["zlk-worker:1"] }), /必须指定当前 GPU 会话/);
  await assert.rejects(() => clearTabs.call(sandbox, { ...message, targets: [] }), /没有可清理/);
  assert.equal(sandbox.calls.filter((call) => call.apiPath === "/api/tmux/kill-window").length, 0);
});

test("partial failure reports closed and failed targets once", async () => {
  const sandbox = baseSandbox();
  sandbox.failThree = true;
  const clearTabs = install(sandbox);
  await assert.rejects(() => clearTabs.call(sandbox, { ...message, targets: ["zlk-gpu-0:2", "zlk-gpu-0:3"] }), /已关闭 1\/2[\s\S]*zlk-gpu-0:3/);
  const kills = sandbox.calls.filter((call) => call.apiPath === "/api/tmux/kill-window");
  assert.deepEqual(kills.map((call) => call.body.target), ["zlk-gpu-0:2", "zlk-gpu-0:3"]);
  assert.equal(sandbox.windows.some((win) => win.target === "zlk-gpu-0:2"), false);
  assert.equal(sandbox.windows.some((win) => win.target === "zlk-gpu-0:3"), true);

  sandbox.calls.length = 0;
  sandbox.windows = [
    { index: "2", target: "zlk-gpu-0:2", windowId: '@2', panes: [{ id: '%2' }], task: { status: "running" } },
    { index: "3", target: "zlk-gpu-0:3", windowId: '@3', panes: [{ id: '%3' }], task: { status: "failed" } },
  ];
  sandbox.failThree = false;
  sandbox.removeThreeOnNextList = false;
  const client = sandbox.client.clients.get("NWPU3");
  const original = client.requestJson;
  let lists = 0;
  client.requestJson = async (apiPath, purpose, body) => {
    if (apiPath.startsWith("/api/tmux/list") && ++lists === 2) sandbox.removeThreeOnNextList = true;
    return original(apiPath, purpose, body);
  };
  const raced = clearTabs.call(sandbox, { ...message, targets: ["zlk-gpu-0:2", "zlk-gpu-0:3"] });
  await assert.rejects(raced, /zlk-gpu-0:3（.*身份已变化或不存在/);
  assert.deepEqual(sandbox.calls.filter((call) => call.apiPath === "/api/tmux/kill-window").map((call) => call.body.target), ["zlk-gpu-0:2"]);
});

test('bulk close follows frozen window identities when tmux renumbers siblings', async () => {
  const sandbox = baseSandbox();
  const client = sandbox.client.clients.get('NWPU3');
  const original = client.requestJson;
  client.requestJson = async (apiPath, purpose, body) => {
    const result = await original(apiPath, purpose, body);
    if (apiPath === '/api/tmux/kill-window' && body.windowId === '@2') {
      sandbox.windows = sandbox.windows.map(win => win.windowId === '@3' ? { ...win, index: '2', target: 'zlk-gpu-0:2', task: null } : win);
    }
    return result;
  };
  const clearTabs = install(sandbox);
  assert.match(await clearTabs.call(sandbox, message), /已关闭 2\/2/);
  const kills = sandbox.calls.filter(call => call.apiPath === '/api/tmux/kill-window');
  assert.deepEqual(kills.map(call => call.body.windowId), ['@2', '@3']);
  assert.deepEqual(kills.map(call => call.body.target), ['zlk-gpu-0:2', 'zlk-gpu-0:2']);
  assert.equal(sandbox.windows.some(win => win.windowId === '@2' || win.windowId === '@3'), false);
  assert.equal(sandbox.windows.some(win => win.name === 'bash'), true);
});

test("a second clear is rejected while the first is running", async () => {
  const sandbox = baseSandbox();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = sandbox.client.clients.get("NWPU3");
  const original = client.requestJson;
  client.requestJson = async (apiPath, purpose, body) => {
    if (apiPath === "/api/tmux/kill-window" && body.target === "zlk-gpu-0:2") await gate;
    return original(apiPath, purpose, body);
  };
  const clearTabs = install(sandbox);
  const running = clearTabs.call(sandbox, { ...message, targets: ["zlk-gpu-0:2", "zlk-gpu-0:3"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sandbox.tmuxClearTaskTabsInFlight, true);
  assert.equal(sandbox.warnings.length, 1);
  await assert.rejects(() => clearTabs.call(sandbox, message), /正在清理当前 GPU 任务标签/);
  assert.equal(sandbox.warnings.length, 1);
  release();
  await running;
  assert.equal(sandbox.calls.filter((call) => call.apiPath === "/api/tmux/kill-window" && call.body.target === "zlk-gpu-0:2").length, 1);
});
