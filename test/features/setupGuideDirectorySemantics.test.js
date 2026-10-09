const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const guide = fs.readFileSync(path.join(__dirname, "../../docs/simple-experiment-setup.md"), "utf8");
const readme = fs.readFileSync(path.join(__dirname, "../../README.md"), "utf8");

test("setup guide explains project parent directory and upload destination", () => {
  assert.match(guide, /## 配置总览/);
  assert.match(guide, /## 3. 创建 Xshell 隧道/);
  assert.match(guide, /打开服务器设置/);
  assert.match(guide, /不要把 `\/root`、`\/tmp`、数据集目录或当前项目名填成项目父目录/);
  assert.match(readme, /最终项目路径由插件计算为/);
  assert.match(readme, /<项目父目录>\/<本地工作区名称>/);
  assert.match(readme, /Agent runtime 位于 `<项目父目录>\/simple_agent\/runtime`/);
  assert.match(readme, /检测全部/);
});
