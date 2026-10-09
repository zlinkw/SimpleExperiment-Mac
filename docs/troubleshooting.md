# 故障排查

优先运行 `SimpleExperiment：打开面板` 后的“自检”。

常见状态：

- `Agent stale`：实时流心跳超时。插件会保留 last-known-good 数据。请部署最新版 runtime 或重启 Agent。
- `Hub offline`：Hub 本地隧道或 Agent 不可达。不会自动启动 Worker 扇出。
- `Worker degraded`：只有该 Worker 过期或离线，其他 Worker 继续工作。
- `Runtime outdated`：runtime manifest 或 hash 不一致。请运行“部署最新版 Agent 到全部服务器”。
- `Direct fallback disabled`：插件已禁用直接远端回退路径，所有访问必须走本机 Xshell 隧道。

需要定位问题时，运行“生成脱敏调试包”。调试包包含脱敏后的配置、诊断、操作记录、错误、审计日志尾部、runtime 状态、Agent 状态和自检结果，不包含实验产物或大日志。

## 远端执行（tmux / bash -lc / conda）专项坑

Agent、Scheduler、Worker 任务都通过 `tmux ... bash -lc "<script>"` 在远端运行。下列坑专门记录在此：
[bash -lc 远程执行踩坑记录](bash-lc-pitfalls.md)（conda 激活失败致会话自毁、嵌套双引号吞掉日志重定向、
tmux 继承 SERVER 环境、`>> log` 只重定向末条命令、Python 3.8 运行时兼容等）。改运行时模板前必读第 7 节自检清单。

---

## 运行进度（execution）与面板渲染踩坑

下列坑与面板 Webview（`src/ui/PanelHtml.ts`）的运行进度渲染、外层模板转义、vsix 安装路径相关，
记录在此防止再犯。改 Webview 模板或打包脚本前必读。

### 1. 外层模板转义：内层 JS 的 "\n" 被外层模板解释为换行 → Invalid token

**现象**：面板渲染失败，控制台报 `Invalid or unexpected token`，错误定位指向 `PanelHtml.ts` 外层
`return \`...<script>...\`` 模板内部某行的 JS 代码。

**根因**：`PanelHtml.ts` 最外层是模板字符串 `return \`...<script> ... </script>\``。模板字符串内层再写
JS 时，若直接裸写 `"\n"`（双引号包裹的反斜杠 n），外层模板会把它当作**真实换行符**解析，破坏内层
`<script>` 的语句结构，导致脚本出现非法 token。

**正确写法**（内层需要换行符时，不要裸写 `"\n"`，改用 `String.fromCharCode(10)` 或 `\\n` 双转义）：

```ts
const full = stack ? message + String.fromCharCode(10) + stack : message;
```

或在内层反引号/字符串中写成 `\\n`（两层转义，落盘后才变成真正的 `\n`）。判断标准：凡是拼进
`return \`...\`` 外层模板的内层脚本，换行字面量都不能以单引号/双引号内的单个 `"\n"` 出现。

相关代码：`src/ui/PanelHtml.ts:2526-2535`（catch 块已用 `String.fromCharCode(10)` 拼接 `message + stack`，
见 2529 行）。

### 2. payload 空指针：((op.payload || {}) && ...) 左半永远为真 → Cannot read properties of undefined

**现象**：渲染调度占位卡（`renderSchedulerPlaceholderCard`）时报
`Cannot read properties of undefined (reading 'logPath')`。

**根因**：原始写法 `const logPath = (op.payload || {}) && op.payload.logPath`。当 `op.payload` 为
`undefined` 时，左半 `(op.payload || {})` 求值为 `{}`（真值），短路运算继续向右取
`op.payload.logPath`，即 `undefined.logPath`，直接抛错。

**正确写法**（让左半在 `op.payload` 为空时整体为假，用 `op.payload &&` 短路）：

```ts
const logPath = String((op.logPath || (op.payload && op.payload.logPath)) || "").trim();
```

或最小修复：`((op.payload || {}) && op.payload.logPath)` → `(op.payload && op.payload.logPath)`。

相关代码：`src/ui/PanelHtml.ts:9501`。

### 3. VSIX 安装路径与运行中版本不一致

**现象**：在 `MultiModal` 目录执行 `code --install-extension simple-experiment-*.vsix` 报
`ENOENT: no such file or directory`（找不到 vsix）。

