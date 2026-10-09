# 目标计划：Docker Codex 插件兼容改造

## 状态

- 目标 ID：`docker-codex-plugin-compat`。
- 状态：执行中，`docker-plugin-008` 已完成；现场兼容验收仍为 `needs experiment`。
- 范围：只改造 SimpleExperiment 与 SimpleSFTP；不创建 Docker 容器、不配置 VS Code Profile、不安装 VSIX。
- 启动条件：收到并校验计划 A 生成的 `plugin-handoff.json` 与 `PLUGIN-HANDOFF.md`，且两个插件仓库均无未归属改动。
- 验证状态：远程工作区、Windows 回归、双插件联调和 VSIX 安装均为 `needs experiment`。

## 目标

让运行在 Windows UI Extension Host 的 SimpleExperiment 与 SimpleSFTP 正确服务 Dev Container 工作区，同时保持现有 Windows 本地工作区、Xshell、Agent、SFTP、命令 ID 和配置项行为不变。

容器工作区 `/workspaces/<相对路径>` 必须映射到 Windows 宿主路径 `D:\GitRepo\<相对路径>`。插件内部文件系统、Xshell、PowerShell 和 SFTP 操作使用宿主路径；VS Code 编辑器定位文件时保留原始远程 workspace URI。

## 输入接口

计划 A 在 `C:\Users\ZLK\Documents\Codex\docker-dev` 提供：

- `plugin-handoff.json`
- `PLUGIN-HANDOFF.md`

`plugin-handoff.json` 固定契约：

```json
{
  "schemaVersion": 1,
  "containerName": "codex-linux-dev",
  "hostWorkspaceRoot": "D:\\GitRepo",
  "containerWorkspaceRoot": "/workspaces",
  "workspaceUriScheme": "vscode-remote",
  "extensionHosts": {
    "openai.chatgpt": "workspace",
    "simple-local.simple-experiment": "ui",
    "simple-local.simple-sftp": "ui"
  },
  "pathSettings": {
    "clusterHostRoot": "simpleExperiment.workspaceHostRoot",
    "clusterContainerRoot": "simpleExperiment.workspaceContainerRoot",
    "sftpHostRoot": "simpleSftp.workspaceHostRoot",
    "sftpContainerRoot": "simpleSftp.workspaceContainerRoot"
  }
}
```

输入校验失败时停止改造验收，不猜测路径或降级为容器内本地路径。
schemaVersion 1 的未知扩展字段允许保留但不参与插件决策；所有上述必需字段仍必须逐项匹配。

## 强制边界

- 两个插件必须在 Windows UI Extension Host 运行；运行时 `process.platform` 必须为 `win32`，扩展清单必须声明 UI extension kind。
- 只接受等于 `/workspaces` 或位于其下的规范化容器路径；拒绝 `..`、编码后穿越、不同根、盘符混入、UNC 注入和非 `/workspaces` 路径。
- 映射后的 Windows 路径必须等于宿主根或位于宿主根下；大小写、分隔符和尾部斜杠规范化后再次执行边界校验。
- Node `fs`、Xshell、PowerShell、SimpleSFTP 上传下载和 Agent 文件操作只使用 Windows 宿主路径。
- VS Code 打开、定位和比较工作区文件时保留原始 `vscode-remote` URI；不得用 `file:///D:/...` 替代远程编辑器 URI。
- SimpleExperiment 继续访问 Windows `127.0.0.1` 上的 Xshell 隧道；不得改为容器 localhost。
- 两个插件不得在 Docker 内启动 Xshell、读取 Windows 凭据、启动 SSH Server、建立额外 SSH 隧道或访问 Docker socket。
- 保留全部现有命令 ID、配置项、Xshell 入口、SimpleSFTP 入口和旧配置迁移行为。
- 未配置映射的普通 Windows 本地工作区必须保持当前行为；不能强制所有用户填写 Docker 路径设置。
- 多窗口过渡期间，隧道启动、调度、部署、上传、下载、归档和删除等有副作用操作只能由一个窗口持有宿主操作租约；只读状态页可并行打开。

## 路径契约

新增可选设置：

- `simpleExperiment.workspaceHostRoot`
- `simpleExperiment.workspaceContainerRoot`
- `simpleSftp.workspaceHostRoot`
- `simpleSftp.workspaceContainerRoot`

两个插件使用同一映射语义：

