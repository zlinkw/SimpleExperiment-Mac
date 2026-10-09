# 运行环境准备单链融合计划

> 融合稿：服务器管理 + 发布同步两卡合一为运行环境准备单卡，旧两卡下线。本文件覆盖重写旧 14 项删运维内容，旧内容已全部替换，不再执行。
> 项目：`D:\GitRepo\MCP\zlk-cluster-orchestrator`｜权威实现：`src/ui/PanelHtml.legacy.ts`（15805行）／`src/extension/legacy.ts`（22521行）

## 0. 目标

- 服务器管理 + 发布同步两卡合一为**运行环境准备单卡**，旧两卡（服务器管理卡、发布同步卡）下线，仅保留单链镜像入口。
- 单卡承载三步链：部署 Agent → 上传（GitHub + 全服并行）→ 检测（端口 + 版本），状态显示 + 全绿自动跳转实验卡，失败停留本卡并报错。
- 后端 `data-command` 入口全部保留兼容（`src/extension/legacy.ts:4603-4626`、`4397-4453` 不删 case），仅前端收敛按钮；`TunnelFactory` 动态解析端点，禁 `10890` 硬编码；外层模板内零裸反斜杠（双写 `\\`）。

## 1. 30 问收敛表（需求 → 决策）

| # | 问 | 收敛决策 |
|---|---|---|
| 1 | 两卡并存是否造成入口重复？ | 是，合一为单卡，旧两卡下线 |
| 2 | 单卡名称？ | 运行环境准备 |
| 3 | 三步链是哪三步？ | ①连接 ②上传 ③就绪（见 §2） |
| 4 | 链首按钮调哪个后端？ | `prepareAgentsForFirstRun`，文案为“部署Agent” |
| 5 | `prepareAgents` 与 `deployLatestAgent` 关系？ | 合并语义：前台 `deployLatestAgentRuntime(false,true)` + 后台 `testTunnel(false)`，见 `legacy.ts:3589-3602` |
| 6 | 一键发布对应哪个命令？ | `publishGithub` 改名“一键上传到所有服务器”，后端不变 |
| 7 | 覆盖本机保留否？ | 保留 `overwriteGithub`，强确认（`data-danger`） |
| 8 | `syncGithub` 去留？ | 删除前端按钮，后端 `case syncGithub` 保留兼容 |
| 9 | `uploadHub/uploadWorkers` 去留？ | 删除前端按钮，合并入“一键上传到所有服务器”并行上传，后端保留 |
| 10 | `distributeCodeToWorkers` 去留？ | 删除前端按钮，合并入单键并行上传，后端保留 |
| 11 | `configureSftpIgnores` 去留？ | 移出单链，放设置折叠区，后端保留 |
| 12 | TensorBoard 行去留？ | 移出单链，放设置折叠区 |
| 13 | 校验版本入口去留？ | 移出单链，放设置折叠区（版本检测并入第③步自动执行） |
| 14 | 恢复布局去留？ | 移出单链，放设置折叠区 |
| 15 | 逐个隧道按钮去留？ | 删除，仅留“启动全部隧道”（`startAll`），后端 `startTunnelEndpoint` 保留 |
| 16 | 启动连接去留？ | `startAllConnections` 前端删除（工具条 7184-7187 + inspector），后端 case 保留兼容 |
| 17 | 单个检测去留？ | 删除，仅留“检测全部”（`testAll → testTunnel(true)`），后台静默 `testTunnel(false)` |
| 18 | 手动保存按钮去留？ | 前端删多余保存文案，改自动流转；后端 `save*FromUi` 全部保留 |
| 19 | 新增/删除服务器保留否？ | 保留（`addWorkerConfig`／`deleteWorkerConfig`），多服纵向列表 |
| 20 | 提交信息格式？ | 时间 + 任务名；无任务名用时间 + changed 文件列表回退，禁空提交（`timestampCommitMessage:22030`） |
| 21 | 空提交如何阻断？ | `gitRepositoryHasChanges` 为空跳过 commit；`assertNonEmptyCommitMessage` 抛错阻断 |
| 22 | 单链顺序？ | 部署Agent → 自动拉起 xshell 隧道 → 单键并行上传（github + 全服）→ 端口 + 版本检测 → 状态显示 + 全绿自动跳转实验卡（见 §3） |
| 23 | `sync` 节保留什么？ | 单链镜像容器 `syncChainOverview` + 2 上传按钮（改名后一键上传 + 覆盖本机），删 6 个被合并按钮 HTML |
| 24 | `renderServerChainOverview` 改为什么？ | 三步链速览（连接／上传／就绪），`serverSettingsCards` 顶部双写保持（`7088-7090`） |
| 25 | `collapsed` 默认？ | `sync:false`、`settings:false` 展开；`servers` 按后端 `false` 展开对齐（前端 4960 改 `servers:false`） |
| 26 | 多服如何展示？ | 纵向列表（`serverStack`），Hub + N Worker 依次排列，每卡保留新增／删除 |
| 27 | 失败行为？ | 停留本卡，`recordActionError + postState + showWarningMessage`，不跳转 |
| 28 | 全绿行为？ | 自动跳转实验卡（`bootstrapProjectFromUi`／`openPanel` 链路沿用 `prepareAgents:3611-3617`） |
| 29 | P0 外层模板？ | 零裸反斜杠，双写 `\\` 或 `String.fromCharCode(10)`，`build + vm.Script` 双门禁 |
| 30 | P0 端口？ | 禁 `10890` 硬编码，走 `TunnelFactory.resolveEndpointUrl()`，`Select-String 10890 src/** dist/**` 零命中 |

