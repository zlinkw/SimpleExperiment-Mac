
Path
----
D:\GitRepo\MCP\simple-experiment

## 展示规范

- 对用户展示会话名称（title/slug），agent 间仍用 ses_... ID 精准拉取（捕获-转发-校验：从 Task 工具返回 JSON 的 SubtaskPart.sessionID/Message.id 原样转发，校验 ses_[a-zA-Z0-9]{20,}/msg_...，NotFound 回报“会话引用失效，请重试”）
- 主调度总结：首段 1 句人话结论 + 3-5 bullets（改了什么/为何/下一步），文件:行号仅放附录；对外展示不影响内部 handoff 仍为可执行 session.messages
- 共享上下文包引用优先级高于 caveman 精简，Batch complete 与 Final-Only 不得覆盖“一次读取、全员共用”硬门控

## 红线约束（严禁再犯）

### 删除路径安全（最高优先级，P0）

所有本机与 Worker 的文件或目录删除，包括批量删除、同步覆盖清理、rsync 空目录清理和临时目录清理，均须先将目标安全根目录和目标父目录解析为规范路径，确认父目录在安全根目录内，并成功 `cd` 到目标的直接父目录；随后核实当前物理工作目录就是该父目录。项目文件以项目根目录为安全根，插件暂存文件以经验证的系统暂存目录为安全根。任一检查或 `cd` 失败必须停止，提示 `PARENT_CD_FAILED`，不得执行删除。

- 删除目标参数只能是直接子项的最短相对路径 `./<名称>`，严禁在删除命令中使用绝对路径、父目录、`..`、通配符或拼接后的长路径。不得删除项目根目录、机器状态或符号链接。
- 目录若采用空目录 `rsync --delete`，空目录须在已验证的父目录内创建；rsync 目标、目录移除、临时目录清理均只能使用当前目录下的最短相对路径。失败不得视为删除完成。
- 用户必须在可完整查看目标路径的页面两次确认后，插件才能执行删除。速度优化和并行执行不得绕过上述检查。此约束优先于本项目其他实现与性能要求。

### 禁止阻塞测试（P0）

#### P0 — 禁止会挂起的测试进程

生产代码 `dist/runtime/cluster_scheduler.py` 与 `src/clusterSchedulerRuntime.legacy.ts` 的 `wait_for_plan_queue()` 在前序 Plan 未完成时执行 `while True`，并调用全局 `time.sleep(5)`。只替换 `scheduler.time.sleep` 不能打断它。

编写或修改会启动 Python 的 `node:test` 时：

- 禁止用 `python -c` 执行长脚本；写入临时 `.py` 后运行，测试结束删除。
- 禁止 import 或 exec 完整 `cluster_agent.py`、`cluster_scheduler.py`。只提取被测函数及其 import。
- 调用 `wait_for_plan_queue` 前，前序 Plan 必须已经完成；不得进入 sleep 循环。
- `spawnSync` 必须设置 `timeout <= 10000`、`windowsHide: true`，并断言 `status === 0`。
- Windows 上 `os.kill(pid, 0)` 对存活进程也会抛错，进程存活判断必须可注入测试替身。

运行测试时：

- 先单独运行目标测试文件，禁止一开始执行 `npm test` 或 `node --test test/**/*.test.js`。
- 同一时间只允许一个 node/python 测试进程，禁止并行工具调用。
- 使用 `node --test --test-force-exit --test-timeout 20000 <单个文件>`。
- 20 秒未退出即停止，不重试，不修改生产代码来“修测试”。

### P0 — 外层模板剥离坑：`src/ui/PanelHtml.ts` 的 `return `...<script>...`` 外层模板吞噬正则 `\`