**根因**：`code --install-extension <path>` 以**当前终端工作目录**解析相对路径；在 `MultiModal` 等错误目录
执行时，该目录下不存在 `simple-experiment-*.vsix`，于是 file not found。

**正确做法**：开发发布先运行 `npm run package`，再单独运行 `npm run install:latest`。安装脚本从仓库根目录定位 VSIX；它会查询已安装版本，同版本输出“已安装，跳过重复安装”，旧版本只安装一次并验证结果，较新版本则拒绝降级。不要使用 `--force` 重装同一版本。

VS Code 扩展安装会改写磁盘目录，而已运行的 Extension Host 仍保留旧代码。若运行版本与已安装版本不一致，面板显示“SimpleExperiment 已更新”和两个版本号，并提供 **重载窗口**。这是等待窗口重载的安全状态，不要继续操作旧面板。

如果安装过程中 Webview 心跳失败，插件会写入有限的 `panelLifecycle` 诊断，记录运行/已安装版本、文档与视图代次、可见性及恢复原因；同版本普通 Webview 故障仍使用常规恢复页。

### 4. 外层模板剥离坑（P0）：26 处正则 `\` 被外层 ``return `...<script>...` `` 吞噬 → 握手超时 `Unexpected token const`

**严禁** 在 `src/ui/PanelHtml.ts` 最外层 `return `...<script>...</script>`` 模板字符串内部裸写单反斜杠正则/字符串。

**现象**：
- 面板打开后长时间白屏，握手超时；DevTools 控制台报 `Unexpected token 'const'` / `Invalid or unexpected token`，堆栈指向内层 `<script>` 顶部。
- 实际是 26 处正则（如 `/\s+/` `/\d+/` `/\./` `/\//` `/\{/` `/\}/` `/\(/` 等）与 `"\n"` 字符串在外层模板解析阶段被吞噬，落盘后变为 `/s+/` `/d+/` 非法语法，导致整个 Webview 脚本解析失败、握手回调永不注册。

**根因**：
- `PanelHtml.ts` 最外层是 JS 模板字符串 `` return `<!doctype ...><script> ... </script>` ``。
- JS 模板字符串会先对内容做转义预处理：`\s`→`s`（`\s` 非合法转义被剥掉 `\`）、`\n`→真实换行、`\.`→`.`、`\/`→`/`。内层脚本写入的正则/字符串经此一层剥离后已与源码不一致。
- 例如源码写 `const re = /\s+/`，落盘后变为 `const re = /s+/`；源码写 `"\n"`，落盘后变为真实换行把语句切断。

**正确写法（二选一，择一即合规）**：

1. **双写转义（推荐用于正则）**：内层脚本中所有 `\` 都写成 `\\`，经外层剥离一层后恰好还原。
   ```ts
   // 源码（PanelHtml.ts 内层脚本）应写：
   const ws = /\\s+/;
   const date = /\\d{4}-\\d{2}-\\d{2}/;
   const dot = /\\./;
   const slash = /\\//;
   const nl = "\\n"; // 或 "\\t"
   // 落盘后还原为 /\s+/ /\d{4}-\d{2}-\d{2}/ /\./ /\// "\n"
   ```

2. **`String.fromCharCode` 规避（推荐用于换行拼接）**：已有先例 `PanelHtml.ts:2529`
   ```ts
   // 严禁： message + "\n" + stack   // 会被外层模板展开为真实换行
   // 正确：
   const full = stack ? message + String.fromCharCode(10) + stack : message;
   ```

**门禁（提交前必跑，双重校验缺一不可）**：
1. `npm run build` 内置语法门禁：`node -c dist/extension.js && node -c dist/ui/PanelHtml.js`（见 `package.json#scripts.build`），**严禁** 跳过 build 直接提交。
2. `vm.Script` 二次校验（捕捉 `node -c` 漏过的模板剥离后语法断裂）：
   ```powershell
   node -e "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8'))"
   ```
   必须零异常退出；任一失败即视为 P0 回归。

**自检清单**：
- [ ] 全局搜索外层模板区间内的 `/\` 与 `"\`，确认无裸 `\s` `\d` `\w` `\.` `\/` `\{` `\}` `\(` `\)` `\n` `\t`
- [ ] `npm run build` 通过
- [ ] `node -c dist/ui/PanelHtml.js` 通过
- [ ] `vm.Script` 校验通过

相关代码：`src/ui/PanelHtml.ts` 全文件（外层 `return `...``）；修复对照 `PanelHtml.ts:2529`（`String.fromCharCode(10)` 正确示例）。