## 2. 三步链定义

```
[1 连接] 部署Agent（prepareAgentsForFirstRun）→ 自动拉起 xshell 隧道（startAllXshellConnections → launchTunnelItem）
  ↓ 成功继续，失败停留报错
[2 上传] 单键并行：publishGithub（GitHub 有 remote 走 syncToGitHub(false)，无 remote 走 gh repo create）+ 全服 SFTP 并行上传
        提交信息 = 时间 + 任务名（空任务名 → 时间 + changed 文件列表回退，禁空提交门禁）
  ↓ 成功继续，失败停留报错
[3 就绪] 端口 + 版本检测（testTunnel(true) 前台 / testTunnel(false) 后台）→ 状态显示（serverChainOverview 三段）→ 全绿自动跳转实验卡
```

- 三步链速览函数：`renderServerChainOverview:6877-6899`（连接／上传／就绪三段 + `data-chain-step`）。
- 双写保持：`renderServerCardsV2:7087-7090` 同时写 `syncChainOverview` 与 `serverSettingsCards`（`setHtmlIfChanged` 幂等）。
- `renderSyncSection:6897-6899` 仅做单链镜像，不再渲染旧 `renderActionSections`（已删除，见 `8353` 注释）。

## 3. 按钮去留矩阵

### 保留

| 按钮（新文案） | 命令 | 位置 |
|---|---|---|
| 一键上传到所有服务器（`publishGithub` 改名） | `publishGithub` | sync 节 + inspector sync 组 + tree |
| 从 GitHub 覆盖本机（强确认） | `overwriteGithub` | sync 节 + inspector sync 组 + tree |
| 部署Agent（调 `prepareAgentsForFirstRun`） | `prepareAgents` | servers 工具条链首 + inspector servers/settings/overview |
| 启动全部隧道 | `startAll` | servers 工具条 + inspector |
| 检测全部 | `testAll` | servers 工具条 + inspector |
| 新增服务器 | `addWorkerConfig` | servers 工具条／Worker 卡 |
| 删除服务器 | `deleteWorkerConfig` | Worker 卡 |

### 删除（前端删 HTML／inspector 项，后端 case 保留兼容）

| 按钮 | 命令 | 后端兼容位置 |
|---|---|---|
| 同步到 GitHub | `syncGithub` | `legacy.ts:4606-4608` 保留 |
| 首次上传到 Hub | `uploadProjectToHub` | `legacy.ts:4612-4614` 保留 |
| 首次上传到 Worker | `uploadProjectToWorkers` | `legacy.ts:4615-4617` 保留 |
| 分发代码到所有 Worker | `distributeCodeToWorkers` | `legacy.ts:4618-4620` 保留 |
| 逐个隧道 | `startTunnelEndpoint` | `legacy.ts:4397-4399,7393-7404` 保留 |
| 启动连接 | `startAllConnections` | `legacy.ts:4439-4441` 保留（前端工具条 7184-7187 + inspector 删除） |
| 单个检测 | `test` | `legacy.ts:4451-4453` 保留 |
| 手动保存（多余文案） | `save*` | `saveTopologyMode/Hub/Scheduler/Worker/RemoteRootPolicy FromUi:7144-7300,10127` 保留，改自动流转 |

### 移出（放设置折叠区，不在单链主路）

| 项 | 去向 |
|---|---|
| SFTP 忽略（`configureSftpIgnores`） | 设置折叠区，后端 `4624-4626` 保留 |
| TensorBoard 行（`renderTensorBoardLinkRow:7191`） | 设置折叠区 |
| 校验版本入口 | 设置折叠区（版本检测并入第③步自动执行） |
| 恢复布局（`resetUiLayout`） | 设置折叠区 |

