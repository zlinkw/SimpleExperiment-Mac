"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { EXPERIMENT_ROOT, SFTP_ROOT, REPOSITORY, run, npm, json, fingerprint, assertSource } = require("./mac-release-common");

function main() {
  const roots = [SFTP_ROOT, EXPERIMENT_ROOT], repos = ["SimpleSFTP-Mac", "SimpleExperiment-Mac"];
  const commits = roots.map((root, index) => assertSource(root, repos[index]));
  const packages = roots.map(root => json(path.join(root, "package.json")));
  for (let index = 0; index < 2; index++) {
    if (`${packages[index].publisher}.${packages[index].name}` !== ["simple-local.simple-sftp-mac", "simple-local.simple-experiment-mac"][index]) throw new Error("Unexpected Mac extension identity");
    if (!/^\d+\.\d+\.\d+$/.test(packages[index].version)) throw new Error("Invalid package version");
    npm(["run", "build"], roots[index]);
  }
  const files = ["macVsix", "macPreviewRelease", "macUpdateTransaction", "macBootstrap", "macUpdateGate", "macUpdatePanel", "macHostLeasePaths", "macSetupGuide", "macPanelTheme", "macManualTunnel", "macProjectPrepare", "topologyMode"];
  for (const file of files) run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", `test/features/${file}.test.js`], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "test/core/workspacePathMapper.test.js"], EXPERIMENT_ROOT, { inherit: true, timeout: 20000 });
  for (const file of ["macBootstrap", "publicBranding", "api", "workspacePathMapper", "workspaceIntegration", "macLeasePaths", "macAuthentication", "macRelay", "apiUploadProgress"]) run(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", `test/${file}.test.js`], SFTP_ROOT, { inherit: true, timeout: 20000 });
  npm(["run", "verify:package-runtime"], EXPERIMENT_ROOT);
  run(process.execPath, ["-e", "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8'))"], EXPERIMENT_ROOT);
  const tag = `preview-v${packages[1].version}`, directory = path.join(EXPERIMENT_ROOT, "release-artifacts", tag);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (fs.existsSync(directory)) throw new Error(`Prepared version already exists; inspect retained artifacts: ${directory}`);
  fs.mkdirSync(directory);
  const { inspectVsix, verifyVsix } = require("../dist/mac/Vsix");
  const components = roots.map((root, index) => {
    const pkg = packages[index], name = `${pkg.name}-${pkg.version}-darwin-arm64.vsix`, file = path.join(directory, name);
    run(process.execPath, [require.resolve("@vscode/vsce/vsce", { paths: [root] }), "package", "--no-dependencies", "--target", "darwin-arm64", "--out", file], root, { inherit: true, timeout: 60000 });
    const metadata = fingerprint(file), actual = inspectVsix(fs.readFileSync(file));
    const component = { extensionId: `${pkg.publisher}.${pkg.name}`, version: pkg.version, sourceCommit: commits[index], sourceRepository: `zlinkw/${repos[index]}`, targetPlatform: "darwin-arm64", vscodeEngine: pkg.engines.vscode, downloadUrl: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`, size: metadata.size, sha256: metadata.sha256 };
    verifyVsix(fs.readFileSync(file), component);
    if (actual.files.has("extension/baseline-source.zip") || [...actual.files.keys()].some(name => /\/release-artifacts\//.test(name))) throw new Error("Package contains local release artifacts");
    return component;
  });
  for (let index = 0; index < 2; index++) if (assertSource(roots[index], repos[index]) !== commits[index]) throw new Error("Build changed release source");
  const manifest = { protocolVersion: 1, channel: "preview", releaseTag: tag, publishedAt: new Date().toISOString(), minimumMacOS: "26.0", components };
  fs.writeFileSync(path.join(directory, "release.json"), JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  const notes = `Apple Silicon macOS 26 及以上 preview。\n\n本地验证\n两仓 build、包依赖闭包、面板生成脚本及更新目标测试逐文件串行通过。真实 VSIX 的身份、版本、darwin-arm64、CRC 与 SHA-256 已校验。\n\nM5 真机验证\n尚未执行。需在 M5、24 GB、macOS 27.0 验证首版到第二版更新、设置保留、重载与部分失败补装。\n\n当前范围\n更新链路及本地 POSIX 工作区测试版。包内配置说明与两仓 README 已按 Mac 使用方式重写，包含快捷键、POSIX 路径、服务器 JSON 配置、Termius 手动转发约定与更新按钮入口。Mac 配置说明不再启动旧会话向导。Mac 宿主与共享租约保持 POSIX 大小写。本版主题修复已加入：页面、卡片、说明、输入及状态配色跟随 VS Code，浅色/深色/高对比真实 headless 渲染及代表文字对比通过。本版新增 Termius 手动端点用户设置、严格配置校验、动态 HTTP 检测与 Agent/tmux 文本指引；README 和配置说明已补全实际按钮、用户/工作区设置区别及 JSON 示例。指引不会传输文件或执行远端命令。SimpleSFTP 本版接入每服务器独立密钥、ssh-agent、密码与私钥口令；默认仅会话记忆，显式勾选后使用 SecretStorage。密码/口令不写服务器配置、命令参数或临时文件，文件流保持原接口。Mac 跨服务器普通 tar 与大文件断点分块默认通过本机内存管道中转，两端分别认证，无需服务器间免密登录；启动/流错误等待双进程 close，未知接收结果保持恢复门禁。本地模拟/协议测试已覆盖路由、断点、背压、并发和失败结算。本版接入 Mac 项目与 Agent 准备：在设置 → 服务器点击“准备项目与 Agent”，或运行命令“SimpleExperiment Mac：准备项目与 Agent（手动启动）”；核对 SSH、项目/runtime 路径后确认，SimpleSFTP 分别认证并上传，再打开 Termius/tmux 指引。取消或配置变化不上传，已有实验不自动重启，上传回执不代表 Agent 就绪；需手动启动后检测。三拓扑准备、失败回执和确认边界通过本地模拟；完整科研主流程仍在适配，尚未真机验收。PPT、Dev Containers、Intel Mac 不属于首版范围。\n\n首次安装\n先安装 SimpleSFTP Mac，再安装 SimpleExperiment Mac。以后点击 VS Code 底部右侧 Mac preview 状态栏，或执行命令面板“检查 preview 配套更新”。\n\n源码提交\nSimpleSFTP-Mac ${commits[0]}\nSimpleExperiment-Mac ${commits[1]}\n`;
  fs.writeFileSync(path.join(directory, "release-notes.md"), notes, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Prepared immutable paired preview: ${directory}\n`);
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { main };