**严禁** 在 `PanelHtml.ts` 最外层 `return `...<script>...</script>`` 模板字符串内部裸写任何单反斜杠转义的正则/字符串字面量（`\s` `\d` `\w` `\.` `\/` `\{` `\}` `\(` `\)` `\n` `\t` 等），**严禁** 直接写 `/\s+/` `/\d+/` `"\n"` 这类裸 `\`。

- **现象**：面板握手超时，控制台 `Unexpected token 'const'` / `Invalid or unexpected token`，26 处正则的 `\` 被外层模板层吞噬后语法断裂，内层 `<script>` 直接解析失败。
- **根因**：外层是 JS 模板字符串，内层脚本中的 `\s` `\d` 等会被外层模板预解析为转义序列（`\s`→`s`、`\n`→真实换行），落盘后正则已损坏。
- **正确写法（二选一，择一即合规）**：
  1. **双写转义**：正则/字符串内的每个 `\` 都写成 `\\`，如 `/\\s+/` `/\\d{4}-\\d{2}-\\d{2}/` `"\\n"`。经外层模板一层剥离后落盘恰好还原为 `/\s+/`。
  2. **`String.fromCharCode` 规避**：需换行时用 `String.fromCharCode(10)` 替代 `"\n"`（已有先例 `PanelHtml.ts:2529`）。
- **门禁（提交前必跑，双重校验缺一不可）**：
  1. `npm run build` 已内置 `node -c dist/extension.js && node -c dist/ui/PanelHtml.js` 语法门禁（见 `package.json#scripts.build`），**严禁** 跳过 build 直接提交。
  2. 额外 `vm.Script` 校验：`node -e "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8'))"` 或等效脚本，必须零异常；`node -c` 只查语法，`vm.Script` 进一步确保模板剥离后仍为合法 JS。
- **自检口诀**：改 `PanelHtml.ts` 内层脚本前，先全局搜索外层模板内的 `/\` 与 `"\`；凡见裸 `\` 即视为 P0 缺陷，批量替换为 `\\` 后再验证门禁。
- 详见 `docs/troubleshooting.md#外层模板剥离坑-P0` 与 `docs/bash-lc-pitfalls.md` 交叉引用。

### P0 — 禁止硬编码隧道端口/IP，隧道按每服务器用户配置动态解析

**严禁** 在任何业务逻辑中硬编码隧道端口（如 `10890`）或固定假设 `127.0.0.1:18765` 为唯一可达的 Agent 地址。隧道由用户为每台服务器通过 Xshell/SSH 配置（`*.xsh` 会话、`~/.ssh/config`、`settings.json` 的每服务器 `host/port/forward` 配置）动态决定，必须在运行时从该配置解析实际 `localForwardHost/localForwardPort/remoteAgentHost/remoteAgentPort`。

- **现象**：`10890` 写死导致用户自定义隧道不可用；写死 `127.0.0.1:18765` 导致 Worker Telemetry 校验无回调、GPU tmux 无法打开、job 调度静默失败（`ModuleNotFoundError: torch` 等未回传到 UI）。
- **正确做法**：
  1. 所有探活/校验/版本比对必须读取 `TunnelEndpointConfig`/`XshellRealtimeTunnelConfig`/`TunnelEndpointPortAssignment` 中的 `localForwardHost/localForwardPort` 与 `remoteAgentHost/remoteAgentPort`，动态拼装 `baseUrl`（如 `http://${host}:${port}`），不得回退到固定端口检测。
  2. 展示层（`PanelHtml.ts`）的端口输入框以配置为准，`TunnelGateway`/`XshellTunnelSetup` 不得 `throw` 限制只能 `127.0.0.1`；默认值可为 `127.0.0.1:18765` 做兼容，但校验逻辑需接受用户配置的任意 `host:port`。
  3. Agent 侧兼容：`/health` 与 `/api/health`（以及 `/version` 与 `/api/version`）均为健康检查别名，`worker_telemetry` 模式必须放行健康与版本接口，避免前端 404 无回调。
- **门禁**：`Select-String -Pattern "10890"` 在 `src/**`/`dist/**` 业务逻辑中必须零命中（仅允许在 `docs/`/`AGENTS.md` 约束说明中出现）；`127.0.0.1:18765` 不得作为探测硬编码，改为读取配置；`npm run build` 与 `vm.Script` 双重校验仍需通过。
- 详见 `docs/troubleshooting.md#禁止硬编码隧道端口-P0` 与 `docs/adr/003-tunnel-dynamic-endpoint.md`。

## 版本与安装

- 阶段 1：修改完成并通过验证后递增一个补丁版本，同步 `package.json`、`package-lock.json` 与 runtime 版本，再运行 `npm run package`。该命令只构建和生成 VSIX，不得改变当前 VS Code 安装状态。
- 阶段 2：全部修改与打包验证结束、准备交给用户重载时，显式运行一次 `npm run install:latest`。同版本必须跳过，禁止默认 `--force`、禁止降级；每个目标版本最多安装一次。
- 安装后立即核对 VS Code 已安装版本与 `simpleex` 入口，并停止操作当前 SimpleExperiment 面板。用户执行 **Developer: Reload Window** 后再进行 UI 验收。
- P0：禁止 `package` 生命周期自动 live install 正在运行的扩展；禁止对同一版本连续执行 `code --install-extension ... --force`。若磁盘版本与 Extension Host 运行版本不一致，预期显示“需要重载窗口”专页。