> 交叉引用：`docs/bash-lc-pitfalls.md` 亦强调脚本拼装时的转义剥离风险；`AGENTS.md#红线约束-P0` 为提交强约束。

### 5. 禁止硬编码隧道端口-P0：`10890`/`127.0.0.1:18765` 写死导致隧道不可用与校验无回调

**严禁** 在业务逻辑中硬编码 `10890` 或假设 `127.0.0.1:18765` 为唯一 Agent 地址。隧道由用户每服务器通过 Xshell/SSH 配置（`*.xsh`、`~/.ssh/config`、`settings.json` per-server host/port/forward）动态决定。

**现象**：
- 用户自定义隧道端口（如非 18765）时，写死 `127.0.0.1:18765` 导致 `校验 Agent 版本` 点击无反应（`worker_telemetry` 模式下 `/health` vs `/api/health` 路径不一致，前端无回调）。
- 写死 `10890` 导致部分机器隧道检测失效；GPU tmux 窗口 `无法打开`，job 调度静默失败（`ModuleNotFoundError: torch` 未回传到 UI，任务列表 `pending` 无报错）。

**正确做法**（见 `AGENTS.md#P0`）：
1. 所有探活/校验/版本比对读取 `XshellRealtimeTunnelConfig`/`TunnelEndpointPortAssignment` 的 `localForwardHost/localForwardPort` 与 `remoteAgentHost/remoteAgentPort`，动态拼装 `http://${host}:${port}`，不得回退到固定端口检测。
2. `TunnelGateway`/`XshellTunnelSetup` 不得 `throw` 限制只能 `127.0.0.1`；`XshellTunnelPortProbe` 的 `base` 与 `tcpOpen` 必须用 `resolveProbeHost(config)` 动态 host，健康探测走 `fetchHealthWithFallback`（`/api/health` → `/health` → `/api/version` 兼容降级）。
3. Agent 侧：`/health` 与 `/api/health`（以及 `/version`/`/api/version`）互为别名；`worker_telemetry` 白名单必须包含健康与版本接口，否则前端校验 404 无回调。

**门禁**：`Select-String -Pattern "10890"` 在 `src/**`/`dist/**` 业务逻辑零命中；`npm run build` 与 `vm.Script` 双重校验通过。

相关代码：`src/tunnel/XshellTunnelPortProbe.ts`（`resolveProbeBase/fetchHealthWithFallback`）、`src/tunnel/TunnelGateway.ts`（`normalizeHost/localBaseUrl`）、`src/tunnel/XshellTunnelSetup.ts`（动态 host）、`src/extension.ts#verifyDeployedAgentRuntime`（动态 `base` + 兼容降级）、`src/clusterAgentRuntime.ts`（`route in ("/api/health","/health")` 与 worker_telemetry 白名单）。

> 交叉引用：`AGENTS.md#P0 — 禁止硬编码隧道端口/IP`、`docs/adr/003-tunnel-dynamic-endpoint.md`。

### 6. GPU 空闲判定与调度容量（P1–P4/Q3/P7）

- **判忙统一（三端镜像）**：`util < 5% 且显存 < 200MB` 为空闲，任一 ≥ 阈值即忙；每服务器 `gpuIdleUtilThreshold/gpuIdleMemThresholdMb` 覆盖，全局默认 5%/200MB；字段缺失回退进程数（`processes/procs/processCount`）。
- **capacity=auto**：`maxConcurrentGpus` 空/`auto`/0 表示占用全部显卡（=总数）；显式值 clamp `1..总数`；总数 0 则 cap 0；存量显式 `1` 保留为显式。
- **reason 四值**：`可用 / 目前无空卡 / 暂无显卡数据 / GPU查询失败`；`gpuError/totalGpus/capacitySource` 随可用性透传，`write_availability_batch` 保留。
- **调度探活 5 步**：缺失 → 硬错（`GPU_QUERY_FAILED`）→ stale → 零卡 → 重算（`gpu_is_busy`）；`allowed_gpu_ids` 分支已删除；`dispatch_probe` 有界 MAX200（`_record_probe`），快探（5s 短睡前探）不记入。
- **熔断（P4）**：仅 `GPU_QUERY_FAILED`/`probe_error` 硬错计数，全员硬错连续 2 轮才 fail 整队，否则清零；TTL/stale/无空卡仅换人不失败（Q3：TTL 默认 180s 仅换人）。
- **热加载（P7）**：`reload_worker_runtime_config()` 重读阈值/TTL；`control.json` 写入 `{"action":"config_updated"}` 触发调度器不中断重载。
- **面板**：Worker 表单无“允许 GPU”输入；`并发占卡上限(auto=全部)` 为文本框（`auto`/空/0=全部，min 0）；GPU 状态四态着色（可用 ok / 目前无空卡 warn / 暂无显卡数据 warn / GPU查询失败 error）；P0 禁止裸斜杠（`\\s` 等双写）。
- **门禁**：`npm run build` + `node -c dist/extension.js && node -c dist/ui/PanelHtml.js` + `vm.Script` 零异常。
# Plan 调度与重连状态（0.5.182）

