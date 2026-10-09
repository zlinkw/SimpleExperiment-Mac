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

CLI 为 `simpleex-mac`、`simple-sftp-mac-api`，从源码 npm 包入口使用，不保证 VSIX 安装后自动加入 shell PATH。每次调用前读取当前发现文件和 `/api/v1/capabilities` 或 `/api/v1/openapi.json`，不要猜地址、token 和参数。

## 本机发布与验收

两仓源码验证、提交并同步 origin/master 后，在 SimpleExperiment-Mac 执行：

```sh
npm run release:prepare
npm run release:publish
```

prepare 构建两组件并生成清单，publish 上传完整草稿、核验附件后发布。命令不自动安装扩展，不使用 GitHub Actions。已发布版本不可覆盖，修复通过更高版本发布，保留历史附件。

发布说明分别标记 **本地验证** 和 **M5 真机验证**。本地构建、目标测试、包闭包和面板脚本通过，不代表 M5 安装或科研功能通过；用户已安排延后真机验收。

详情见 [Mac 发布与验收](docs/mac-release-guide.md)，持续适配见 [目标模式计划](docs/target-mode-plan.md)。
