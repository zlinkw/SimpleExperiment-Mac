"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http");
const { spawnSync, execFile } = require("node:child_process");
const { writeMacCliLauncher, launcherText, shellQuote, CLI_COMMAND, registerMacCli } = require("../../dist/mac/CliLauncher");
const root = path.resolve(__dirname, "../..");
function evidence() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mac-cli-"));
  fs.writeFileSync(path.join(directory, "KEEP.txt"), "Local CLI evidence retained; no server or research operation.\n", "utf8");
  return directory;
}
function shell() {
  if (process.platform !== "win32") return "/bin/sh";
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  const executable = path.resolve(git.stdout.trim(), "../../..", "bin/bash.exe");
  assert.ok(fs.existsSync(executable), "local Git POSIX shell is required");
  return executable;
}
function packageFixture(directory, version) {
  fs.mkdirSync(path.join(directory, "dist"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ publisher: "simple-local", name: "simple-experiment-mac", version }), "utf8");
  fs.writeFileSync(path.join(directory, "dist/cli.js"), "console.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}))\n", "utf8");
}
test("stable POSIX launcher preserves arguments/cwd, updates to the new package and cannot downgrade", () => {
  const directory = evidence(), v1 = path.join(directory, "版本 A ' $()"), v2 = path.join(directory, "版本 B ' $()"), data = path.join(directory, "Library/Application Support/SimpleExperimentMac");
  packageFixture(v1, "0.1.9"); packageFixture(v2, "0.1.10");
  const target = writeMacCliLauncher(v1, data), args = ["中文 空格", " trailing ", "$(touch should-not-exist)", "'quoted'", "Model/model"];
  const text = fs.readFileSync(target, "utf8"); assert.ok(!text.includes("\r"));
  const result = spawnSync(shell(), ["-s"], { input: [shellQuote(target), ...args.map(shellQuote)].join(" ") + "\n", cwd: directory, encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { argv: args, cwd: directory });
  assert.equal(fs.existsSync(path.join(directory, "should-not-exist")), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o777, 0o700);
  assert.equal(writeMacCliLauncher(v2, data), target); assert.match(fs.readFileSync(target, "utf8"), /extension-version: 0\.1\.10/);
  const before = fs.readFileSync(target); assert.equal(writeMacCliLauncher(v1, data), target); assert.ok(fs.readFileSync(target).equals(before));
  const missingNode = spawnSync(shell(), ["-s"], { input: "PATH='' " + shellQuote(target) + "\n", cwd: directory, encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  assert.equal(missingNode.status, 127); assert.match(missingNode.stderr, /Node.js 20/);
});

test("unknown files, linked directories, hard links, invalid paths and foreign packages cannot become an entry", () => {
  const directory = evidence(), pkg = path.join(directory, "package"); packageFixture(pkg, "0.1.0");
  const unknown = path.join(directory, "unknown/cli"); fs.mkdirSync(unknown, { recursive: true });
  const target = path.join(unknown, "simpleex-mac"); fs.writeFileSync(target, "user file", "utf8");
  assert.throws(() => writeMacCliLauncher(pkg, path.dirname(unknown)), /未知文件/); assert.equal(fs.readFileSync(target, "utf8"), "user file");
  const linked = path.join(directory, "linked"), foreign = path.join(directory, "foreign"); fs.mkdirSync(foreign);
  fs.symlinkSync(foreign, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => writeMacCliLauncher(pkg, linked), /链接/); assert.deepEqual(fs.readdirSync(foreign), []);
  const hard = writeMacCliLauncher(pkg, path.join(directory, "hard")); fs.linkSync(hard, path.join(directory, "same-inode"));
  assert.throws(() => writeMacCliLauncher(pkg, path.join(directory, "hard")), /未知文件/);
  for (const entry of ["relative", "/tmp/a\n", "/tmp/a\0"]) assert.throws(() => launcherText(entry));
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "windows-original", publisher: "simple-local", version: "0.1.0" }), "utf8");
  assert.throws(() => writeMacCliLauncher(pkg, path.join(directory, "other")), /身份/);
});

