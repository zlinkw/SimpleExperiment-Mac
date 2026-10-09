const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../../src/ui/PanelHtml.legacy.ts"), "utf8");
const cardsStart = source.indexOf("function renderServerCardsV2(state)");
const cardsEnd = source.indexOf("function renderServerCards(state)", cardsStart);
const helpStart = source.indexOf("function configHelp(scope, key)");
const helpEnd = source.indexOf("function sessionStatusCell(", helpStart);
assert.ok(cardsStart >= 0 && cardsEnd > cardsStart);
assert.ok(helpStart >= 0 && helpEnd > helpStart);
const cards = source.slice(cardsStart, cardsEnd);
const help = vm.runInNewContext(source.slice(helpStart, helpEnd) + "\nconfigHelp;");

test("server form has one network address and one remote parent directory per endpoint", () => {
  assert.match(cards, /configInput\("hub", "hubHost", "服务器地址"/);
  assert.match(cards, /configInput\(scope, "workerHost", "服务器地址"/);
  assert.match(cards, /configInput\("hub", "agentProjectDir", "项目父目录"/);
  assert.match(cards, /configInput\(scope, "agentProjectDir", "项目父目录"/);
  assert.doesNotMatch(cards, /configInput\((?:"hub"|scope), "(?:transferHost|sshConfigAlias)"/);
  assert.match(cards, /SSH\/SFTP 文件操作使用服务器地址/);
  assert.match(cards, /文件传输路径由项目父目录和当前项目名自动计算/);
});

test("every visible server, scheduler and topology field has a useful hover explanation", () => {
  const calls = [...cards.matchAll(/config(?:Input|Select|SessionSelect)\((?:"(hub|scheduler|topology)"|scope),\s*"(\w+)"/g)];
  assert.ok(calls.length >= 20);
  for (const [, scope, key] of calls) {
    const text = help(scope || "worker:example", key);
    assert.ok(text && text.length >= 15, `missing explanation for ${scope || "worker"}.${key}`);
  }
  for (const [scope, key] of [
    ["hub", "localForwardPort"], ["hub", "remoteAgentPort"],
    ["worker:example", "localForwardPort"], ["worker:example", "remoteTelemetryPort"],
    ["worker:example", "gpuIdleUtilThreshold"], ["worker:example", "gpuIdleMemThresholdMb"],
    ["worker:example", "sessionCheckMinSeconds"],
  ]) assert.ok(help(scope, key).length >= 15, `missing explanation for ${scope}.${key}`);
  assert.match(help("hub", "hubHost"), /IP 地址.*不是文件路径/);
  assert.match(help("hub", "agentProjectDir"), /自动追加当前本地项目名/);
});

test("other settings controls explain their purpose on hover", () => {
  assert.match(source, /remoteAllowedRootsInput[^\n]*title="每行一个服务器上的绝对目录/);
  assert.match(source, /remoteDeniedRootsInput[^\n]*title="每行一个服务器上的绝对目录/);
  assert.match(source, /data-key="csvDirectory"[^\n]*title="填写工作区相对目录/);
  assert.match(source, /const fieldHelp = String\(title \|\| label\)/);
  assert.match(source, /const fieldHelp = String\(title \|\| label\) \+ "；当前 "/);
});
