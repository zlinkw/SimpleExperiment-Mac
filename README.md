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

### Mac 结果路径与来源

Mac 结果预览的候选列表与后台筛选也保留真实路径。不同目录的同名指标、大小写、首尾空格、Unicode 拼写和字面 `%20` 不再合并；声明具体目录时，仅该路径匹配。通配符和 `{suite}`、`{plan_file}`、`{output_dir}` 等占位符仍支持，但匹配区分大小写，实际 Plan/suite 拼写保留。若需匹配多个目录，请明确声明范围，不能靠相同文件名自动借用另一目录结果。坏路径或非字符串候选不会改写后参与匹配。这一阶段覆盖 Plan 单行结果路径的 YAML 提取、摘要/接入规则候选与预览筛选；摘要中的结果来源按当前 Plan 单独核验；映射物理发布、Agent 读取与实际解析仍继续分批验证。

Mac 的结果摘要、完成结果与摘要提供的查看/同步候选均核对完整 Plan 路径。`planFile`、`plan_file` 和 `provenance` 的路径必须一致，保留真实大小写、Unicode 与空格；错误类型、Windows 路径和别名冲突不会改写后授权。顶层摘要未标明归属时，仅保留明确属于当前 Plan 的记录/Worker 表，不借用匿名汇总路径。Worker 表若包含其他 Plan 的数据集或完成 job，会阻止该表提供路径、大小/hash 证据；混合分析产物与计数隐藏，合法记录和表仍可保留。需要重新按当前 Plan 解析并核对 Agent 版本时，按面板提示操作，不停止正在运行的实验。当前本地验证覆盖摘要来源与映射关联；其他运行/写操作回执、Agent 输出、真实服务器传输、完整解析与物理原子写入仍需后续验证。

Mac 的“检查输出契约”回执用于提供轻量结果查看候选时，也要核对完整 Plan 和全部路径别名、revision。明确属于该 Plan 的祖先记录可以授权其结构子记录；子记录的 Plan 不能替匿名祖先或兄弟授权文件、时间或版本。路径/版本冲突和错误类型的回执不提供候选，最新有效空报告会清除旧候选。候选减少时，请核对当前 Plan、回执原始路径与 Agent 版本，再重新检查；不要通过改大小写或删空格借用旧来源。本地证据覆盖实际编译后台、实时事件 reducer 与隔离生成的 Agent 函数；其他运行/写操作回执、完整 Agent 结果路径解析、真实服务器与 M5 仍待适配。

配套新版 Agent 的“检查输出契约”也保留原始完整 Plan；`planFile`、`plan_file`、`plan`、`selectedPlanId` 及 options 中的别名须一致，revision 别名同样核对。指定 Plan 必须是远端项目内现有普通文件，大小写、中文和真实空格按实际目录核验；关联 jobs 仅采用明确属于同一 Plan 的行，匿名 suite 行不会替当前 Plan 提供结果。报告按完整 Plan 的摘要 key 分开保存，返回值与开始/完成事件保持同一身份。出现别名冲突、文件身份或来源错误时核对原 Plan 和远端版本，再重新检查；不要改写路径绕过。扩展在线更新后，服务器 Agent 仍需通过 **准备项目与 Agent** 主动确认上传，在 Termius 手动处理 Agent 并 **检测全部**，保留正在运行的实验。指定 Plan 的结果声明还会读取真实 YAML，包括引号、列表、锚点及多行命令；结果路径保留大小写、Unicode 拼写和首尾空格。`*`、`?`、`**` 按路径段区分大小写匹配，扫描有目录、深度及时间预算。Plan、明确关联的 jobs、快照与结果文本均从受检普通文件描述符读取，单文件最多 5 MiB，必须是有效 UTF8；CSV/JSON/文本解析使用同一份已核验内容，生成报告前再次核对来源身份。依赖当前科研 Python 环境的 PyYAML，缺失依赖、无效 YAML、文件变更或超限时停止此次检查，请核对环境和原文件后重新检查。此边界只覆盖指定 Plan 的“检查输出契约”；其他动作、完整 revision 内容证明、检查到写入之间的原子锁定、真实服务器与 M5 验收仍未完成。

