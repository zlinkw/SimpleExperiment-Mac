const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// Mac 适配：文档承载差异——Windows 的 “## 配置总览/## 3. 创建 Xshell 隧道/打开服务器设置” 指南章节与
// README 项目路径业务文案，在 Mac 发行中由 docs/simple-experiment-setup.md 的对应章节与
// docs/technical-notes.md 的“推荐项目组织方式”承载（同义断言，非放宽）。
const guide = fs.readFileSync(path.join(__dirname, "../../docs/simple-experiment-setup.md"), "utf8");
const notes = fs.readFileSync(path.join(__dirname, "../../docs/technical-notes.md"), "utf8");

test("setup guide explains project parent directory and upload destination", () => {
  assert.match(guide, /## 3\. 本机工作区与路径配置/);
  assert.match(guide, /## 5\. 系统 OpenSSH 一键启动与 Termius 备份（端点配置）/);
  assert.match(guide, /确认服务器与端点 → 部署并检测 Agent → 接入本地项目/);
  assert.match(guide, /不要使用 `\/`、`\/root`、`\/tmp` 或数据集所在目录作为实验项目父目录/);
  assert.match(notes, /并会同步到每台服务器的/);
  assert.match(notes, /<项目父目录>\/<当前 VS Code 工作区名>/);
  assert.match(notes, /<项目父目录>\/simple_agent/);
  assert.match(notes, /检测全部/);
});