全局配置中的 Plan 调度模式只影响新提交的 Plan；已提交的 Plan 保存自己的模式。

- **本机按空卡派发（默认）**：未发现可用空卡时，job 留在本机队列，不提前绑定服务器。派发前 Agent 再次检查指定 GPU；明确拒收后可选择其他空卡。断联时未派发任务等待本机重连，已接收任务继续由服务器执行。
- **预派发到服务器队列**：按每台服务器的空卡数和本人占用的 GPU 数计算比例，每张 GPU 只计一次，其他用户及混合占用不增加份额。任务进入各 Agent 的持久队列，按服务器本地 GPU 策略等待运行。关机前确认卡片显示“已托管，可关机”；未确认的回执仍保留原 commandId，不盲目重复提交。

运行进度独立于派发与产物操作，每 2 秒读取各服务器任务快照。超过 5 秒没有可信快照或读取失败时，活动任务显示“待核实”，保留所有者及身份；恢复连接后合并所有服务器的最新状态。GPU 没有进程不等于任务成功，最终状态以 Agent 的任务记录为准。网络中断无法保证即时更新，但不会把旧的运行状态当成新证据。

此状态刷新不下载指标、权重或产物；结果下载及汇总仍由用户手动触发。服务器需更新到配套 Agent，支持持久队列及空卡接收校验。

## 预派发任务召回到本机队列

0.5.183 支持在运行进度中召回整个 Plan 或单个排队 job。插件先持久化召回意图，服务器 Agent 核实原任务身份及未启动证明并释放队列后，才创建保留历史的新 attempt，由本机检测空卡派发。运行中、已结束、身份不完整或离线任务保留原归属，不会停止进程或删除产物。断联后重放同一操作身份；部分成功立即保存，失败条目继续显示。

历史版本的排队记录支持 plan/caseName 别名及旧结果目录。服务器 Agent 必须更新到提供 queuedJobRecall 能力的版本；仅更新本机插件不足以安全召回旧 Agent 队列。没有可信未启动证据的历史记录不会自动重派。结果文件同步仍仅由用户手动触发。

## 已消失的 job 窗格阻止中止并清理

0.5.254 修复任务退出或用户先关闭窗格后，精确停止仍因旧 pane ID 不存在而报“tmux 标签未确认关闭”的问题。停止前读取完整 tmux pane 清单并校验任务所属会话；可信清单确认窗格已消失时返回 `paneClosed: true` 和 `paneAlreadyMissing: true`。实际关闭后再次读取清单确认消失，重复停止保持幂等。查询失败、超时、清单格式异常、身份不匹配或窗格仍存在时保留原记录并报告具体原因。

本机仍要求完整 job 身份与停止后的可信终态快照，保持两次确认；不会通过结束共享 GPU 会话来绕过失败。此修复位于 Worker Agent，更新本机插件并重载窗口后，还需更新对应 Worker Agent，随后重试原 Plan 的“终止并清理”。

0.5.255 补齐项目级停止回执的 `projectId`、`codeFingerprint` 与全部持久 job 身份及 `planJobCount`。0.5.254 虽能确认旧窗格已消失，但回执遗漏项目和代码指纹，本机仍会拒收并显示 `stopped=0 matched=1`。新回执只从可信任务快照取值，不借用停止请求补身份；Agent 同时校验项目级完整身份。本机把“Agent 停止失败”和“成功回执身份缺失”分别报告。回归覆盖真实 Python 回执序列化、本机身份校验、后续终态查询和队列清除，不只检查 Agent 返回 `completed`。

