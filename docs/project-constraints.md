# 项目约束（zlk-cluster-orchestrator）

本文件由 `docs/plugin-project-contract.md` 扩展，记录本插件的本地硬性约束，优先级高于通用契约。

## 删除路径安全（最高优先级，P0）

所有本机与 Worker 的文件或目录删除，包括批量删除、同步覆盖清理、rsync 空目录清理和临时目录清理，均须先将目标安全根目录和目标父目录解析为规范路径，确认父目录在安全根目录内，并成功 `cd` 到目标的直接父目录；随后核实当前物理工作目录就是该父目录。项目文件以项目根目录为安全根，插件暂存文件以经验证的系统暂存目录为安全根。任一检查或 `cd` 失败必须停止，提示 `PARENT_CD_FAILED`，不得执行删除。

- 删除目标参数只能是直接子项的最短相对路径 `./<名称>`，严禁在删除命令中使用绝对路径、父目录、`..`、通配符或拼接后的长路径。不得删除项目根目录、机器状态或符号链接。
- 目录若采用空目录 `rsync --delete`，空目录须在已验证的父目录内创建；rsync 目标、目录移除、临时目录清理均只能使用当前目录下的最短相对路径。失败不得视为删除完成。
- 用户必须在可完整查看目标路径的页面两次确认后，插件才能执行删除。速度优化和并行执行不得绕过上述检查。此约束优先于本项目其他实现与性能要求。

## 禁止写死服务器名称（P0）

- **原则**：代码、配置、文档、测试、脚本中禁止出现任何写死的服务器标识，包括但不限于：主机名、IP、`workerId`/`serverId`（如 `nwpu3`）、`tmux` 会话名（如 `zlk-worker-nwpu3-agent`）、`Xshell` 会话文件名（如 `qgking.3.xsh`）、远端绝对路径（如 `/data/qgking/...`）、`conda` 环境名与用户名的硬编码组合。
- **实现要求**：
  - 所有服务器相关逻辑必须通过配置与拓扑动态获取：`setup.workerTunnels[].id`、`setup.remoteTmuxSessionPrefix`/`sessionPrefix`、`topology.workers`、`workers.json`、`assignmentById`、`tunnelPortAssignments`、`agentProjectDir` 等。
  - `tmux` 会话名统一由 `AgentTmuxPolicy.defaultAgentTmuxSessionName(role, endpointId, sessionPrefix)` 生成，形如 `${prefix}-worker-${endpointId}-agent` / `${prefix}-hub-agent` / `${prefix}_tb`，禁止在业务逻辑中拼接 `zlk-` 或具体 `nwpu3`。
  - `cluster_scheduler.py` / `cluster_agent.py` 的 `--worker-id` 默认值保持通用 `worker`，实际值必须由 `workers.json` 或 `SIMPLE_EXPERIMENT_WORKER_ID` 环境变量注入，不得在源码中默认 `nwpu3`。
  - `extension.ts` 中 `tryIds`、`abort`、`prepareAgents` 等多端点重试必须遍历 `enabledWorkerConfigs()` 或 `clients.keys()`，禁止写死 `["hub","nwpu3"]`。
  - 新增 Worker 时自动沿用 `TunnelPortAllocator` 的 `assignment`，前端 `renderTensorBoardLinkRow` 的 URL 必须由 `localForwardPort+1000` 动态生成，不得写死 `19767/19768/6006`。
  - 测试、文档、示例中的具体服务器名仅可作为 `example` 出现在注释或 `test/fixtures`，禁止作为业务分支条件。

- **校验**：`rg -n "nwpu3|qgking\.3|10\.70\.|/data/qgking" src --glob '!*.test.*'` 必须 0 命中；`rg -n "zlk-worker-" src` 仅允许在 `AgentTmuxPolicy` 的通用拼接处出现，且需以 `${prefix}` / `${endpointId}` 变量形式。

## 禁止阻塞测试（P0）

### P0 — 禁止会挂起的测试进程

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

## 其他约束

- 调度器轮询下限 `pollSeconds >=5`（默认 10），`workerStatusTtl >=10`（默认 45），`local/workerPush >=5`（默认 10），`operationEventMaxDelayMs >=100`（默认 200），`workerActionMinIntervalMs >=200`（默认 500）；`CONFIG_SCHEDULER_BOUNDS` 与 `package.json` 保持一致。
- 面板与扩展的网络/轮询仅通过 `127.0.0.1` 本机转发访问远端，禁止裸 IP 直连与 `scp/rsync` 旁路。
- 日志卡片环形缓冲 50、预览 20、`max-height 120px`，通过 `showLogHistory`/`openFullLog` 查看全量，禁止无限 `append` 导致布局塌陷。
