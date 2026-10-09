const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../../src/extension/legacy.ts"), "utf8");
const ast = ts.createSourceFile("legacy.ts", source, ts.ScriptTarget.Latest, true);
const providerNode = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "RealtimeTunnelPanelProvider");
const method = providerNode.members.find(node => node.name?.getText(ast) === "isCurrentPanelDocumentMessage");
const code = ts.transpileModule(`class Subject { ${method.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const sandbox = {};
vm.runInNewContext(`${code}; this.Subject = Subject;`, sandbox);

test("stale document ready/errors/heartbeat/section messages cannot mutate the current document", () => {
  const subject = new sandbox.Subject();
  subject.panelDocumentGeneration = 8;
  subject.panelDocumentBuildId = "build-8";
  subject.runningBuildIdentity = { version: "0.5.195" };
  const documentScopedCommands = [
    "webviewReady", "webviewRenderError", "webviewBootstrapError", "webviewHeartbeatAck",
    "webviewStateRendered", "webviewSectionInterest", "webviewSectionTelemetry", "webviewVisibility",
  ];
  for (const command of documentScopedCommands) {
    assert.equal(subject.isCurrentPanelDocumentMessage({ documentGeneration: 7 }, command), false, `${command} from generation 7`);
  }
  assert.equal(subject.isCurrentPanelDocumentMessage({ documentGeneration: 8, extensionVersion: "0.5.195", documentBuildId: "build-8" }, "webviewReady"), true);
  assert.equal(subject.isCurrentPanelDocumentMessage({ documentGeneration: 8, extensionVersion: "0.5.194", documentBuildId: "build-8" }, "webviewReady"), false);
  assert.equal(subject.isCurrentPanelDocumentMessage({ documentGeneration: 8, extensionVersion: "0.5.195", documentBuildId: "old-build" }, "webviewReady"), false);

  const guardEnd = source.indexOf('&& !this.isCurrentPanelDocumentMessage(message, command)) return;');
  const guardStart = source.lastIndexOf('"webviewReady"', guardEnd);
  assert.ok(guardStart >= 0, "handleMessageCore must have the document generation guard");
  const guardBlock = source.slice(guardStart, guardEnd + 80);
  assert.ok(guardBlock.includes('"webviewSectionInterest"') && guardBlock.includes('"webviewSectionTelemetry"'), "section interest and telemetry belong to the generation-guarded command list");
  assert.ok(guardBlock.includes("!this.isCurrentPanelDocumentMessage(message, command)"), "the guarded command list must reject stale messages before dispatch");
});