0.5.256 修复清理提示成功后卡片又变成“待核实”的问题。远端终态任务作为审计记录继续保留；本机在清除队列的同一次持久化写入中记录完整 job 身份，后续刷新和冷启动恢复不再收录这些已确认清除的终态记录。标记绑定项目、workflow、Plan 路径及 revision、代码指纹、作业序号、case、seed、attempt、Worker、commandId、runKey 和 outputDir，并覆盖已核实的历史重试。未确认条目、活动或待核实回执、新运行和不同身份仍保持可见，部分清理不会把已确认清除的序号再次算作缺失。此修复在本机，0.5.255 Worker Agent 可继续使用；重载本机扩展后，对此前恢复回来的卡片再执行一次原有的两次确认清理。

## TMUX 总览出现旧窗口与日志读取（0.5.257）

总览的窗口来自服务器当前 tmux 清单，未绑定任务的旧 `run-*` 窗口可能仍存在于服务器，并不是本机保存的历史标签正文。清理任务标签只关闭已核实身份的目标，不按窗口名称猜测归属。总览将这些窗口和基础控制台默认折叠为“其他服务器窗口”，用户仍可展开并选择明确目标查看。

总览与空闲 GPU 只刷新窗口元信息，不读取任何窗格历史。读取日志只针对当前选中的、仍存在的任务窗口或明确窗格；窗口消失后不会回退到基础控制台或另一旧窗口。返回总览立即释放显示中的旧日志，迟到回包不能恢复正文。本机只持久化所选 Worker 和目标等界面状态，窗口清单在内存中按最新快照替换，捕获正文不落盘。

## 关闭标签后的实际窗口确认（0.5.258）

折叠旧窗口不能替代服务器上的实际关闭。总览中的历史窗口即使已失去任务快照，也提供单独的关闭按钮；确认框展示 Worker、窗口名称与稳定身份。批量清理仍仅针对已核实的任务窗口，不按 `run-*` 名称自动清理。

关闭请求在确认前冻结窗口 ID 与 pane ID，执行时重新核实名称和窗格，Agent 使用 `@window_id` 关闭。关闭后以原 ID 消失作为成功证据，不用可能重新编号的 `session:index` 判断。连接断开或超时后只读取新清单核实，不能对旧编号自动重复执行关闭。列表失败或不完整不构成窗口已消失的证据，失败保留并报告具体原因。

本机和 Worker Agent 均需更新到 0.5.258；旧 Agent 未提供窗口 ID 时关闭入口明确要求更新，不继续执行。历史窗口此前为何没有关闭，必须结合当时的真实回执核实，不能仅凭当前窗口清单判定。

## 分布式 PLAN 模式与已有训练恢复

0.5.259 将校验返回的 `validation.execution_mode` 保存为队列的 `executionMode`。派发、手动重试、自动重试及跨 Worker 重分配都使用该值；Worker 按原 PLAN 的 SHA256 revision 再核验一次。`train` 不进入测试阶段，`test` 不进入训练阶段。

旧队列缺少模式时，只从内容哈希与原 revision 完全相同的 PLAN 恢复，或使用新版 Worker 的明确模式回执。原 PLAN 不可核实时暂停新派发。已运行进程保留原命令，不自动停止或重训。旧 Worker 已接收但未启动的条目，在更新 Agent 后按原 PLAN 修正模式；正在运行的旧命令不能通过修改队列改变阶段。

对于 `train` 作业训练已完成、却被旧插件误调用测试并触发 `Validation-only tuning cannot access test patients` 的情况，失败行提供“核验并恢复训练完成”。更新对应 Worker Agent 后点击该按钮，插件只读核验同一 workflow、attempt、command、Worker、目录的 checkpoint 索引、最终配置及其快照，以及 adapter 输出的有限 `val/p100_low` 指标。adapter 必须声明 `selection_only=true`、`test_accessed=false`，指标必须来自 `p100_validation_checkpoint`。这份证据依赖项目 adapter 在导出时已核验 checkpoint 选优信息及配置一致性，插件不会加载任意 pickle 权重。

核验通过后，确认具体目标才记录训练完成。原始失败、退出码与执行模式保存在 `originalExecution`；文件 SHA256 保存在 `trainingRecovery`。该操作不启动训练或测试，不写 checkpoint、配置或指标文件，不将验证指标改成测试指标。文件缺失、身份或配置不符、指标来源不明时拒绝恢复，保留失败记录。其他错误需要独立核验，不能只凭 checkpoint 存在认定训练成功。