1. 本地 `file` 工作区继续使用 `workspaceFolder.uri.fsPath`。
2. `vscode-remote` 工作区先保留原始 URI，再将 URI 路径按配置映射为 Windows 宿主路径。
3. 所有项目名、相对文件和上传目标从规范化的相对路径派生，不从扩展进程 cwd 推断。
4. UI 同时展示远程工作区 URI 与即将用于副作用操作的 Windows 宿主路径。
5. 映射缺失、越界或不一致时，在路径强确认窗口之前阻断副作用，并给出具体配置项名称。

## 单窗口操作租约

- 使用两个插件都可访问的 Windows 用户级状态目录保存租约，不依赖 workspaceState 或容器文件。
- 租约至少包含插件 ID、窗口/进程标识、工作区 URI、宿主项目路径、动作类型、创建时间、心跳时间和过期时间。
- 获取使用原子排他创建或等价 Windows 文件锁；持有者定期续租，进程退出或租约过期后才允许接管。
- 只读检测不获取租约；隧道启动、调度、Agent 部署和 SFTP 文件操作必须先获取。
- UI 必须显示当前持有窗口和恢复方式；不得通过强制删除活动租约绕过保护。

## 实施批次

### docker-plugin-001 共享路径契约

- 在两个仓库分别增加纯路径映射模块、配置声明和单元测试。
- 覆盖 Windows 本地 URI、Dev Container URI、嵌套项目、分隔符、大小写、尾部斜杠和所有越界输入。
- 固定 URI 用于编辑器、宿主路径用于副作用的双路径模型。

### docker-plugin-002 SimpleExperiment 接入

- 将项目检测、Plan/结果文件读取、Agent runtime、PowerShell、Xshell 和路径确认接入宿主路径映射。
- 保持 Agent HTTP/realtime 访问 Windows `127.0.0.1`，验证不使用容器 localhost。
- 保留现有 Windows 工作区、命令 ID、设置、抽屉/三列布局和任务/结果生命周期。

验收记录：已完成。`npm test` 通过 644/644；远程工作区映射、Windows 宿主副作用路径、远程编辑器 URI 保留和结果文件远程打开均有本地自动化覆盖。Dev Container UI Host、Xshell `127.0.0.1` 联调仍为 `needs field verification`。

### docker-plugin-003 SimpleSFTP 接入

- 将工作区上传、文件上传、下载、忽略规则、共享目标和路径确认接入同一宿主路径语义。
- 验证容器编辑后的文件从 `D:\GitRepo` 对应位置上传，且编辑器仍打开远程 URI。
- 保留现有服务器配置、命令 ID、旧任务和 Windows 本地工作区行为。

验收记录：已完成。SimpleSFTP 提交 `bbaa528` 已同步 `origin/master`；`npm test` 通过 10/10。上传、下载、交接、忽略扫描和创建同步工作区均在副作用前显示本地宿主位置与远端预期位置；远程保存上传与项目文件打开保留映射语义。Dev Container 文件同字节上传仍为 `needs field verification`。

### docker-plugin-004a 共享租约协议

- 两个插件使用完全相同的 `%LOCALAPPDATA%\\SimpleExperiment\\host-operation-lease.json` 路径、schemaVersion 1 和字段语义。
- 采用排他创建；租约包含插件 ID、窗口标识、进程标识、工作区 URI、宿主项目路径、动作、创建时间、心跳时间和过期时间。
- 持有者通过心跳续租；崩溃只依靠过期接管；同一 UI Extension Host 内两个插件允许嵌套操作，共享同一个窗口租约。
- 已有本地自动化覆盖原子冲突、心跳、过期接管、崩溃恢复、同窗口嵌套和旧持有者不得影响新持有者。

验收记录：SimpleExperiment `npm test` 通过 650/650，其中共享租约测试 6 项；SimpleSFTP `npm test` 通过 15/15，其中共享租约测试 5 项。SimpleSFTP 提交 `b2e8b24` 已同步 `origin/master`；SimpleExperiment 模块随本批提交。未生成、安装或覆盖 VSIX。

### docker-plugin-004b 副作用入口接入

- 实现共享宿主操作租约并覆盖过期、崩溃恢复、只读并行和冲突阻断。
- 将租约接入两个插件的所有宿主副作用入口；只读状态获取不申请租约。
- SimpleExperiment 覆盖 Xshell 隧道启动、配置、Agent 准备与部署、Plan 调度、结果归档与删除、SFTP 编排、GitHub 操作和下载入口。
- SimpleSFTP 覆盖工作区创建、上传、下载、交接、忽略扫描和保存时自动上传；共享租约模块已加入 VSIX 文件清单。

