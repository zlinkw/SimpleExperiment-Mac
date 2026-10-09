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
    .replace(/\)\s*:\s*[^{;\n]+\{/g, ") {")
    .replace(/ as (?:const|any|typeof import\("[^"]+"\)|\{[^{}]*\})/g, "")
    .replace(/^\s*(async\s+)?([A-Za-z0-9_]+\()/, (_full, asyncKeyword, signature) => `${asyncKeyword || ""}function ${signature}`);
}

test("GPU task tab close uses the requested Worker and exact session:index", async () => {
  const source = [
    "const errorMessage = (error) => String(error && error.message || error);",
    methodSource("tmuxWorkerId", "tmuxEndpoint"),
    methodSource("tmuxKillSessionFromTarget", "tmuxListStillHasTarget"),
    methodSource("tmuxListStillHasTarget", "isTmuxKillTransportFailure"),
    methodSource("isTmuxKillTransportFailure", "requestKillTmuxWindow"),
    methodSource("publishTmuxList", "readTmuxListAfterKill"),
    methodSource("readTmuxListAfterKill", "fetchOneTmuxListFromUi"),
    methodSource("requestKillTmuxWindow", "performKillTmuxWindow"),
    methodSource("performKillTmuxWindow", "openTensorBoardUrlFromUi"),
    methodSource("killTmuxWindowFromUi", "tmuxKillSessionFromTarget"),
  ].join("\n");
  const calls = [];
  const warnings = [];
  const progressMessages = [];
  const posted = [];
  const sandbox = {
    crypto: require('node:crypto'),
    TmuxWindowIdentity: require('../../dist/features/TmuxWindowIdentity'),
    calls,
    warnings,
    progressMessages,
    posted,
    workers: [{ id: "worker-a", enabled: true }, { id: "worker-b", enabled: true }],
    windows: [
      { index: "2", target: "zlk-gpu-0:2", windowId: '@2', name: 'run-old', panes: [{ id: '%2' }] },
      { index: "3", target: "zlk-gpu-0:3", windowId: '@3', name: 'run-running', panes: [{ id: '%3' }] },
    ],
    killResult: { ok: true, verified: true },
    enabledWorkerConfigs() { return this.workers; },
    view: { webview: { postMessage(payload) { posted.push(payload); } } },
    client: {
      clients: new Map([["worker-a", {
        requestJson: async (apiPath, purpose, body, options) => {
          apiPath = apiPath.split('?')[0];
          calls.push({ apiPath, purpose, body, options, workerId: "worker-a" });
          if (apiPath === "/api/tmux/kill-window") {
            if (sandbox.killResult?.ok === true) sandbox.windows = sandbox.windows.filter((win) => win.target !== body.target);
            return sandbox.killResult;
          }
          if (apiPath === "/api/tmux/list") {
            return { ok: true, sessions: [{ name: "zlk-gpu-0", windows: sandbox.windows }] };
          }
          throw new Error(`unexpected ${apiPath}`);
        },
      }]]),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.kill = killTmuxWindowFromUi;`, sandbox);
  sandbox.vscode = {
    window: {
      showWarningMessage: async (text) => { warnings.push(text); return "关闭窗口"; },
      withProgress: async (_options, work) => work({ report(update) { progressMessages.push(update.message || ""); } }),
    },
    ProgressLocation: { Notification: 1 },
  };
  const kill = vm.runInContext("kill", sandbox);

  await kill.call(sandbox, { command: "killTmuxWindow", workerId: "worker-a", target: "zlk-gpu-0:2", window: "zlk-gpu-0:2", session: "other-session" });
  const killCall = calls.find((call) => call.apiPath === "/api/tmux/kill-window");
  assert.equal(killCall.workerId, "worker-a");
  assert.equal(killCall.purpose, "manual_refresh");
  assert.equal(JSON.stringify(killCall.body), JSON.stringify({ target: 'zlk-gpu-0:2', session: 'zlk-gpu-0', windowId: '@2', windowName: 'run-old', paneIds: ['%2'], window: 'zlk-gpu-0:2', confirm: true }));
  assert.equal(killCall.options.method, "POST");
  assert.equal(calls.filter((call) => call.apiPath === "/api/tmux/list").length, 3);
  assert.equal(calls.some((call) => call.body && call.body.target === "zlk-gpu-0:3"), false);
  assert.equal(posted.length, 3);
  assert.equal(posted.at(-1).type, "tmuxList");
  assert.equal(posted.at(-1).workerId, "worker-a");
  assert.equal(posted.at(-1).sessions[0].windows.some((win) => win.target === "zlk-gpu-0:2"), false);
  assert.equal(posted.at(-1).sessions[0].windows.some((win) => win.target === "zlk-gpu-0:3"), true);
  assert.equal(progressMessages.at(-1), "完成");

  calls.length = 0;
  posted.length = 0;
  sandbox.killResult = { ok: false, error: "target window not found" };
  sandbox.windows.push({ index: '2', target: 'zlk-gpu-0:2', windowId: '@2', name: 'run-old', panes: [{ id: '%2' }] });
  await assert.rejects(
    () => kill.call(sandbox, { workerId: "worker-a", target: "zlk-gpu-0:2" }),
    /Agent 拒绝关闭：target window not found/,
  );
  assert.match(progressMessages.at(-1), /Agent 拒绝关闭：/);
  assert.equal(calls.filter((call) => call.apiPath === "/api/tmux/list").length, 2);
  assert.equal(posted.length, 2);

  calls.length = 0;
  await assert.rejects(
    () => kill.call(sandbox, { workerId: "worker-missing", target: "zlk-gpu-0:2" }),
    /未配置 tmux Worker：worker-missing/,
  );
  assert.equal(calls.length, 0);
});
