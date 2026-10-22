# Windows 0.5.400 / 0.2.104 源码同步（078）

2026-10-22，本轮仅修改两个 Mac 工作区源码和静态记录。Windows 是业务唯一权威；原目标模式保持 **paused**。保留 075–077 未提交成果，不重置、不清理、不提交推送、不递增 Mac 版本。没有构建、类型检查、转译、测试、启动插件、句柄探针、连接业务服务器、传输、清理、训练、任务启停、部署、安装、打包或发布。本轮没有创建子代理。

## 冻结权威与交付依据

| 组件 | 稳定版本 | 精确提交 | Release |
| --- | --- | --- | --- |
| Experiment | 0.5.400 | `30626e78ea2f4b8a3e19e2cb09ae6aefcc6deb39` | [v0.5.400](https://github.com/zlinkw/SimpleExperiment/releases/tag/v0.5.400) |
| SFTP | 0.2.104 | `13ef630a12c6ea02ad9277452e75dbf443b9a34b` | [v0.2.104](https://github.com/zlinkw/SimpleSFTP/releases/tag/v0.2.104) |

已通过宿主只读 Git/远端查询核实稳定交付，并导出冻结源码；没有反改 Windows 工作区。权威附件元数据：Experiment VSIX 2,463,327 字节，SHA256 `455047781231161f33d5558beb955212c81f961d2e76418163d87344da8b25bf`；SFTP VSIX 209,640 字节，SHA256 `4577eff9dfa95a42cec73fd9824b0efe6783a43408db5dc2644cfc395540fa96`。这些是 Windows 交付依据，不是 Mac 验收证据。冻结后不继续追逐新提交。

前一基线为 Experiment 0.5.341 / `33b48126478b9f610f9a434c7541eeb385fd378a`、SFTP 0.2.90 / `23beafc52e4e310001e74a5730f0eae541bbc1bc`。Mac package/runtime 仍为历史 **0.5.314 / 0.2.101**；工作区不对应新安装包。下次授权构建时才统一版本并验证共同更新协议要求的 SFTP Mac ≥0.2.102 过渡。

## 实际修改与批次

本轮实际写入 **82 份 Experiment TS、7 份 SFTP JS/Python**，另更新 Experiment 共同配置和排除规则。每个源批次不超过 8 文件；集中更新本文、README、事实、计划及指纹。批次文本和原始 SHA256 回执保留在 `/repos/.mac-align-078-20261022/receipts/`；同目录有前轮快照、冻结源码、差异和静态检查脚本，不是发行产物。

| 批次 | 直接复用的 Windows 内容 | 保留的 Mac 接缝 |
| --- | --- | --- |
| 078a–c | SFTP 请求等待策略、进度/结算、隔离/快速批量清理、控制器对象身份和结构化忙证据 | 独立发现文件/认证、POSIX tar、Darwin 进程证明、原生句柄证明 |
| 078d | PLAN 批量提交、精确停止/清空、重试/替换和运行选择 | 原入口、未知结果不自动重放 |
| 078e | 每卡并行配额、剩余显存门槛、本机自动调度与显式服务器队列 | 不恢复 Hub，不推导未启用目标 |
| 078f–g | 主动查询、日志/完成证据、逻辑 PLAN 进度、tmux、采样与归属 | 原生终端/路径边界不变 |
| 078h–i | 隧道请求预算、传输进度、源码 manifest/精确批量校验及 code-source fence | Mac 传输与认证 facade |
| 078j–k | 文件观测索引、同步树/元数据与自动内容校验、确认路径批量删除契约 | 非 Windows 根路径区分大小写，使用共同实时 stat 回退 |
| 078l | PLAN 隔离/清理和 UI、忙拒绝的结果分类、同步直接删除保护 | 缺 Darwin 完整证明的旧本机直接删除显式阻断，详见源码缺口 |
| 078m | 每 job 完成产物确认复用、当前运行归属、结果批量读取/导出及混合版本列 | 不以历史回执冒充新查询 |
| 078n–o | API/CLI 剩余任务派发、短操作历史隐藏、设置/UI/活动调用链接线、在线指南 | Termius 手动指引、Mac namespace/preview 源；修正旧身份替换误伤的业务变量 |
| 078p–q | 冻结指纹、核对脚本和集中说明 | 不构建、不提交，原目标仍 paused |

11 项变化的共同配置声明已同步，包括 Worker 内嵌 GPU 设置和全局调度设置。保留 Mac 身份、扩展依赖、CLI、入口、preview 仓库、既有脚本及版本；两份 lock 的 Windows 变化仅为版本，不照搬。RuntimeManifest 仅版本变化，保留 Mac 原值。SFTP CLI 的 Windows 等待策略已在其 Mac RPC facade 接入，保留原 CLI 壳；上游 extension/README.md 仅内部说明，不作为运行源码复制。

发行排除规则追加 Windows 的 docs/tests/CHANGELOG、临时包装便签及 .patched 排除；指南入口复用上游文件/在线解析逻辑，fallback 指向 Mac 仓库。README 是打包工具强制最小元数据例外。尚未打包，规则文本不能证明真实归档合格；未来仍须核对运行闭包、包文件清单、法律通知与最终归档。

## 安全边界与明确剩余源码

- 保留 Application Support、POSIX 路径、Termius 手动隧道、SSH/SecretStorage 独立认证、共同更新租约和 Darwin libproc 适配。不读取 Termius 私有会话，不用打开指引冒充连接成功。
- 最新 SFTP 的 path-only、fast batch、archive delete、顶层扫描均补接原有 Darwin 冻结 vnode 证明。目录复用有界 metadata inventory；超过上限、权限/ABI/身份/进程变化或超时继续阻断，不降级。实际句柄查询没有执行。
- 两次完整路径确认、安全根、直接父目录、短相对子项及未知回执不重放均保留；没有执行真实删除或迁移资产。
- **剩余源码缺口 1 项**：`src/features/SyncResolution.ts` 的旧同步范围本机直接删除仍是 Windows 执行器，缺少完整 Darwin 目录冻结证明及共同清理链接线。现在非 win32 在调用执行器前明确抛出 `HANDLE_CHECK_UNAVAILABLE`，不会尝试 pwsh/rm，不宣称功能对齐。SFTP/PLAN 清理和缓存的原生适配不能自动证明此入口已完成。此项不是“仅待测试”。

## 静态结果与证据

- 392 份 TS、23 份打包 JS 仅解析语法；725 个字面量相对引用检查来源存在性。10 处 semver 引用来自已核实的 `scripts/bundle-semver.js → dist/vendor/semver`，检查其固定依赖版本及四个 node_modules 输入，不生成 dist、不加载应用。
- 6 份打包 Python 仅 `ast.parse`。所有批次回执与真实工作区字节再次核对；427 份文件指纹（Experiment 395、SFTP 32），其中 386 份有 Windows 对应源，352 份仅身份映射、34 份明确平台覆盖，其余 41 份为平台适配文件。冻结源码校验入口支持 `--windows-experiment-snapshot` / `--windows-sftp-snapshot`，不必在 Linux 对宿主 Git 元数据执行查询。
- 静态依赖首次检查报告 semver 生成目录缺失，原退出码 1 和日志保留；核实真实构建复制入口及输入后修正检查器，再检查退出码 0。未将缺失目录误称已有生成文件。
- 原始日志：TS/JS/依赖 `/host/d/OpenChamber-AgentConfig/Pi/host-sandbox/diagnostics/linux-bash/40ff3ea3-2298-4e17-9303-885df0520399.log`；Python `/host/d/OpenChamber-AgentConfig/Pi/host-sandbox/diagnostics/linux-bash/6b74b152-b6f1-41fc-b32a-38f4feda03e0.log`；完整指纹和最终文本检查日志另见同目录 078 收尾回执。日志退出码只证明对应静态检查。

静态解析不等于类型/行为正确。**7 类验证全部未执行**：构建/类型、串行回归、包/安装、更新过渡、Mac 系统/UI、传输/清理、Worker 完整流程。生成面板、嵌入 Python、原生 ABI/权限、隔离后同名新数据、忙证据与未知回执、配额/混合版本归属均在后续授权验收范围；不得套用 Windows 或历史 Mac 测试结果。旧 29 条 18/11 计数仍仅为历史。