验收记录：SimpleExperiment `npm test` 通过 652/652，提交 `308d293` 已同步 `origin/master`；SimpleSFTP `npm test` 通过 16/16，提交 `a62c321` 已同步 `origin/master`。两个插件均保留旧命令 ID，静态测试确认只读状态命令不申请租约。真实双窗口 UI 阻断仍为 `needs field verification`。

### docker-plugin-004c 多窗口与双插件联调

- 校验计划 A 输入接口，并运行两个独立插件模块对同一租约文件的真实互操作检查。
- 在一个 Dev Container 窗口同时验证 Codex、SimpleExperiment 和 SimpleSFTP 面板。
- 验证集群状态、调度和上传使用同一个宿主项目路径。

验收记录：已在本机同一 Node 进程加载两个插件的租约模块，验证跨窗口冲突、同窗口嵌套、跨插件释放，结果为 `passed`。修复两个插件心跳续租的截断写入竞态，SimpleExperiment 全量测试通过 `654/654`，租约压力测试通过 `10/10`，SimpleSFTP 回归测试通过 `17/17`，SimpleSFTP 修复提交 `95399bf` 已同步 `origin/master`。Docker daemon 恢复后，`Test-PlanA.ps1` 通过 root 模式结构检查，容器健康、挂载、无 Docker socket、无 SSH server、Codex、Node、Python、Git、GH、GPU 与 bwrap 检查均有本地输出；`D:\GitRepo\MCP\simple-experiment\README.md` 与容器 `/workspaces/MCP/simple-experiment/README.md` SHA256 一致。开发扩展窗口日志确认 SimpleExperiment 与 SimpleSFTP 均在 Windows UI Extension Host 激活，激活无异常。计划 A 的 `PLUGIN-HANDOFF.md` 与配置文件声明容器用户为 `root`，不满足原方案的非 root 约束，仍标记为 `needs experiment`；未进行 VSIX 安装、真实 SFTP 上传或 Xshell `127.0.0.1` 现场操作。

### docker-plugin-005 打包与交付

- 分别运行两个插件的 build、typecheck、lint、测试、Windows 回归、远程工作区测试和公开打包检查。
- 每个验证批次在对应仓库独立提交并普通快进推送 `origin/master`；禁止跨仓库混合提交或历史改写。
- 只把通过验收的两个 VSIX 与兼容结果写入 `plugin-drop`，不安装、不覆盖当前 Profile 插件。

验收记录：已把 SimpleExperiment 升级为 `0.2.1`、SimpleSFTP 升级为 `0.1.3`，版本提交 `98850e0`、`1445856` 已同步各自 `origin/master`，避免与本机已安装的 `0.2.0`、`0.1.2` 内容分叉但版本相同。已修复租约时间戳写入的 UTF-8 字节偏移问题，提交 `779b5f3`、`458c2b6` 已同步各自 `origin/master`；中文 `actionLabel` 回归覆盖通过。已在 `%TEMP%` 生成不覆盖现有安装的对照包；SimpleExperiment 包含 138 个归档项，SimpleSFTP 包含 8 个归档项，包内 manifest、package 版本与扩展 ID 均通过检查。SimpleExperiment 已排除恢复快照异常文件和 `dist/runtime/__pycache__`；相关修复提交 `3a3cdaf`、`f27bd4e` 已同步 `origin/master`。公开离线打包脚本已改为直接向全新版本目录生成两个 VSIX；目录已存在时立即失败，不再删除旧 VSIX、强制复制或覆盖 README；提交 `06e5730` 已同步 `origin/master`。`npm test` 通过 655/655，静态打包测试、lint、临时目录实际打包和重复路径拒绝检查均通过；产物仍只位于 `%TEMP%`，未安装。与本机已安装目录相比，新包新增宿主租约、工作区映射、GPU 历史和恢复计划文档；SimpleSFTP 新包包含 `host-operation-lease.js` 与 `workspace-path.js`。只读现场检查未发现 Xshell 进程或 `127.0.0.1` 监听端口，未执行上传、远端写入或隧道启动；未安装任何对照包，未写入 `plugin-drop`，真实 SFTP 上传、Xshell `127.0.0.1`、非 root 容器和最终兼容结果仍为 `needs experiment`。

### docker-plugin-006 跨平台共享工作区

- 两个仓库使用同一份 `* text=auto` Git 属性，避免 Windows 工作区换行导致 Docker Linux Git 误报源码修改。
- Windows 与容器分别检查状态、分支和关键文件；不改变源码语义，不安装或覆盖插件。