test("CLI command is registered independently of business code and startup failure does not remove update entry", () => {
  const commands = new Map(), subscriptions = [];
  registerMacCli({ subscriptions }, { commands: { registerCommand: (id, work) => { commands.set(id, work); return { dispose() {} }; } } });
  assert.ok(commands.has(CLI_COMMAND)); assert.equal(subscriptions.length, 1);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); assert.ok(pkg.contributes.commands.some(item => item.command === CLI_COMMAND));
  const bootstrap = fs.readFileSync(path.join(root, "src/mac/Bootstrap.ts"), "utf8");
  const cli=bootstrap.indexOf('registerMacCli(context, vscode)'),shared=bootstrap.indexOf('shared.activateWithBusiness('),business=bootstrap.indexOf('return require("../extension")');
  assert.ok(cli>=0&&shared>cli&&business>shared);
  const updater=fs.readFileSync(path.join(root,'src/updates/Bootstrap.ts'),'utf8');
  const activate=updater.slice(updater.indexOf('export async function activateWithBusiness('));
  assert.ok(activate.indexOf('service = registerUpdater(')>=0&&activate.indexOf('service = registerUpdater(')<activate.indexOf('business = loadBusiness()'));
  assert.match(activate,/业务面板启动失败，独立更新命令仍可用/);
  assert.match(bootstrap, /try \{ cli\.refresh\(\); \}/);
});

// 注册真实命令、让面板替身点“复制自检命令”，返回用户实际拿到的那条命令，后续用例必须执行这条命令本身。
function registerCopiedCliCommand(extensionPath, componentDirectory) {
  const commands = new Map(), copied = [];
  const exports = {}, vm = require("node:vm"), localRequire = require("node:module").createRequire(path.join(root, "dist/mac/CliLauncher.js"));
  const sandbox = { exports, process: { ...process, platform: "darwin", arch: "arm64" }, require: name => name === "./MacPaths" ? { macComponentDirectory: () => componentDirectory } : localRequire(name) };
  vm.runInNewContext(fs.readFileSync(path.join(root, "dist/mac/CliLauncher.js"), "utf8"), sandbox);
  exports.registerMacCli({ extensionPath, subscriptions: [] }, { commands: { registerCommand: (id, work) => { commands.set(id, work); return {}; } },
    window: { showInformationMessage: async () => "复制自检命令" }, env: { clipboard: { writeText: async value => copied.push(value) } } });
  return { run: () => commands.get(CLI_COMMAND)(), copied };
}
// 用 --json 才能拿到可解析结果并及时退出（人类可读体检表格不保证退出），但执行的命令主体始终是复制出去的那一条。
// 必须异步：替身本地服务在测试进程里，同步等待会把子进程的请求饿死。
function runCopiedCli(command, directory, env) {
  return new Promise(resolve => execFile(shell(), ["-c", command + " --json"], { cwd: directory, encoding: "utf8", timeout: 15000, windowsHide: true,
    env: { ...process.env, MSYS_NO_PATHCONV: "1", ...env } },
    (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      stdout: String(stdout || ""), stderr: String(stderr || (error && error.stderr) || "") })));
}

test("actual Mac command refreshes and copies the quoted stable health-check path without a business panel", async () => {
  const directory = evidence();
  const cli = registerCopiedCliCommand(root, path.join(directory, "component"));
  const result = await cli.run();
  // 复制出去的命令必须是当前 CLI 真支持的体检入口，不能再是被移除的 self-check。
  assert.equal(result.command, shellQuote(result.path) + " doctor"); assert.deepEqual(cli.copied, [result.command]);
  assert.ok(fs.readFileSync(result.path, "utf8").includes("# extension-version: " + require("../../package.json").version));
  const probe = await runCopiedCli(result.command, directory, {});
  assert.ok(!(probe.stdout + probe.stderr).includes("removed entry"), "复制到剪贴板的命令不能再是被移除的入口: " + (probe.stdout + probe.stderr).slice(0, 200));
  // 必须是真体检载荷（plugins 数组），而不是用法错误：证明复制出去的入口当前可用。
  assert.ok(Array.isArray(JSON.parse(probe.stdout).plugins), "复制出去的命令必须落到体检载荷上: " + probe.stdout.slice(0, 200));
});

