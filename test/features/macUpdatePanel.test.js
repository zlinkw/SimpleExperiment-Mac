const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("preview settings card offers ordered update action and preserves failure state", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");
  const start = source.indexOf("    function pluginUpdateStatusLabel(");
  const end = source.indexOf("    function remoteRootPolicyText(", start);
  let html;
  const sandbox = { esc: value => String(value), setHtmlIfChanged: (_, value) => { html = value; } };
  vm.createContext(sandbox); vm.runInContext(source.slice(start, end), sandbox);
  const component = { label: "SimpleSFTP Mac", currentVersion: "0.2.62", latestVersion: "0.2.63", updateAvailable: true };
  sandbox.renderPluginUpdateSettings({ pluginUpdate: { status: "update_available", sftp: component, message: "preview 可用" } });
  assert.match(html, /data-command="installPluginUpdates"/); assert.match(html, /0.2.62 → 0.2.63/); assert.doesNotMatch(html, /Latest Release/);
  sandbox.renderPluginUpdateSettings({ pluginUpdate: { status: "error", message: "检查失败：offline" } });
  assert.match(html, /检查失败：offline/); assert.doesNotMatch(html, /已是最新|installPluginUpdates/);
  sandbox.renderPluginUpdateSettings({ pluginUpdate: { status: "up_to_date", sftp: { ...component, updateAvailable: false } } });
  assert.match(html, /GitHub preview Release/); assert.doesNotMatch(html, /installPluginUpdates/);
});