验收记录：当前宿主仓库状态干净；加入属性后，Docker 容器内原先 12 个仅换行差异的集群插件文件不再显示修改，SimpleSFTP 容器工作区状态保持干净。SimpleExperiment 提交 `2fb064e`、SimpleSFTP 提交 `57137db` 均已同步各自 `origin/master`。容器仍以 `root` 运行，属于计划 A 非 root 约束不满足的 `needs experiment`，不据此生成兼容通过结果。

### docker-plugin-007 交接契约校验

- 用本地校验器检查 `plugin-handoff.json` 与 `PLUGIN-HANDOFF.md` 的固定字段、宿主路径、远程根、扩展 Host、回环边界和 Xshell 边界。
- 结构错误返回 `failed`；root 或缺少运行用户信息返回 `needs_experiment`；只有无警告的非 root 输入才允许返回 `passed`。

验收记录：校验器单元测试通过，SimpleExperiment 全量测试通过 `659/659`，lint 通过，提交 `0a34572` 已同步 `origin/master`。对当前计划 A 文件的只读执行返回 `failed`：`PLUGIN-HANDOFF.md` 未明确包含 `vscode-remote` 与 `127.0.0.1`，且配置声明 `containerUser=root`。Plan A 结构检查通过，但 Live Codex 只读请求因外部接口返回 `401 Unauthorized` 失败，标记为 `needs_experiment`，不归因于插件。不得生成 `plugin-compat-result.json` 的通过状态；未修改计划 A 文件。

### docker-plugin-008 源码 manifest 清理

- 从两个源码 `package.json` 移除 VS Code 安装目录生成的 `__metadata`，避免恢复快照把本机安装时间和目录大小带入公开源码及 VSIX。
- 两个仓库增加回归断言，并重新验证 manifest、扩展 ID、版本、依赖和打包文件清单。

验收记录：Git 历史确认这些字段来自恢复快照首个提交，且与本机已安装扩展的 `__metadata` 完全一致。两个源码 manifest 已清除该字段并增加回归断言；SimpleExperiment `npm test` 通过 `659/659` 且 lint 通过，SimpleSFTP `npm test` 通过 `18/18`。临时目录重新打包后，SimpleExperiment VSIX 含 138 个归档项，SimpleSFTP VSIX 含 8 个归档项；包内扩展 ID、版本和显示名保持不变，均不含 `__metadata`。SimpleSFTP 提交 `91d9157` 已同步 `origin/master`；未安装或覆盖插件，未写入 `plugin-drop`。

## 输出接口

输出目录：

```text
C:\Users\ZLK\Documents\Codex\docker-dev\plugin-drop\
```

必须包含：

```text
simple-experiment-<version>.vsix
simple-sftp-<version>.vsix
plugin-compat-result.json
```

`plugin-compat-result.json` 固定契约：

```json
{
  "schemaVersion": 1,
  "status": "passed",
  "extensions": [
    {"id": "simple-local.simple-experiment", "extensionKind": "ui", "version": "<version>"},
    {"id": "simple-local.simple-sftp", "extensionKind": "ui", "version": "<version>"}
  ],
  "pathMappingTest": "passed",
  "windowsRegressionTest": "passed",
  "remoteWorkspaceTest": "passed"
}
```

任何测试未执行、失败或仅人工推断时，`status` 不得写为 `passed`，也不得生成伪造的通过结果。

## 验收矩阵

- Windows 本地单项目：所有原入口和路径行为不变。
- Dev Container 单项目：`/workspaces/<项目>` 正确映射到 `D:\GitRepo\<项目>`。
- 非法路径：穿越、越界、错误根和非远程工作区配置全部阻断。
- 编辑器 URI：打开文件继续使用 `vscode-remote` URI。
- SimpleSFTP：容器修改文件后从宿主路径上传同一字节内容。
- SimpleExperiment：继续通过 Windows Xshell 与 `127.0.0.1` 接收实时状态并执行控制。
- 多窗口：第二个窗口的副作用操作被租约阻断，只读状态仍可查看。
- 交付：两个 VSIX 与 JSON 版本、扩展 ID、extension kind 和测试结果一致。

## 完成条件

- 两个插件在 Dev Container 窗口显示于 Windows UI Extension Host，Codex 位于 Linux workspace host。
- 双路径模型、越界拒绝、Windows 回归、远程工作区和单窗口操作租约均有自动化测试。
- SimpleSFTP 上传文件与 `D:\GitRepo` 对应文件一致；SimpleExperiment 集群通信仍走 Windows Xshell 和 `127.0.0.1`。
- `plugin-compat-result.json` 的 `status` 及三个测试字段均为 `passed`，且有本地命令输出或测试报告证据。
- 产物仅写入 `plugin-drop`，未安装、未替换当前 Profile 中正在运行的插件。