// self-check 已是从 CLI 移除的入口（生产会直接报 removed entry 并指向 doctor），体检改由 doctor 承担。
// 体检走统一入口契约：需要带 pid/startedAt 的实例身份，并同时核实配套 SimpleSFTP，因此两端都给本轮新生成的发现文件与替身服务。
const HEALTH_PID = 4241, HEALTH_STARTED_AT = "2026-01-01T00:00:00.000Z";
function stubPluginApi(name, version, methods) {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer local-fixture") { res.statusCode = 401; return res.end("{}"); }
    if (req.url !== "/api/v1/capabilities") { res.statusCode = 404; return res.end("{}"); }
    state.requests += 1;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ schemaVersion: 1, name, version, instanceId: `${HEALTH_PID}:${HEALTH_STARTED_AT}`,
      transport: ["http", "cli"], rpc: "json-rpc-2.0", features: { probe: 1 }, confirmation: { required: true, categories: ["confirm"] }, methods }));
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port,
    close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) })));
}
function writeApiDiscovery(file, name, version, port) {
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name, version, baseUrl: `http://127.0.0.1:${port}`,
    host: "127.0.0.1", port, token: "local-fixture", pid: HEALTH_PID, startedAt: HEALTH_STARTED_AT }, null, 2) + "\n", "utf8");
  return file;
}

test("actual packaged CLI health check runs through the launcher using the copied command with fresh local discovery", async () => {
  const directory = evidence();
  // 不再手工拼启动器路径与子命令：直接执行面板复制到剪贴板的那条命令。
  const cli = registerCopiedCliCommand(root, path.join(directory, "component"));
  await cli.run();
  const command = cli.copied[0];
  assert.ok(command, "必须先拿到面板复制出去的体检命令");
  const experimentApi = await stubPluginApi("SimpleExperiment", require(path.join(root, "package.json")).version, ["status", "workflow.run"]);
  const sftpApi = await stubPluginApi("SimpleSFTP", "0.2.104", ["status"]);
  const experimentDiscovery = writeApiDiscovery(path.join(directory, "发现 中文.json"), "SimpleExperiment", require(path.join(root, "package.json")).version, experimentApi.port);
  const sftpDiscovery = writeApiDiscovery(path.join(directory, "sftp-api.json"), "SimpleSFTP", "0.2.104", sftpApi.port);
  try {
    const run = await runCopiedCli(command, directory, { SIMPLE_EXPERIMENT_MAC_API_FILE: experimentDiscovery, SIMPLE_SFTP_MAC_API_FILE: sftpDiscovery });
    assert.equal(run.status, 0, "复制出去的体检命令必须成功退出: " + (run.stdout + run.stderr).slice(0, 300));
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, true, JSON.stringify(result.plugins));
    const blocks = Object.fromEntries((result.plugins || []).map(item => [item.plugin, item]));
    // 发现载荷里的名字保持产品名，仅发现文件位置与环境变量按 Mac 命名。
    for (const [plugin, api, discovery] of [["SimpleExperiment", experimentApi, experimentDiscovery], ["SimpleSFTP", sftpApi, sftpDiscovery]]) {
      assert.equal(blocks[plugin].ok, true, JSON.stringify(blocks[plugin].checks));
      assert.deepEqual(blocks[plugin].checks.map(item => item.name), ["discovery", "identity", "capabilities"]);
      assert.equal(blocks[plugin].checks[0].detail, discovery, "体检必须读本轮新生成的发现文件");
      assert.ok(api.state.requests >= 1, plugin + " 的本地服务必须真的被启动器里的 CLI 访问");
    }
  } finally { await experimentApi.close(); await sftpApi.close(); }
});