本地已验证“内存指标下载 → 实际编译 CSV 解析 → 结果注册表 → CSV/Markdown 发布”的链路，使用实际编译目录读取线程：同义指标合并后计算均值和样本标准差，注册表保留原指标名、来源 Worker 与本次 runId；下载 hash、大小或返回路径异常以及同义指标冲突时保留原注册表和结果表。完成任务不会自动下载，仍由用户手动同步。此证据使用本机文件和模拟 SimpleSFTP API；真实服务器、完整 Mac 解析路径及 M5 尚未验收。

Mac 本机刷新和 wrapper 结果解析也核对完整 Plan 归属，再从已验证描述符快照读取；新鲜度判断使用同一描述符的修改时间，单个轻量文件最多 4 MiB，文本必须是有效 UTF8。内存结果重新核对原始来源路径、实际字节大小和 SHA-256，并从真实文本解析，不直接使用缓存统计行或替错误内容改写 hash。CSV/JSON/二进制文件名末尾的真实空格保留，空二进制文件不会被当作缺失或虚构指标。出现来源、编码或大小/hash 不符时，核对 Plan、来源清单及实际文件后重试，不强行发布；完整原子写入、Agent 读取、远端传输和 M5 仍待验收。

Mac 的结果映射下载从合批、文件大小/hash 清单、缓存复用、分块到本机分发，都按原始来源路径关联。`Results/A.csv` 与 `Results/a.csv`、真实空格、Unicode 拼写、字面 `%20` 分开处理；同一来源文件跨 Plan 的大小或 hash 证据冲突会阻止合批。下载和复用仅对应自己的来源，不会因相似名称替另一个文件标记完成。发现“本机映射路径拼写与已有磁盘条目不一致”时，请核对实际目录/文件名及映射目标后重试；不要靠改大小写、删空格或强制覆盖绕过。该提示也适用于默认不区分大小写的 Mac 磁盘，避免把已有别名当作可复用副本或缺失目标。这一阶段通过真实编译函数、模拟 API/不敏感文件系统及本机文件分发测试；检查与写入之间尚非原子锁定，真实服务器传输、Agent 读取、完整结果解析与 M5 仍待验证。

Mac 本机结果复用、磁盘补读、hash 核验和分发复制使用已核对身份的文件描述符，并在读取后再次检查工作区、各级目录和文件身份。读取期间文件替换、目录变化、内容变化或增长超限时，不把该次内容当作已验证结果。复用仍要求当前清单中的大小和 SHA-256 一致；分发复制遇到短写会继续补齐，零进展或内容不符则失败。打开已有暂存文件不会先截断；检测到身份变化或已有硬链接时会拒绝写入。出现身份变化提示时，请保持当前项目，核对实际目录、来源清单与完整回执后重试；旧最终结果保留，失败暂存不自动清理。这些检查通过本机文件和模拟文件系统验证；父目录检查到最终写入/替换之间仍有变化窗口，尚不能视为完整原子发布或 M5/服务器验收。

在 Plan 的 `result_csv`、`expectedResults`、对象的 `path`/`file` 或 `runner.outputs` 中，包含真实首尾空格、`#`、逗号的路径请加 YAML 引号，例如 `result_csv: ' 结果 A/指标.csv '`。引号内空格属于文件名；单双引号按 YAML 解码一次，单引号内的 `'` 写成 `''`，双引号中的 Unicode 转义按实际字符校验。普通路径、目录推导和命令中的已引用结果目标保留原拼写；显式声明的项目内 CSV/JSON/TXT/LOG/OUT 可作为预览候选，元数据仍排除。占位符保留到匹配阶段；两条不同目录的 `metrics_summary.csv` 不合并。不要用 Windows 反斜杠、`./`、`..` 或连续 `/`，错误候选不会被修成另一路径。这里沿用轻量 Plan 预览读取器；本批没有新增完整 YAML 锚点、多行 scalar、其他 suite/config 字段及实际结果解析的验收。

