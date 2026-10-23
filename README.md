# SimpleExperiment Mac

Apple Silicon、macOS 26+ 的 VS Code 扩展，配套 SimpleSFTP Mac 管理 Linux GPU 实验。扩展身份、设置和应用数据与 Windows 原版独立；业务以本版声明的 Windows 冻结实现为唯一来源。

**本配套 preview 版本为 Experiment 0.5.316、SFTP 0.2.103，参考冻结 Windows 0.5.403 / 0.2.107。** 发行附件与校验值以 [preview-v0.5.316](https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.316) 的实际清单为准。验收范围及 M5 真机边界见 [项目事实](docs/mac-project-facts.md)，冻结基线见 [源码对齐记录](docs/windows-alignment-2026-10-24.md)。

本轮增加机器级 GPU 单源采集、请求绑定准入、四根机器状态保护、独立隔离重跑审核和系统 Python 解析修复。VSIX 内根 README 的上一版版本说明属于文档遗留，实际版本与校验值以本 Release 的 package/release 清单为准；最新说明以本仓库为准。

## 系统与安装

- Apple Silicon、macOS 26 及以上，配套使用 VS Code 1.100.0+；目标真机为 M5、24 GB、macOS 27.0，本次尚未执行真机验收。
- Linux Worker 使用 SSH、tar、Python、tmux 和用户配置的 Python/Conda 环境。
- Intel Mac、Dev Containers、PPT 自动绘图不在本轮范围；本轮没有验证这些入口。