## 4. 顺序（单链执行序）

1. **部署Agent** → 自动拉起 xshell 隧道（`prepareAgentsForFirstRun:3548-3630`：写 SFTP 画像 + 写 `.xsh` 自启动 + `startAllXshellConnections(false,false)` 前台，后台 `deployLatestAgentRuntime(false,true)` + `testTunnel(false)`）。
2. **单键并行上传** github + 全服（提交信息时间 + 任务名，非空门禁；无任务名用时间 + changed 文件列表回退，禁空提交）。
3. **端口 + 版本检测**（`testTunnel(true)` 前台强提示／后台 `false` 静默；`publishAgentReadiness:8359` 聚合版本状态）。
4. **状态显示 + 全绿自动跳转实验卡**（`renderServerChainOverview` 三段全就绪 → 沿用 `3611-3617 bootstrapProjectFromUi/openPanel`；失败停留本卡 `recordActionError + postState`）。

## 5. collapsed 联动

- `sync:false`、`settings:false`（展开），`servers:false`（按后端 `defaultUiLayout:266` 展开对齐，前端 `normalizeUiLayout:4960` 改 `servers:false`）。
- `diagnostics:true`、`gpu:true` 保持折叠；`execution:false` 保持展开；旧 `tasks/operations` 键清理不变（`4961-4967`）。
- `sectionIsCollapsed:3966` 与 `renderSectionIfVisible:2966-2984` 联动：折叠区跳过渲染，单链双写区（sync + settings）须同展开，否则单链只剩一半。

## 6. 多服纵向列表

- `renderServerCardsV2` 输出 `<div class="serverStack">` 纵向排列：拓扑卡 + Hub 卡（如参与）+ N Worker 卡，见 `7089-7091`。
- 每 Worker 卡保留新增／删除（`addWorkerConfig`／`deleteWorkerConfig:7060`）；单 Worker 密集卡（`renderSingleWorkerDenseCard:7105`）沿用纵向单列。
- 工具条位居列表底部：设置跳转 + 新增服务器 + 启动全部隧道 + 部署Agent + 检测全部（已删启动连接）。

## 7. 失败停留报错

- 任何一步失败：`recordActionError({command, message, suggestion}) + postState() + showWarningMessage`，停留本卡，不跳转（沿用 `prepareAgents:3604-3609` 后台失败路径与 `ensureSimpleSftpReadyForSetup` 的 `UiCommandCancelled` 透传）。
- SFTP 未就绪／拓扑未就绪／目标不完整均抛错阻断，不写 `.xsh`、不上传 runtime（见 `3550-3588` 门禁段）。
- 空提交阻断：无变更跳过 commit；空信息抛错（`assertNonEmptyCommitMessage`）。

## 8. 改动清单（给执行 + 审核定位）

```
1. src/ui/PanelHtml.legacy.ts:1203-1222 sync 节重写为单链镜像 + 2 上传按钮（删 6 按钮 HTML，后端 4603-4626 保留）
2. src/ui/PanelHtml.legacy.ts:6877-6899 renderServerChainOverview 重写三步链速览（连接/上传/就绪），7087-7090 双写保持
3. src/ui/PanelHtml.legacy.ts:1986 sync priority 补 overwriteGithub（8 项对齐）；5764-5774 tree、6161 inspector、4795-4829 help 文案同步改名“一键上传到所有服务器”
4. src/extension/legacy.ts:22029-22031 timestampCommitMessage 改时间 + 任务名 + changed 回退 + 空阻断；5754-5788 sync/publish 传 changed 文件列表
5. src/ui/PanelHtml.legacy.ts:7184-7187 工具条：prepareAgents 改文案“部署Agent”，删 startAllConnections 按钮；6154-6156 inspector 同删启动连接，后端 4439-4441 保留
6. src/ui/PanelHtml.legacy.ts:4960 collapsed servers:true→false（对齐后端 266 servers:false），sync/settings 保持 false 展开
7. P0：外层模板零裸反斜杠（双写 \\），禁 10890，走 TunnelFactory
```

## 9. 门禁（每次验证必跑）

1. `npm run build`（内置 `node -c dist/extension.js && node -c dist/ui/PanelHtml.js`，严禁跳过）。
2. `vm.Script` 校验：`node -e "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8'))"` 零异常。
3. `10890` 零命中：`Select-String -Pattern "10890" src/** dist/**` 业务零命中（仅允许 `docs/`／`AGENTS.md` 约束说明）。
4. 相关测试：sync／collapsed／commit-message／server-chain 相关用例全绿；工作区待审不提交（`git status` 保持待审态）。