结果所属 Plan 使用完整项目相对路径，保持大小写、Unicode、字面 `%20` 与真实首尾空格；结果映射、已完成运行、attempt 输出和 SHA-256 文件清单按原拼写核对，另一 Plan 的运行不会用于本 Plan。TS 与新版 Agent 的 Plan 结果目录 key 使用同一规则。轻量查看确认保留原始来源路径，本机副本目录包含完整 Plan 路径的摘要；历史副本保留，不自动搬移或清理。

按 **⌘,** 搜索 `simpleExperimentMac.resultCsvDir`，填写项目内相对目录，例如 `experiments/results` 或 `结果 A/汇总`，保留目录名真实空格。不填绝对路径、反斜杠、冒号、`.`、`..`、内部连续 `/` 或控制字符。非法配置会报错，不回退默认目录；业务面板无法加载时，仍可从 VS Code 设置修正，再重载，状态栏和命令面板更新入口保持可用。结果 Plan 目录使用实际 `simpleExperimentMac.planDir`，不要把不同目录或大小写的 Plan 当作同一项。

上述映射、运行筛选、路径确认和目录 key 通过本地编译模块、后台方法与 Agent 隔离函数测试。完整结果候选 UI、Agent 结果读取、实际解析、物理发布/归档及 M5 仍继续适配。服务器需主动确认上传配套新版 Agent，并在 Termius 手动启动和检测；不为升级中断正在运行的实验。

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

Mac Plan 选择请使用完整项目相对路径，例如 `experiments/plans/中文/A.yaml`。`A.yaml` 与 `a.yaml`、不同目录及文件名真实首尾空格分别保留；字面 `%20` 不转换为空格，Unicode 拼写不自动改写。面板选择、保存选择、提交身份和分布式重试不再合并这些不同路径。多个 Plan 使用同一显示名时必须选完整路径；错误完整路径不会退回另一个已选 Plan。终端参数加引号，查看实际文件名后重新选择，不靠改变大小写或删空格绕过失败。此批通过编译队列、真实生成面板与后台方法的本地模拟验证；结果/监控及完整科研仍继续适配，M5 未验收。

Plan 目录默认为 `experiments/plans`，在 Mac 设置 `simpleExperimentMac.planDir` 中填写实际项目相对目录；保留中文和真实空格，不填绝对路径、反斜杠或 `..`。扫描与单文件摘要按实际目录条目区分大小写，YAML 文件名末尾真实空格也会保留。Plan 目录以下的符号链接和非普通文件会拒绝；读取期间文件、内容或工作区变化时，不使用该次结果，请核对文件后重新识别并预检。显式错误 Plan 不会自动改选唯一的另一个 Plan。摘要保留原读取预算和截断标记，完整本地配置检查读取全文。分布式路径合同、预演及入队使用真实相对路径，坏路径不会自动改成另一目录。以上通过编译模块与 POSIX 文件系统模拟验证；远端 Agent 输出路径、归档写入、结果/监控与 M5 验收仍继续分批。

Agent 持久队列的 Plan/outputDir 身份、接收回执、旧队列派发及 recall/停止匹配也保留真实大小写、Unicode、字面 %20 和首尾空格；非法相对路径或非字符串不自动改写后接收。旧 queued 行的坏路径会等待处理，运行中记录不自动修改。该检查需服务器使用配套新版 Agent：更新扩展后，通过“准备项目与 Agent”核对并确认上传，在 Termius 手动启动后再检测；不要为升级中断已有实验。Agent 启动参数与 scheduler 的输出、attempt 子目录、工作目录、声明输入/输出及 Plan 状态 key 同样保留真实拼写。Plan 必须是项目内现有普通文件；已有路径条目按实际名称核对，符号链接、别名冲突和非法路径会在启动前拒绝。依赖检测后再次检查路径与原 Plan revision；原 Plan 读取全文，不受摘要预算限制。以上仅通过隔离编译函数和模拟 POSIX 文件系统验证；检查到实际启动/写入之间仍有变化窗口，结果/归档写入、真实科研与 M5 继续适配。出现路径身份冲突时核对原 Plan、完整回执和远端状态，不盲目重发。

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
