# SimpleExperiment Mac

SimpleExperiment Mac 在 Apple Silicon Mac 的 VS Code 中管理 Linux GPU 实验服务器，配套 SimpleSFTP Mac 传输文件。两个 Mac 扩展与 Windows 原版使用独立仓库、身份、设置、数据目录和更新源。

**当前为 preview 测试版；M5 真机更新及完整科研业务尚未验收。** 已提供 Mac 安装、配套更新、Termius 手动端点、项目与 Agent 准备、SimpleSFTP 独立认证、跨服务器本机流式中转及主题适配。以上通过本地验证，真实服务器与真机断连恢复仍待验收。

## 系统要求

- Apple Silicon、macOS 26 及以上，VS Code 1.100.0 及以上。
- 目标验收设备为 M5、24 GB、macOS 27.0。
- 科研业务使用 Linux、Python 3、tmux；运行 Plan 的 Python 环境需要 PyYAML。
- 首版不支持 Intel Mac、Dev Containers 或 PPT 自动绘图。

## 首次安装

全部安装包统一放在 [SimpleExperiment Mac Releases](https://github.com/zlinkw/SimpleExperiment-Mac/releases)，只有 preview 通道，公开下载无需 GitHub 登录。

1. 选择同一个 preview Release，下载两个以 `darwin-arm64.vsix` 结尾的附件。`release.json` 记录配套版本、两仓源码提交、大小和 SHA-256。
2. 在 VS Code 按 **⇧⌘P** 打开命令面板，运行 **Extensions: Install from VSIX…**，先安装 `simple-sftp-mac-<版本>-darwin-arm64.vsix`。
3. 再用同一命令安装 `simple-experiment-mac-<版本>-darwin-arm64.vsix`。
4. 运行 **Developer: Reload Window**。
5. 在扩展列表确认身份为 `simple-local.simple-sftp-mac` 和 `simple-local.simple-experiment-mac`。

首次安装与检查更新不需要服务器、Termius 隧道或成功加载业务面板。此后优先在插件内更新。

## 在 Mac 上配置

1. 在 VS Code 菜单 **File → Open Folder…** 打开本机项目，每个窗口只打开一个项目。路径使用 `/Users/实际用户名/Projects/项目名`，保留中文、空格和大小写。
2. 按 **⇧⌘P** 运行 **SimpleExperiment：打开面板**，点击顶部 **配置说明**；也可直接运行 **SimpleExperiment：打开配置说明**，阅读随插件打包的 [Mac 配置说明](docs/simple-experiment-setup.md)。
3. 按 **⌘,** 打开设置，搜索 `simpleSftpMac`。填写真实的 `localBase` 本机项目父目录和 `remoteBase` Linux 项目父目录，首次配置可关闭 `uploadOnSave`，先核对目标再手动上传。设置中使用绝对 POSIX 路径，不使用盘符、`~` 或 `$HOME` 占位。
4. 运行 **SimpleSFTP：打开共享服务器配置**，填写真实主机、账号、SSH 端口和路径，保存后 **选择服务器**、**查看当前目标**。格式及操作见 [SimpleSFTP Mac README](https://github.com/zlinkw/SimpleSFTP-Mac/blob/master/readme.md)。SSH 端口与 Agent 转发端口分别配置。
   再运行 **SimpleSFTP Mac：配置服务器认证**，为每个目标选择密钥、ssh-agent、密码或系统 SSH 配置。默认只在本次会话记忆；只有勾选 SecretStorage 选项才保存密码/私钥口令。Termius 的登录凭据不由插件读取。
5. 在 Termius 手动登录 Linux 并启动本地端口转发，每个启用端点使用独立本机监听端口。在面板 **设置 → 服务器 → 配置手动端点**，或 **⇧⌘P → SimpleExperiment Mac：配置 Termius 手动端点**，打开 `simpleExperimentMac.tunnel.manualEndpoints` 设置。数组需在 **用户设置 JSON** 中编辑；[配置说明第 5 节](docs/simple-experiment-setup.md#5-termius-手动隧道与端点配置) 提供可替换的完整示例和字段对照。
6. 在当前项目选择并 **保存拓扑**：单 Worker、多 Worker 或 Hub/Worker。点击 **设置 → 服务器 → 准备项目与 Agent**，或运行 **SimpleExperiment Mac：准备项目与 Agent（手动启动）**。确认每台服务器的 SSH 地址、项目目录与 runtime 目录后，点击 **确认上传并查看指引**；SimpleSFTP 分别认证并上传，取消不会上传。此步不要求 Agent 隧道已在线。
7. 在打开的指引中核对每台服务器，在对应 Termius 终端接入已有 tmux，或创建缺少的会话并手动启动 Agent；保持端口转发，再点击插件 **检测全部**。已有 Agent/实验不因上传而自动重启。只需查看命令时点击 **Agent/tmux 指引**，这个入口仅生成文本。

版本/哈希检查在 Mac 只读：不一致或不可达会明确阻止就绪判定，不自动上传 runtime、重启会话或停止实验。需要更新 Agent 时先核对运行中的任务，主动使用 **准备项目与 Agent** 确认上传，再在 Termius 手动处理 Agent。

配置说明包含单 Worker、多 Worker、Hub/Worker 的接入约定、数据目录及失败处理，并标明尚待交付的功能。打开 Mac 配置说明不会触发旧 Xshell 会话向导。

项目父目录、runtime、Python 环境和 SFTP 目标使用单根绝对 POSIX 路径。两插件保留目录名的中文、大小写及首尾空格，不解码字面 `%20`；禁止 `.`、`..`、反斜杠和控制字符。远端 `/Data/项目` 与 `/data/项目` 是不同目标，允许/禁止目录策略同样区分大小写。确认对话框里的完整路径必须与实际目录一致；不要删去目录名末尾真实存在的空格。非法策略行会拒绝保存，详见 [路径配置](docs/simple-experiment-setup.md#3-本机工作区与路径配置)。

SimpleSFTP Mac 的上传清单、Worker 相对文件路径及映射下载保留中文、大小写、Unicode 拼写和文件名首尾空格。相对路径不得包含绝对路径、`..`/`.` 路径段、内部空路径段、反斜杠、冒号或控制字符。全部上传条目先通过校验再开始 SSH/tar；远端 `Model/a.json` 与 `model/a.json` 可分别映射到 `upper.json`、`lower.json`。本机映射仍拒绝只差大小写的目标名，避免默认磁盘上的别名覆盖。上述规则通过本地 tar/Python 协议及 Mac 模拟入口验证；CLI 继续分批适配，M5 验收仍待执行。

限制手动下载范围：按 **⇧⌘P → SimpleSFTP：设置下载文件范围**，核对目标后添加项目内文件夹/文件，再查看已选路径并运行 **远端同步到本地**。文件名保留中文和真实空格，空字符串/坏路径不会隐式扩为项目根；手动明确选择根目录和原有未配置范围的整项目入口保留。API `sync.downloadPaths` 只接受具体相对路径，拒绝整个项目根目录别名。操作与本地验证边界见 [Mac 配置说明](docs/simple-experiment-setup.md#3-本机工作区与路径配置)。

在 Finder 按 **⇧⌘G** 可打开下文的 Application Support 目录。若需要终端中的 `code` 命令，在命令面板运行 **Shell Command: Install 'code' command in PATH** 后重新打开终端；见 [VS Code 官方 Mac 说明](https://code.visualstudio.com/docs/setup/mac)。安装 VSIX 不要求该命令。

## 更新按钮在哪里

| 入口 | 操作 |
| --- | --- |
| **VS Code 底部右侧状态栏** | 点击 **Mac preview：…**，立即手动检查两组件。业务面板启动失败时此入口仍保留。 |
| **命令面板 ⇧⌘P** | 运行 **SimpleExperiment Mac：检查 preview 配套更新**。 |
| **SimpleExperiment 面板 → 设置** | 在 **插件配套更新** 一行点击 **检查更新**，发现新版后点击 **更新并重载**。 |
| **SimpleSFTP Mac 命令面板** | 运行 **SimpleSFTP Mac：检查 preview 配套更新**，交由 SimpleExperiment Mac 检查。 |

发现新版本时点击通知中的 **更新并重载**。同一版本只主动提醒一次；关闭通知后，运行 **SimpleExperiment Mac：安装 preview 配套更新** 即可继续。

插件启动后检查一次，此后每 30 分钟检查。更新源只使用本仓库 Releases 的有效 preview 预发布，不连接 Windows 原版或 zlinkw.shop。

### 更新过程与失败处理

1. 阻止新的本地业务操作，等待已有本地传输及子进程完成；不会停止远端实验。
2. 下载全部待更新包，校验 SHA-256、大小、真实扩展身份、版本、darwin-arm64 平台及 VS Code 要求。
3. 按 **SimpleSFTP Mac → SimpleExperiment Mac** 安装，相同或更高的已安装版本跳过，不自动降级。
4. 重载窗口，核对两插件版本和原有 Mac 设置。

**检查失败** 表示网络、限流或有效清单读取失败，不代表已是最新。网络恢复后手动检查。部分安装失败会列出已完成与待完成组件；选择 **重载后补装**，重载后只补装剩余组件。混合版本期间暂不接受新业务操作。

## 科研使用与适配边界

保留 `single_worker`、`worker_pool`、`hub_worker` 三种拓扑和完整科研流程，真机验收仍待完成。

接入顺序为：插件保存端点与项目父目录 → 配置 SimpleSFTP 独立认证 → **准备项目与 Agent** 并确认上传 → 在 Termius 手动启动转发与 Agent/tmux → **检测全部** → 校验、预演并运行 Plan → 监控 → 收集结果。项目与 runtime 上传成功不等于 Agent 已就绪；检测还需验证实际版本、路径和能力。完整科研主流程仍在适配，尚未真机验收。“Agent/tmux 指引”仅生成文本；旧自动启动入口引导至手动指引，不能代替 Termius 登录和转发。

远端项目为 `<用户配置的项目父目录>/<工作区名称>`。Plan 位于 `experiments/plans/`；官方运行必须依次调用 `validatePlan`、`dryRunPlan`、`runPlan`，不直接运行 train.py。API 方法和 Plan 格式沿用原契约，文件传输交给 SimpleSFTP Mac。永久删除要求精确路径、直接父目录核验和两次确认。

Mac 跨服务器产物传输默认分别认证来源/目标，经本机内存管道中转普通 tar 或大文件断点分块，无需两台服务器互相免密登录。传输前后核对 SHA-256；断连后的远端接收结果不明时，先完成恢复核验再补传。详细操作见 [SimpleSFTP Mac README](https://github.com/zlinkw/SimpleSFTP-Mac/blob/master/readme.md)。当前仅本地模拟/协议测试通过，真实传输仍待 M5 验收。

设置使用 `simpleExperimentMac.*` 和 `simpleSftpMac.*`，不会自动导入 Windows 原版扩展数据库。

## 数据目录与 API

| 内容 | Mac 位置 |
| --- | --- |
| Experiment API 发现文件 | `~/Library/Application Support/SimpleExperimentMac/api.json` |
| SFTP API 发现文件 | `~/Library/Application Support/SimpleSFTPMac/api.json` |
| 共享服务器配置 | `~/Library/Application Support/SimpleSFTPMac/server-profiles/servers.json` |
| 两插件共享租约 | `~/Library/Application Support/SimpleLocalMac/SimpleExperiment/` |

CLI 为 `simpleex-mac`、`simple-sftp-mac-api`。VSIX 在受支持 Mac 激活时生成固定入口，更新并重载后指向当前包；终端需有 **Node.js 20 或以上**。按 **⇧⌘P → SimpleExperiment Mac：查看 CLI 入口**，或 **SimpleSFTP Mac：查看 CLI 入口**，点击 **复制自检命令** 后在终端执行。自检只检查 CLI、发现文件和本机 API 监听，不代表远端实验已就绪。

```sh
"$HOME/Library/Application Support/SimpleExperimentMac/cli/simpleex-mac" self-check
"$HOME/Library/Application Support/SimpleSFTPMac/cli/simple-sftp-mac-api" self-check
```

固定入口保留当前终端的工作目录、中文/空格参数和旧 npm 入口，不自动修改 PATH。用户可自行把上述两个 `cli` 目录加入终端 PATH，再直接使用命令名；更新后无需重设路径。找不到 Node 时先配置终端 Node；若发现文件或监听缺失，打开 VS Code 并确认对应扩展已激活。每次业务 API 调用前读取当前发现文件和 `/api/v1/capabilities` 或 `/api/v1/openapi.json`，不要猜地址、token 和参数。固定入口与自检通过本地 shell/Node/API 模拟验证；CLI 业务命令和 M5 仍在后续验收。

两款 CLI 的业务 RPC 已自动读取当前 Mac 发现文件并检查 `/api/v1/capabilities`。未知方法、监听实例或版本变化、非本机地址以及错误响应会停止本次调用；不会自动重试业务或替用户补上确认参数。出现预检失败时，先打开对应 VS Code 扩展并重新自检，核对实时 API 契约与参数后再主动调用。直接使用 HTTP API 时仍需自行读取发现文件和实时契约。此预检通过本机监听与真实 CLI 测试，科研运行命令及 M5 验收继续分批。

正式 Plan 从项目终端使用 `simpleex-mac experiment run "experiments/plans/基线.yaml" --check --dry-run --json` 检查路线；VS Code API 工作区必须与终端项目一致，Plan 必须是项目内的真实文件。在线预检检查实时 `workflow.plan`，离线结果明确为 `validation: local_only`、`ready: false`，不能作为科研就绪证据。去掉 `--check --dry-run` 后才申请标准运行路线，并在 VS Code 人工确认。初始 `requested: true`、`submitted: false` 和 `waiting_confirmation` 表示已创建等待确认的本地操作；按返回的 `operationId` 通过实时 API `operations.list` 查看后续证据。CLI 不代替实际远端预演和提交证明；标准插件路线继续负责校验、预演、同步与提交。旧 `run --name … -- command` 仅为手工本地记录器，正式实验使用已保存的 Plan。真实科研仍待验收。

Mac 服务端也核对当前工作区的真实目录身份；准备、校验和提交期间切换项目或替换目录，会停止后续动作，需要回到正确项目重新预检。Plan 文件名保留真实首尾空格。发现活动 Plan 时会阻止重复提交；Mac 路线不会通过旧自动停止 fallback 中断已有实验，人工选择“停止并重新运行”仍需明确确认。

等待运行回执期间也保持当前项目；另一项目的活动操作不会被当作本次提交成功。人工重新运行和多 Worker 分布式路线在确认、同步、预演及排队关键边界重新核对项目，变化后停止后续动作。原实验已在远端运行时，不会因窗口切换自动终止。

正式随机种子写在已保存 Plan 的 `seeds` 中。在线 `experiment run` 的 `--seed` 及 `workflow.plan`/`workflow.run` 的 `seed` 覆盖参数不受支持，会在准备或运行前报错；移除参数、修改并保存 Plan 后重新校验。离线预览即使带 `--seed` 也只报告 `seedApplied: false` 与说明，不应用种子。旧手工记录器的 `run --seed` 保留，不能替代正式 Plan。

## 本机发布与验收

两仓源码验证、提交并同步 origin/master 后，在 SimpleExperiment-Mac 执行：

```sh
npm run release:prepare
npm run release:publish
```

prepare 构建两组件并生成清单，publish 上传完整草稿、核验附件后发布。命令不自动安装扩展，不使用 GitHub Actions。已发布版本不可覆盖，修复通过更高版本发布，保留历史附件。

发布说明分别标记 **本地验证** 和 **M5 真机验证**。本地构建、目标测试、包闭包和面板脚本通过，不代表 M5 安装或科研功能通过；用户已安排延后真机验收。

详情见 [Mac 发布与验收](docs/mac-release-guide.md)，持续适配见 [目标模式计划](docs/target-mode-plan.md)。