发行包见 [SimpleExperiment Mac Releases](https://github.com/zlinkw/SimpleExperiment-Mac/releases)。两款 darwin-arm64 VSIX 和 release.json 位于同一个 preview Release；公开下载无需登录。首次在命令面板 **⇧⌘P → Extensions: Install from VSIX…** 依次安装 **SimpleSFTP Mac → SimpleExperiment Mac**，再 **Developer: Reload Window**。实际发行版本以对应 Release 为准。

## 配置与运行

1. **File → Open Folder…** 打开本机项目；一个窗口只打开一个项目。按 **⇧⌘P → SimpleExperiment：打开面板**，顶部 **配置说明** 打开 [Mac 配置说明](docs/simple-experiment-setup.md)。
2. 配置 SimpleSFTP Mac 的真实服务器、用户、SSH 端口和项目父目录。通过 **SimpleSFTP Mac：配置服务器认证** 选择密钥、ssh-agent、密码或系统 SSH 配置；默认仅会话内记忆，明确勾选后才使用 SecretStorage 保存。
3. 在 SimpleExperiment 的 **服务器** 配置启用 Worker，可配置一台或多台。保存服务器地址、用户、SSH 端口、项目父目录、Conda 环境、tmux 前缀以及本机/远端转发主机和端口。业务只使用明确启用的 Worker；Hub 已退役，旧记录不补出目标。
4. **SimpleExperiment：准备 Agent 并启动 / 部署Agent** 使用共同的受管流程，通过 SimpleSFTP 更新 Agent 和独立 Scheduler。核对目标并在对话框点击 **确认上传并查看指引** 完成确认；复用、更新、重启和失败恢复均沿用 Windows 实现。Mac 没有可编辑的会话文件，Agent 启动由共同受管生命周期协议保障。
5. 点击 **启动全部隧道** 经 macOS 系统 OpenSSH 一键启动全部已启用 Worker 的本地端口转发，认证复用 SimpleSFTP Mac 的独立认证，不读取 Termius 私有会话；旧 simpleExperimentMac.tunnel.manualEndpoints 设置保留读取兼容。Termius 手动指引作为备份保留；启动请求、真实隧道与 Agent 就绪分别报告，以实际检测为准，macOS 真机验收尚未执行。
6. 选择当前 PLAN 的完整路径，按共同界面执行校验、预演和提交。自动同步、静态入口探针、Worker 准备、覆盖确认、队列和显存调度均沿用 Windows；不会用另一 PLAN 代替当前选择。

GPU 会话只在置顶 GPU 卡片展示；选中后展开任务与终端，名称为日志入口。停止、关闭和保留会话的清空使用精确绑定。正式产物只保留最新版；每个 job 完成后的同步取该 job 最新产物与当前勾选范围的交集。操作失败后按实际查询重查，不用历史回执推断成功。

本版支持 **批量选择 PLAN → 运行所选计划**：只提交显式勾选项，逐个沿用单PLAN校验和覆盖确认；失败、取消或结果未知后停止后续项，空选择不会运行全部。任务卡分开展示执行、产物完整及日志复核状态，**重新分析运行日志**不会重跑；异常job使用 **覆盖产物并重跑此 job**，保留原有路径双确认。结果汇总主动读取当前声明和Worker实际产物，仅保存最新汇总JSON及CSV/Markdown。

Worker按各自请求独立刷新，慢节点不阻塞其他节点；pending不等于失败。产物复制不再全局阻止PLAN提交，真实重叠路径仍保护。清理保留PLAN及共享配置，Worker重连不重复弹历史清理提醒。这些流程已完成隔离回归，Mac真机尚未验证。

同时包含每卡 job 配额/剩余显存门槛、显式派发剩余任务、源码范围校验、自动文件索引/内容比较、批量隔离删除和混合版本结果归属。Termius、Mac独立认证/preview源与原生句柄证明保留。同步范围本机删除已接入Darwin整树冻结和句柄证明，隔离替身通过13项；证明不完整时继续阻断。**真机libproc、权限及实际删除均未验证，不能视为功能全部对齐。**

## 更新按钮入口

| 入口 | 操作 |
| --- | --- |
| 底部右侧状态栏 | 点击 **配套更新：…** 检查两个组件；无需服务器或业务面板成功加载。 |
| 命令面板 ⇧⌘P | **SimpleExperiment：检查配套插件更新**；旧 **SimpleExperiment Mac：检查 preview 配套更新** 作为同一路径别名保留。 |
| 面板 → 设置 → 插件配套更新 | 点击 **检查更新**；发现新版后点击 **安装并重载**。 |
| 命令面板安装入口 | **SimpleExperiment：安装或补装配套更新并重载**；旧 preview 安装命令保留。 |
| SimpleSFTP Mac 命令面板 | **SimpleSFTP Mac：检查 preview 配套更新** 转到 SimpleExperiment Mac。 |

启动检查一次，此后每30分钟检查，同一配套版本仅主动提醒一次。通知 **查看更新** 展示说明，安装由上述安装入口显式确认。Mac 保留公开 preview 静态索引和同一 Release 分发，查询失败显示检查失败。安装事务、全部下载验证、SFTP先装、同版跳过、禁止降级、部分失败补装和等待本地传输使用 Windows 共同实现。

共同更新租约协议要求 **SimpleSFTP Mac 0.2.102 或以上**。本配套的 Experiment 0.5.316 / SFTP 0.2.103 满足该最低要求，请使用同一 Release 的两份 VSIX。旧事务回执保留并转换读取，不自动重装、清理或迁移用户产物。

## Mac 数据与 CLI

| 内容 | 位置 |
| --- | --- |
| Experiment API 发现文件 | ~/Library/Application Support/SimpleExperimentMac/api.json |
| SFTP API 发现文件 | ~/Library/Application Support/SimpleSFTPMac/api.json |
| 服务器资产 | ~/Library/Application Support/SimpleSFTPMac/server-profiles/servers.json |
| 共同租约 | ~/Library/Application Support/SimpleLocalMac/SimpleExperiment/ |

Finder **⇧⌘G** 可打开这些目录。CLI 入口为 **simpleex-mac** 和 **simple-sftp-mac-api**，在对应扩展的 **查看 CLI 入口** 命令中复制实际路径；终端需要 Node.js 20+。业务 API 每次先读取发现文件及实时 capabilities/openapi，不猜端口、token 或参数，不自动补确认。

## 验收与真机边界

已完成两仓本地构建、类型检查、生成面板脚本、逐文件串行隔离回归、真实 Chromium 主题验证及 Windows 专属回归；收包、VSIX 完整性和公开更新入口按配套发布流程核对。未连接生产服务器、部署远端 Agent、安装开发机扩展、停止远端任务或处理真实产物。M5认证、路径、隧道、单多Worker、macOS libproc、权限及实际删除仍未实机验证，不声称 Mac 系统体验完全一致。Mac原生句柄证明已接入SFTP检查分支及本机缓存执行器；发现占用返回ACTIVE_HANDLE，权限不足、ABI不符、查询变化或超时仍返回HANDLE_CHECK_UNAVAILABLE，无法取得完整句柄证明时继续阻断。
