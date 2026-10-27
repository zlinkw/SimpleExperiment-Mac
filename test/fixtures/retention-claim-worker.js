"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const vm = require("node:vm"), os = require("node:os"), ts = require("typescript");
const { ResourceOperationLeaseManager } = require("../../dist/core/ResourceOperationLease");
const { atomicWriteText } = require("../../dist/state/StateStore");
const PluginLogRetention = require("../../dist/features/PluginLogRetention");
const root = process.argv[2], id = process.argv[3];
(async () => {
  const source = await fs.readFile(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
  const helpers = source.slice(source.indexOf("const RETENTION_ADMISSION_LEAF"), source.indexOf("function workspaceWriteStatusText"));
  const methods = source.slice(source.indexOf("async evaluateRetentionWindow(planKey)"), source.indexOf("async runActionCommandCore("));
  const code = ts.transpileModule(helpers + "\nclass Host {\n" + methods + "\n}\nthis.Host = Host;",
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const ctx = { fs, path, crypto, process, PluginLogRetention, atomicWriteText,
    workspaceRoot: () => root, uniqueStrings: rows => [...new Set(rows)] };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const host = new ctx.Host();
  host.loadPlanOutputRetentionQueue = async () => ({ schemaVersion: 1, plans: [] });
  host.retentionBlockedWindows = new Map();
  host.hostOperationLease = new ResourceOperationLeaseManager({
    leasePath: path.join(root, "registry"), windowId: os.hostname() + ":" + process.pid + ":" + id,
    heartbeatMs: 100, ttlMs: 5000,
  });
  process.on("message", async message => {
    if (message === "done") process.exit(0);
    if (message !== "start") return;
    try {
      await host.claimRetentionWindow("plans/a.yaml", { commandId: id },
        (check, detail) => new Error(check + ": " + detail));
      process.send({ ok: true, id });
    } catch (error) { process.send({ ok: false, id, message: error.message }); }
  });
  process.send({ ready: true });
})().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
