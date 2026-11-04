# SimpleExperiment Mac 配置说明

面向 Apple Silicon、macOS 26 及以上的 VS Code 用户。快速入口见 [README](../README.md)，文件传输配置见 [SimpleSFTP Mac 使用说明](https://github.com/zlinkw/SimpleSFTP-Mac/blob/master/readme.md)。

本文适用于 **Experiment Mac 0.5.329 / SimpleSFTP Mac 0.2.107**，公开安装包以 [Mac preview Releases](https://github.com/zlinkw/SimpleExperiment-Mac/releases) 为准，不代表 Windows 后续版本的能力。0.5.325 修复 PLAN 依赖收集将未消费的发布元数据及历史结果纳入源码的问题。包内 Agent 同为 0.5.325，部署端也须通过原受管流程更新后才能应用；本轮不代为部署或提交训练。依赖分类和动态声明见 [项目契约](plugin-project-contract.md#plan-依赖核验)。保留 0.5.324 修复的桌面发现 globs 误发给 Agent 的规则同步错误，保留 0.5.323 的冻结上下文修复，保持 preview，真机尚未验收。

**当前 preview 已交付独立安装、配套更新、系统 OpenSSH 一键启动隧道（Termius 为手动备份）、项目与 runtime 上传及 Agent/tmux 指引，共同业务已同步至 Windows 0.5.440；运行结果仍须以实际检查为准。** M5 真机更新、独立认证传输和单台/多台 Worker 尚未验收，macOS 真机隧道验收同样尚未执行。Mac 不使用 Xshell 会话文件；“准备项目与 Agent”需确认后上传，隧道可一键启动或在 Termius 手动备份，Agent 启动由共同受管生命周期协议保障。

完整实验接入契约见 [AI 最小接入指南](experiment-integration.md)、[MultiModal 实践](multimodal-integration-best-practice.md) 和 [项目契约](plugin-project-contract.md)。面板 **设置 → 最小实验接入指南 · 交给 AI** 可打开指南或复制完整接入任务；这是本机复制，不会自动启动训练或传输。配置参考见 [共同设置字段](configuration-reference.md)。Hub 已退役，所有当前操作只使用明确启用的一台或多台 Worker，旧控制节点字段不补出目标。

## 1. 首次安装与打开说明

要求 Apple Silicon Mac、macOS 26+、VS Code 1.100.0+。首版不支持 Intel Mac、Dev Containers 或 PPT 自动绘图。

1. 打开 [配套 preview Releases](https://github.com/zlinkw/SimpleExperiment-Mac/releases)，从同一个 Release 下载两个 `darwin-arm64.vsix` 附件。
2. 按 **⇧⌘P** 打开命令面板，运行 **Extensions: Install from VSIX…**，先安装 SimpleSFTP Mac，再安装 SimpleExperiment Mac。
3. 运行 **Developer: Reload Window**，在扩展页确认 `simple-local.simple-sftp-mac` 和 `simple-local.simple-experiment-mac`。
4. 运行 **SimpleExperiment：打开面板**。顶部 **配置说明** 打开本文；也可在命令面板运行 **SimpleExperiment：打开配置说明**。Mac 说明入口不会启动旧会话配置向导。

首次安装和检查更新无需服务器或 Termius。下载为公开附件，无需登录 GitHub。

| Mac 常用操作 | 入口 |
| --- | --- |
| 命令面板 | **⇧⌘P**，即 Shift + Command + P |
| VS Code 设置 | **⌘,**；搜索 `simpleExperimentMac` 或 `simpleSftpMac` |
| 打开项目 | VS Code 菜单 **File → Open Folder…**，选择本机项目文件夹 |
| 查找应用数据 | Finder 按 **⇧⌘G**，输入下文的 Application Support 路径 |
| 可选 `code` 命令 | 命令面板运行 **Shell Command: Install 'code' command in PATH**，随后重新打开终端 |

安装 VSIX 不要求先配置 `code`。快捷键和 PATH 说明见 [VS Code 官方 Mac 安装说明](https://code.visualstudio.com/docs/setup/mac)。

## 2. 更新按钮与故障处理

- **VS Code 底部右侧状态栏 → Mac preview：…**：点击检查两个组件；业务面板打不开时仍可用。
- **⇧⌘P → SimpleExperiment Mac：检查 preview 配套更新**：手动检查。
- **SimpleExperiment 面板 → 设置 → 插件配套更新 → 检查更新**：发现新版后点击 **更新并重载**。
- SimpleSFTP Mac 也提供 **SimpleSFTP Mac：检查 preview 配套更新**，会交给配套 Experiment Mac 处理。

关闭更新通知后，可运行 **SimpleExperiment Mac：安装 preview 配套更新**。启动检查一次，此后每 30 分钟检查，同一版本只主动提醒一次。

点击更新后，插件阻止新业务操作，等待已有本地传输结束，下载并验证全部待更新包，再按 **SimpleSFTP Mac → SimpleExperiment Mac** 安装并重载。相同或更高的已安装版本跳过，不自动降级；不会停止远端实验。

**检查失败** 表示网络、限流或清单读取失败，不能当作“已是最新”。网络恢复后手动检查。部分安装失败会显示已完成和待完成组件，选择 **重载后补装**，重载后只补装剩余组件。混合版本期间暂停新业务操作。

若报 `command 'simpleExperimentMac.openPanel' not found` 或激活日志出现 `'get' on proxy: property 'globalState' is a read-only and non-configurable data property`，更新到 **Experiment 0.5.323** 并执行 **Developer: Reload Window**。SFTP 已为 0.2.106 时无需重复安装；仍为 0.2.105 时先更新 SFTP，旧错误通知可能阻止依赖激活。不清空任何设置，也不操作训练服务器。

新版命令和侧栏先注册，再初始化业务；失败时打开启动诊断页。请复制 **输出 → SimpleExperiment Startup** 的加载 ID、版本、代码/注册路径、运行平台、SFTP 状态及首条异常栈。同时用 **Developer: Show Running Extensions** 确认是否运行在本机，及 **Developer: Show Logs… → Extension Host** 保留重载后的第一处异常。如果连 Startup 输出也没有，优先检查扩展是否禁用、装错 Profile、旧 Extension Host 或依赖导入失败；不要据此清理配置。0.5.323 已对照用户提供的 globalState Proxy 激活错误复现并修复，但本机包级回归不替代 macOS 真机重载验收。

## 规则同步失败

若“校验并提交运行”报 `invalid projectAdapterRules field`，请更新到 **Experiment 0.5.324** 并重载。桌面使用的 `planDatasetMapping`、`planGlobs`、`configGlobs`、`resultGlobs` 保留在工作区，只从发往 Agent 的副本排除；无需删除发现配置。结果路径、CSV 映射和指标别名照常同步，其他未知字段、非法映射或真实 Worker 失败仍须修正，不能当作隧道故障一概重试。本补丁不部署 Agent，也不自动再次提交训练。

## 低流量模式与手动刷新

入口在 SimpleExperiment 面板顶栏，按钮显示 **低流量：关** 或 **低流量：开**。默认关闭；点击切换并等待保存回执。显示“读取中”或“提交中”时等待实际状态，不把灰色按钮当作功能缺失。

- 开启后，tmux、日志、GPU 历史等展示区停止自动刷新；已有缓存仍可显示，不代表服务器刚刚采样。
- 按需使用 **刷新窗口列表**、**刷新当前日志**、**刷新运行状态** 及各区域的手动刷新入口。提示会区分“尚未手动刷新”、缓存采样时间和上次手动刷新时间；请求尚未完成或失败时不当作取得新数据。
- 低流量不停止训练，不等于暂停全部网络。必要的队列协调、远端任务完成确认等后台流程继续按实际策略运行；用户提交、停止、手动刷新和受确认门禁保护的操作保留原流程。
- 这是 Mac 扩展的全局偏好，保存后本窗口立即生效，重启后保留；其他已打开窗口需执行 **Developer: Reload Window** 后应用。它不自动改写 Windows 插件的偏好。
- 已暂停网络、仅手动刷新或后台通信暂停等更强限制继续生效。关闭低流量开关不会替用户解除这些限制，具体状态以按钮提示和实际查询为准。

如果顶栏没有开关，先在扩展页确认完整名称为 **SimpleExperiment Mac**、版本为 **0.5.319 或更高**，再执行 **Developer: Reload Window** 并重新打开面板。仍缺失时保留实际版本和面板诊断，不能仅凭安装成功断定 Extension Host 已加载新版本。上述行为来自源码与自动检查，Mac 真机显示和网络行为尚未验收。

## 3. 本机工作区与路径配置

一个 VS Code 窗口打开一个本机项目。多根工作区与远程 Container 工作区不用于首版科研上传。

- 本机路径使用 `/Users/你的实际用户名/Projects/项目名` 等绝对 POSIX 路径，不使用盘符或反斜杠。
- 设置中的路径不要填写 `~`、`$HOME` 或用户名占位符，先替换为真实绝对路径；Finder 中的 `~/Library/...` 是导航简写。
- 中文、空格和大小写保留原样。路径有空格时，终端命令使用引号，例如 `code "/Users/实际用户名/Projects/中文 项目"`。
- 本机项目名与远端路径独立；不要根据服务器名猜远端根目录。

两插件对项目父目录、runtime 安装目录、绝对 Python 环境目录和 SFTP 目标使用一致规则：保留中文、大小写、Unicode 拼写及目录名的首尾空格，合并重复分隔符并去掉路径末尾的 `/`；字面 `%20` 保持原样，不当作空格解码。不得包含 `.`、`..`、反斜杠、换行、制表符等控制字符，不以 `/` 作为上传目标或本机项目。SFTP 的只读目录浏览可以从 `/` 开始，创建项目和上传仍须选择具体目录。

上传清单、Worker 传输及映射下载的相对文件名同样保留中文、大小写、Unicode 拼写和首尾空格。使用项目内相对路径，例如 `结果 A/指标.json`；禁止绝对路径、`..`/`.` 路径段、内部连续 `/`、反斜杠、冒号和控制字符，UTF-8 长度不得超过 4096 字节。全部上传条目校验成功后才建立 SSH/tar 传输。远端 `Model/a.json` 与 `model/a.json` 分别保留；映射到本机时使用不同目标名，例如 `upper.json`、`lower.json`，本机仍拒绝只差大小写的目标以防别名覆盖。不修改真实文件名来绕过失败提示，先核对完整路径和映射目标。此处通过本地 tar/Python 协议与 Mac 模拟入口验证，CLI 尚在后续适配，M5/真实 SSH 未验收。

下载范围入口为 **⇧⌘P → SimpleSFTP：设置下载文件范围**。确认本机/远端目标后，选择 **添加远端文件夹** 或 **添加远端文件**，浏览与手动绝对路径必须在当前远端项目内。选择器保留中文、大小写和文件名首尾空格；保存后 **查看已选远端路径**，再执行 **远端同步到本地**，按保存的文件类型和大小上限过滤。选中的符号链接拒绝下载。

空字符串或坏路径不会隐式转为整个项目。手动 **使用当前目录** 可明确选择项目根，预览显示 `.`；未配置范围时仍保留原有整项目同步入口。API `sync.downloadPaths` 必须提供具体项目内相对文件/目录，拒绝 `.`、`./` 等整个项目别名。**移除已选远端路径** 只改配置，不删除文件。此流程通过本地 UI/API 模拟及 Python 归档协议测试，M5/真实 SSH 未验收。

`/Data/研究` 与 `/data/研究` 在远端是不同路径，`remote.allowedRoots` 和 `remote.deniedRoots` 区分大小写，只匹配指定目录及其子目录。设置面板的允许/禁止目录每行一个完整绝对路径；空白行忽略，非空非法行会拒绝保存，避免误变成无限制。目录名称最后有真实空格时，确认预览、上传目标和 Agent 检测保留该空格；不要自行删去或更改 Unicode 拼写。终端中使用单引号或双引号包住完整路径。

按 **⌘,** 配置 Mac 命名空间。也可运行 **Preferences: Open Workspace Settings (JSON)**，合并以下示例到当前项目 `.vscode/settings.json`。所有示例路径需替换；不写密码、私钥或 token：

```jsonc
{
  "simpleSftpMac.localBase": "/Users/实际用户名/Projects",
  "simpleSftpMac.remoteBase": "/data/你的实验父目录",
  "simpleSftpMac.uploadOnSave": false,
  "simpleExperimentMac.resultCsvDir": "experiments/results",
  "simpleExperimentMac.remote.allowedRoots": ["/data/你的实验父目录"],
  "simpleExperimentMac.remote.deniedRoots": []
}
```

`localBase` 是创建本地项目的父目录；`remoteBase` 是选择远端项目的父目录；已有项目的传输目标还要通过 SimpleSFTP 服务器配置和 **查看当前目标** 核对。`uploadOnSave: false` 便于首次配置时先核对目标，再手动上传。`workspaceHostRoot`、`workspaceContainerRoot` 保持空值。

允许/禁止目录规则限制远端“项目父目录”，不替你创建目录或推断服务器路径。最终远端项目为 `<实际项目父目录>/<本机工作区名称>`，避免重复拼接项目名。首次设置服务器时不要使用 `/`、`/root`、`/tmp` 或数据集所在目录作为实验项目父目录。

## 4. SimpleSFTP 的服务器配置

按 **⇧⌘P → SimpleSFTP：打开共享服务器配置**，在打开的 `servers.json` 中填写真实目标；多个服务器各用一个唯一 `id`：

```json
{
  "version": 1,
  "activeServerId": "worker-a",
  "servers": [
    {
      "id": "worker-a",
      "label": "Worker A",
      "host": "你自己的 SSH 主机名或别名",
      "user": "远端实际用户名",
      "sshPort": 22,
      "remotePath": "/data/你的实验父目录",
      "localBase": "/Users/实际用户名/Projects",
      "enabled": true
    }
  ]
}
```

保存后运行 **SimpleSFTP：选择服务器**，再运行 **SimpleSFTP：查看当前目标** 核对本机目录、远端账号、SSH 端口和完整路径。`sshPort` 是服务器 SSH 端口，不能填 Agent HTTP 转发端口。

已有 `~/.ssh/config` 可运行 **SimpleSFTP：导入 VS Code SSH 配置** 导入连接描述；它读取本机 OpenSSH 配置，不读取 Termius 私有会话。**导入或选择配置不等于已验证认证成功。**

按 **⇧⌘P → SimpleSFTP Mac：配置服务器认证**，或在资源管理器 **SimpleSFTP → 配置服务器认证**，为每个目标选择方式：

- **选择私钥**：从 Mac 文件选择框选择真实私钥；加密私钥首次连接时在 VS Code 密码输入框输入口令。
- **ssh-agent**：使用当前 VS Code 进程可见的 `SSH_AUTH_SOCK` 和已加载身份；不向远端转发 agent。
- **密码**：首次连接时在 VS Code 密码输入框填写该服务器的 SSH 密码。
- **系统 SSH 配置 / 自动**：沿用自己的 OpenSSH 配置与默认密钥。需要 SSH 别名或已有跳板配置时使用此模式；独立密钥、agent 和密码模式应填写真实主机地址、用户与端口。

记忆选项默认不勾选，仅本次扩展会话内记忆。只有勾选 **使用 VS Code SecretStorage 保存密码 / 私钥口令**，输入的凭据才保存以供重载后使用；不勾选时不读取以前保存的凭据。密码/口令不写服务器 JSON、项目设置、命令参数或临时文件；Termius 登录不会自动授权 SimpleSFTP。真实 SSH 上传下载、连接恢复和 M5 验收仍待执行。详细操作见 [SimpleSFTP Mac 独立认证](https://github.com/zlinkw/SimpleSFTP-Mac/blob/master/readme.md#独立认证入口)。

跨服务器产物传输在 Mac 默认经过本机内存管道，来源和目标各建立自己的 SSH 连接。分别配置两端认证即可，不需要 Worker 之间互相免密登录。普通 tar 分组与大文件断点分块保留哈希核对、接收检查点和有限并发；本机不生成中转压缩包。传输失败等待两个本地进程退出，远端接收结果不明时先恢复核验再补传。真实跨服务器、断连后恢复仍待 M5 验收。

## 5. 系统 OpenSSH 一键启动与 Termius 备份（端点配置）

### 一键启动系统隧道

1. **启动全部隧道 / 启动隧道**（含面板与命令面板入口）经 macOS 系统 `/usr/bin/ssh` 为每个明确启用的 Worker 建立 `-N -L` 本地端口转发；执行前展示端点明细并需确认。认证复用 SimpleSFTP Mac 的独立认证会话，不读取 Termius 私有会话或密码，不执行任意远端命令，不启动其它调度服务；使用用户自己的 SSH 配置时，插件先以只读解析核验有效配置恰好包含预期转发且不含隐藏本地命令或代理，不满足则拒绝启动。
2. 汇总分别报告 **启动请求 / 真实隧道 / Agent 就绪** 三档：端口确认监听才算真实隧道，检测确认前视为待确认；已被其它进程占用的端口只失败该端点，健康既有转发按现状复用。**停止本插件启动的系统隧道** 只结束本插件启动的转发进程，不触碰其它进程。
3. 以上路径通过本地隔离环境回归验证；macOS 真机验收尚未执行。

### Termius 手动备份

在 [Termius](https://termius.com/) 中自行配置 Linux 主机、SSH 端口和认证，手动登录。为每个端点建立 **本地端口转发（Local port forwarding）**，本机监听使用 loopback，目标为该 SSH 主机上的 Agent 监听地址与端口。手动启动转发并保持 Termius 连接；打开插件指引文本不会被记为启动成功。

### 保存端点

打开 SimpleExperiment 面板 **设置 → 服务器 → 配置手动端点**，或按 **⇧⌘P → SimpleExperiment Mac：配置 Termius 手动端点**。在打开的设置页搜索结果中编辑 `tunnel.manualEndpoints`；数组在 JSON 中编辑。

这是全局应用设置，使用 **Preferences: Open User Settings (JSON)** 打开用户 `settings.json`，不要写入项目 `.vscode/settings.json`。旧 simpleExperimentMac.tunnel.manualEndpoints 设置保留读取兼容；显式修改该设置会重新应用其中的 Worker 端点。将以下字段合并到已有 JSON，不覆盖其他设置。下面是单 Worker 示例，主机、用户、端口和路径都需替换为自己的实际配置：

```json
{
  "simpleExperimentMac.tunnel.manualEndpoints": [
    {
      "id": "worker-a",
      "role": "worker",
      "displayName": "Worker A",
      "host": "worker-a.example.org",
      "user": "researcher",
      "sshPort": 22,
      "localForwardHost": "127.0.0.1",
      "localForwardPort": 29101,
      "remoteAgentHost": "127.0.0.1",
      "remoteAgentPort": 29200,
      "projectParentDir": "/data/researcher/实验项目",
      "agentInstallDir": "/data/researcher/simple_agent",
      "condaEnv": "/data/researcher/conda_envs/experiment",
      "enabled": true,
      "maxConcurrentGpus": "auto"
    }
  ]
}
```

| 字段 | 应填写的内容 |
| --- | --- |
| `id` / `role` | Worker ID 唯一，含小写字母、数字、点、下划线或连字符；当前执行角色使用 `worker`，旧 Hub 字段不创建执行目标 |
| `host` / `user` / `sshPort` | 真实 SSH 主机、登录用户和 SSH 端口；HTTP 检测只请求下方转发端点，不用这些字段自动登录 |
| `localForwardHost` / `localForwardPort` | Termius 在 Mac 上实际监听的地址和端口；每个启用端点的端口唯一，可使用 `::1` |
| `remoteAgentHost` / `remoteAgentPort` | Termius 转发目标及对应远端 Agent 的实际监听地址和端口 |
| `projectParentDir` | Linux 实验项目父目录；最终项目为此目录加当前本机工作区名称 |
| `agentInstallDir` | 可选 runtime 安装目录；省略时为 `<projectParentDir>/simple_agent` |
| `condaEnv` | 可选完整环境目录，可精确到 `/bin/python`；显式空字符串用 `python3`，省略继承全局 `tunnel.condaEnv` |
| `enabled` / `maxConcurrentGpus` | 默认启用；GPU 上限为 `"auto"` 或 1–64 的整数 |

示例端口不是固定探测端口。插件按每个端点的真实值检测；无效端口、重复 ID/启用端口或非法路径会报配置错误，不回退到默认端口。路径保留中文、空格和大小写，不填 `~`、盘符、`.` 或 `..`。

### 选择拓扑并检测

当前统一使用 `simpleExperimentMac.topologyMode: "worker_pool"`，支持一台或多台明确启用的 Worker，没有至少两台的要求。旧 `single_worker` 仅兼容读取；`hub_worker` 和 Hub 执行已退役，不新增 Hub，也不使用旧字段补出目标。

在当前项目的服务器卡片保存连接，停用端点可设 `enabled: false`。新增 Worker 时核对唯一 ID、主机、账号、路径及独立本机端口。旧手动端点设置保留兼容读取；当前项目保存的连接不作为其他窗口的全局连接配置。

远端需要 Linux、可写 runtime 目录、Python 3.8+ 和 tmux。Agent 所需 PyYAML 随 runtime 离线分发，不要求系统或训练环境预装。SimpleSFTP 单独配置每台服务器的 SSH 身份；Termius 的凭据不会被读取。

### 准备项目与 Agent

1. 打开本机项目，保存有效拓扑与端点，在 SimpleSFTP 中配置各服务器认证。SSH 认证与 Agent HTTP 隧道分开，上传前无需 Agent 已运行。
2. 点击 **设置 → 服务器 → 准备项目与 Agent**，或按 **⇧⌘P → SimpleExperiment：准备 Agent 并启动**。运行环境准备区域的 **部署Agent** 按钮走同一流程。
3. 确认对话框列出每台服务器的 `用户名@主机:SSH端口`、最终项目目录及 runtime 安装目录。逐项核对后点击 **确认上传并查看指引**；取消不修改目标或上传。确认后端点/工作区变化会要求重新预览。
4. 插件通过 SimpleSFTP 分别上传最新版 runtime 与当前本机项目。项目遵循现有上传忽略规则，不自动清理远端文件。默认 runtime 位于 `<项目父目录>/simple_agent/simple_cluster/runtime/`；最终项目位于 `<项目父目录>/<当前工作区名称>/`。
5. 上传成功后打开下方的隧道与 tmux 指引。此时仅证明上传完成，尚未证明 Agent 就绪；不会擅自启动转发（需一键启动确认或 Termius 手动操作），不会重启 Agent 或停止远端实验。隧道就绪后点击 **检测全部**；Agent 启动由共同受管生命周期协议在受管启动时保障。

上传失败先核对 SimpleSFTP 的目标和认证、父目录权限及传输错误，再重试准备；已运行的实验保持原状态。这个准备流程已通过本地模拟测试，真实 SSH 和 M5 仍待验收。

### Agent/tmux 操作指引

“准备项目与 Agent”成功后自动打开指引。需要再次查看时，点击服务器卡片 **Agent/tmux 指引**，或运行 **SimpleExperiment Mac：打开 Agent/tmux 操作指引**；单独打开这个入口只生成文本，不传输文件。命令按当前端点、项目名、runtime 目录和 Python 路径生成。

Mac 没有可编辑的会话文件：**写入 Agent 自启动** 兼容入口返回真实回执（跳过原因 mac_openssh_managed_lifecycle），不假报写入；受管启动时 Agent 由共同受管生命周期协议拉起。手动核对仍可用以下方式：

1. 在对应服务器的 SSH 终端按指引接入已有 tmux 会话，或创建尚不存在的会话。
2. 已有 Agent 正在运行时只检查；仅在新会话或确认 Agent 未启动时执行生成的启动命令。配置改变不会自动重启远端进程。
3. 如设置了 `simpleExperimentMac.tunnel.agentToken`，在远端按指引交互输入同一 token；生成文本不会包含设置中的 token 值。
4. 按 **Ctrl+B，再按 D** 分离远端 tmux，保留 Agent 和实验。回插件点击 **检测全部**，检查版本、项目路径及 Worker 能力。

SSH 登录、转发打开和 Agent 可用分别核对；没有运行 Agent 时，SSH 成功并不代表检测通过。Mac 断线或插件更新后恢复 Termius 转发，先检查已有 tmux 会话；不因此停止或重复启动实验。

Mac 的版本/哈希检查只读，不会自动部署或重启。检查不一致或不可达时，Plan 前置校验会报告缺项，即使以前的连接状态显示正常也不能视为已就绪。需要升级 runtime 时主动点击 **准备项目与 Agent** 确认上传，在 Termius 核对任务后处理 Agent；不要终止训练 tmux。

## 6. 科研主流程与单台或多台 Worker

若 0.5.319 在运行前报“插件接入规则尚未同步到 Agent：invalid projectAdapterRules field”，可更新到 Mac 0.5.320 并重载窗口。该补丁发送规则副本时仅排除本机 `planDatasetMapping`，不删除已保存映射，不放宽 Agent 白名单，也不跳过运行前检查。Agent 接收协议保持不变，既有版本及就绪检查仍按实际结果处理；本轮未部署或重启 Agent。其他非法字段、离线或 Worker 失败仍须按实际反馈处理，更新不自动重跑计划或传输产物。

| 模式 | 使用方式 |
| --- | --- |
| 单台 Worker | `worker_pool`，只启用一台 Worker，由该 Worker 执行 |
| 多台 Worker | `worker_pool`，只使用明确启用的 Worker，按当前计划与配额派发 |

业务适配完成后按以下顺序接入：确认服务器与端点 → 部署并检测 Agent → 接入本地项目 → 在 `experiments/plans/` 写 Plan → 校验 `validatePlan` → 预演 `dryRunPlan` → 确认后 `runPlan` → 监控 → 结果预览与归档。业务 API 方法和 Plan 格式沿用现有契约，项目结构与结果约定见 [科研项目契约](plugin-project-contract.md)。

运行前核对最终远端项目路径、Plan revision、拓扑、启用 Worker、执行环境、GPU 限制与结果位置。文件传输由 SimpleSFTP 完成；正式实验不直接调用训练脚本代替 Plan。远端删除仍要求路径规范化、直接父目录核验及两次明确确认。

单台和多台 Worker、认证上传下载、中文路径和断连恢复仍需 M5 真机验收。首阶段更新成功不代表完整科研功能验收通过。

### 使用 project.bootstrap API

先按第 7 节读取当前 API 发现文件及实时 capabilities，确认方法和参数。`project.bootstrap` 不带 `confirm: true` 时返回确认预览；确认后返回 `operationId`，通过 `project.bootstrap.operation` 查询后台结果。

若上传完成但 Agent 尚未手动启动或检测未通过，操作记录为 `status: "blocked"`、`phase: "manual_start"`，提供 `manualStart.guide` 和后续 `calls`，不标记科研准备成功。按指引在 Termius 处理后，可从记录中的预览调用重新确认，使用 `deployRuntime: false`、`uploadProject: false`、`autoTest: true` 再次执行 `project.bootstrap`。这会产生新的操作记录，重新检测当前端点与 runtime 版本/哈希，避免重复上传；旧阻塞记录保留供查阅。只有检测与 Plan 校验均通过才记录成功，不会自动运行实验。

### Mac 结果路径与来源

#### 更新 Agent 与解析结果

扩展更新不会自动替换服务器 Agent。先通过 **准备项目与 Agent**核对并确认上传配套版本，在 Termius 手动处理 Agent 后点击 **检测全部**，保留正在运行的实验。

在 **结果区**选择完整 Plan，再点击 **解析结果**或**刷新结果**。选中具体路径、run key 或任务后，只解析明确匹配的来源；未找到选择项时返回空结果，不扩大到默认文件。没有明确选择时，使用该 Plan 的声明、关联 jobs 和适用的项目结果策略。任务完成不会自动下载，结果同步仍需手动触发。

核对预览中的 case、seed、指标、Plan 和原始来源，再使用现有归档入口。缺少可信 case、seed 或逐 seed 原始 CSV 的结果不能直接登记为正式科研表。正式运行仍按 `validatePlan` → `dryRunPlan` → `runPlan`，不直接运行训练脚本。

#### 中文、空格与 YAML 路径

Plan 与结果使用完整项目相对 POSIX 路径，区分大小写，保留 Unicode 拼写、真实首尾空格和字面 `%20`；字面 `%20` 不当作空格解码。不同目录的同名文件分别处理。含真实空格、`#` 或逗号时使用 YAML 引号，例如：

```yaml
result_csv: 'outputs/结果 A/ 指标.csv '
expectedResults:
  - 'outputs/结果 A/ 指标.csv '
```

引号内空格属于文件名；YAML 引号解码一次，单引号内的 `'` 写成 `''`。终端传递完整路径时同样加引号。不要使用 Windows 反斜杠、`./`、`..`、连续 `/` 或绝对路径作为 Plan/结果相对路径。

配套 Agent 的指定 Plan 输出契约与解析使用真实 YAML，支持列表、锚点和多行 scalar/命令，并使用插件独立管理的 PyYAML，不依赖科研 Python 环境。轻量预览不等同于 Agent 全文检查；出现预览差异时核对原 Plan 并运行 **检查输出契约**。`*`、`?`、`**` 按路径段区分大小写匹配，具体目录只匹配其声明范围。

#### 旧摘要与归档证据

请求、任务及结果行中的 `planFile`、`plan_file`、`plan`、`selectedPlanId` 和 provenance 归属须一致，revision 别名也须一致。旧摘要只在明确属于原始完整 Plan 时允许只读查看；用于当前业务时重新解析为受检摘要。

最终统计重新核对当前归档文件。旧归档条目必须明确属于同一原始 Plan；请求指定 revision 时，条目必须明确匹配该 revision。产物键保留原始路径，归档目录只覆盖自己的子项，不覆盖相似名称的邻居。匿名、其他 Plan/版本、修复过的路径或缺少版本的旧证据不用于当前最终统计；旧缓存的“已归档”标记也不能代替现有证据。有效空的 Plan 归档文件不会借用全局旧状态。

因此，更新后部分旧结果可能回到待审核预览。先核对 Plan、来源和版本，不手动改归档 JSON/标记来补证明。归档写入的完整 Mac 适配仍在进行，重新解析不会替旧归档补造身份，也不删除旧文件。缺少可信证据时保留预览，等待对应归档适配。

#### 项目汇总与最终表

预览种子表保留完整可信解析记录；严格 Plan 的最终 CSV/Markdown 仅由当前归档记录生成。没有当前归档证据时，最终表没有记录，完整预览仍可查看，不能把预览均值当作已审核的最终结论。

跨 Plan 项目表核对每个原始完整 Plan、索引/摘要、数据集与表路径；从受检原始 CSV 重新解析，按当前归档再计算并校验实际表内容。大小写、Unicode、首尾空格和字面 `%20` 分开处理，目录或文件集合变化也会使本次汇总失败。Finder 的普通 `.DS_Store` 文件不作为 Plan 目录或结果来源。

出现“项目聚合表与当前受检来源/归档证据不一致”或索引/摘要 revision 冲突时，按报错中的完整 Plan，在结果区点击 **解析结果**或**刷新结果**，再重试项目汇总。元数据身份不足时核对 Plan 与配套 Agent 版本；不要修改 CSV 指标或归档标记来绕过校验。本次失败不会继续发布部分项目表；检查到实际写入之间的原子锁定仍待完成。

项目汇总上限为 500 个 Plan 目录、50,000 行、128 MiB 输入快照；单个输入仍最多 5 MiB。超限会明确失败，不静默截断或借用其他 Plan 的表。历史文件保留，不自动清理。

#### 质量检查、统计与论文表

在结果区选择完整 Plan，依次点击 **运行质量门禁 → 运行统计 → 导出论文表格**。使用当前配置、实际原始 CSV 和当前归档重新计算，不沿用摘要中缓存的指标。路径/ID/行集合变化时先重新解析该 Plan；没有当前归档时保留预览，统计和论文表不会借用预览记录。

报告保留原始 Plan/revision；中文、大小写、Unicode、真实首尾空格和字面百分号分别处理。打开结果区报告路径查看对应 Plan 的质量或统计结果，不把项目最近一次报告当作另一个 Plan 的报告。论文表按数据集导出到项目 paper/tables/，文件名包含完整 Plan 的独立目录键。

出现“已归档结果与当前原始来源不一致”时，先核对实际 CSV 与当前 Plan，点击 **解析结果**或**刷新结果**后重新审核；不要修改缓存指标或归档 JSON。无效 UTF8、超过读取预算、文件/声明/配置/归档在检查中变化时，本次检查失败。单个输入最多 5 MiB，最多 50,000 行、240 个来源，快照总量 128 MiB，不静默截断。

导出先核对统计、论文表与声明输入，再发布本次产物；缺失或旧摘要仍沿用解析迁移，会刷新解析产物。多文件写入之间的物理原子锁定仍待完成。统计沿用现有实现；paired_t_normal_approx 为近似比较，正式论文的统计结论仍需独立复核，本地 fixture 不能作为科研实验。

#### 论文声明与证据引用

在结果区选择原始完整 Plan，先 **解析结果**或**刷新结果**，核对当前归档，再点击 **检查论文证据**。缺少声明时使用 **打开 claims.md**，在项目 `paper/claims.md` 中写入声明，按 UTF8 保存后重新检查。更新包与服务器 Agent 配套；更新后仍需主动使用 **准备项目与 Agent**，再按 Termius 手动步骤操作。

引用使用真实项目相对 POSIX 路径，支持 `experiments/results.csv`、`experiments/results/` 和 `experiments/runs/` 中的当前结果来源。含中文、空格、括号或标点时用反引号包住完整原名，例如：

```md
- 待验证结论 needs experiment，证据 `experiments/runs/中文 项目/指标 %20.csv`。
- 待验证结论 needs experiment，证据 [原始 CSV](experiments/runs/%E4%B8%AD%E6%96%87%20%E9%A1%B9%E7%9B%AE/%E6%8C%87%E6%A0%87%20%2520.csv)。
```

反引号中的路径不解码，保留原始大小写、Unicode 和首尾空格；Markdown 链接按 URI 解码一次，原名中的字面 `%20` 需编码为 `%2520`。`result id`、`runKey` 或 `证据` 后的 ID 必须原样来自当前受检结果，不能只写文件名或修改大小写。`paper/claims.md` 自身不能为其中的声明提供实验支持；目录引用须包含当前归档且经真实来源重解析的文件。

检查会重读声明、原始结果、Plan/配置和当前归档；缺少归档或当前结果 ID 已改变时保留 `unsupported` / `needs experiment`。`supported` 只表示找到了当前证据关联，科学结论仍需实验、统计检验和人工复核。缓存“已归档”、相似文件名和其他 Plan/revision 不能补足证据。

无效 UTF8、路径变体、损坏文件、读取中变化或预算超限会让本次检查失败。核对报错路径和 Agent，重新保存 UTF8 的声明，再按完整 Plan 重新解析和检查；不要改 CSV 指标或归档 JSON 绕过核验。声明最多 5 MiB、4,000 行，单行最多 16 KiB；历史文件保留。检查后到报告写入之间的物理原子锁定仍待完成。

#### 读取失败与验证边界

指定 Plan、jobs、结果和归档状态使用受检普通文件描述符读取，单个 Agent 输入最多 5 MiB，必须是有效 UTF8；解析与来源核验使用同一份内容。本机轻量结果/wrapper 读取预算为 4 MiB。扫描、条目、路径深度均有预算。依赖部署失败时按“Agent 离线依赖”修复受管 runtime；损坏 YAML/JSON、文件变更或超限时核对原文件，不跳过源码核验。

结果映射按原始来源核对路径、实际大小和 SHA-256。遇到“本机映射路径拼写与已有磁盘条目不一致”、来源/hash 冲突或文件身份变化时，查看实际目录和文件名，再重新确认映射；不要删空格、改大小写或强制覆盖来借用别的文件。这同样适用于默认不区分大小写的 Mac 磁盘。

本地验证覆盖真实编译模块、本机文件与隔离生成 Agent 的读取、解析、归档证据筛选及表消费，捕获发布而未运行真实科研。完整项目聚合发布、归档执行、完整 claim 报告发布、其他运行/写回执、物理原子发布及 M5 仍待验收；本机 fixture 的均值/标准差不构成科学实验结果。

## 7. 数据目录、API 与常见问题

| 内容 | Finder 路径 |
| --- | --- |
| Experiment API 发现 | `~/Library/Application Support/SimpleExperimentMac/api.json` |
| SFTP API 发现 | `~/Library/Application Support/SimpleSFTPMac/api.json` |
| 服务器配置 | `~/Library/Application Support/SimpleSFTPMac/server-profiles/servers.json` |
| 两插件共享租约 | `~/Library/Application Support/SimpleLocalMac/SimpleExperiment/` |

更新设置及扩展状态由 VS Code 管理，不迁移 Windows 原版数据库。不要手动修改租约或事务状态来绕过更新门禁。

API 每次调用前读取当前发现文件和 `/api/v1/capabilities` 或 `/api/v1/openapi.json`，从实时版本获取地址、token 和参数。CLI 名称为 `simpleex-mac`、`simple-sftp-mac-api`，保留原 npm 入口。VSIX 在受支持 Mac 激活时生成固定 POSIX 入口，更新并重载后指向当前包；终端需要 **Node.js 20 或以上**，插件不自动修改 PATH。

按 **⇧⌘P → SimpleExperiment Mac：查看 CLI 入口** 或 **SimpleSFTP Mac：查看 CLI 入口**，点击 **复制自检命令** 后粘贴到终端。也可直接运行：

```sh
"$HOME/Library/Application Support/SimpleExperimentMac/cli/simpleex-mac" self-check
"$HOME/Library/Application Support/SimpleSFTPMac/cli/simple-sftp-mac-api" self-check
```

自检仅核对 CLI、当前发现文件和本机 API health，不能证明 Agent、隧道或科研任务已就绪。固定入口保留调用时的工作目录及中文/空格/引号参数，旧实例不会把入口降到更低版本。用户可自行把两个组件的 `cli` 目录加入终端 PATH，再直接使用命令名，更新后无需重设。不要编辑生成的启动器来改变服务器目标；业务地址和参数仍来自当前发现文件及实时契约。若入口路径存在未知文件、链接或身份变化，插件拒绝覆盖；在 Finder 核对完整路径，按原删除确认规则处理，不通过改写租约或未知文件绕过检查。

固定入口、版本更新与参数保持通过真实本地 shell/Node 和本机 API 模拟测试；CLI 业务命令和 M5 验收继续分批。

两款 CLI 的业务 RPC 自动重读当前发现文件、获取 `/api/v1/capabilities` 并核对方法与监听身份，再发送原参数。若方法不可用、预检期间扩展重载或监听变化、发现地址不是本机、HTTP/JSON 响应错误，调用失败且不会自动重试业务。先打开对应扩展并执行自检，核对实时契约后再主动调用；不要复用旧 token 或改发现文件来绕过失败。`confirm`、`pathConfirmed` 保持调用者提供的值，仍须遵守原路径确认规则。自行使用 HTTP API 时仍需自行完成发现与契约查询；CLI 自检仅访问 health，不能代替科研就绪检测。

Plan CLI 先在终端进入与当前 VS Code 窗口相同的项目目录，然后使用已保存的 Plan：

```sh
"$HOME/Library/Application Support/SimpleExperimentMac/cli/simpleex-mac" experiment run "experiments/plans/基线.yaml" --check --dry-run --json
```

在线检查读取当前工作区与 `workflow.plan` 路由；未就绪、Plan 选择不符或工作区变化会阻止运行。离线只预览本地信息，输出 `validation: local_only`、`ready: false`，不能证明服务器或科研任务就绪。此 CLI 检查不执行完整远端预演；正式插件路线仍负责 validate → dry-run → upload → submit。

去掉 `--check --dry-run` 才申请 `workflow.run`，随后在 VS Code 确认。初始 `requested: true`、`submitted: false`、`waiting_confirmation` 和 `operationId` 是等待确认的本地回执，不表示实验已在远端运行；使用实时契约中的 `operations.list` 核对后续操作状态与提交证据，取消或失败时不要盲目重复运行。项目外或链接逃逸的 Plan 拒绝，中文/真实首尾空格保留。旧 `run --name … -- command` 入口继续保留为手工本地记录器，正式科研使用配置和 Plan；真实科研的单台或多台 Worker 流程仍待后续验证。

Mac API 的 `workspace` 必须指向当前窗口已打开的同一个真实项目目录。服务端在准备、校验与提交的关键异步边界复核目录身份；切换窗口项目或替换目录后会拒绝继续，请重新打开正确项目并预检。晚到的运行回执不写入另一个项目。若检测到已有活动 Plan，会阻止新提交；Mac 路线不通过旧自动停止 fallback 停止原实验，用户主动选择“停止并重新运行”仍保留人工确认。

提交后等待证据时，请保持当前窗口项目；切换项目后的活动记录不会证明原请求已提交成功，需回到原项目重新核对操作和远端状态。人工重试在读取旧任务、确认与精确停止前复核目录身份；多 Worker 分布式路线在异步同步、预演、历史产物选择及排队关键边界继续复核。变化后不会把原回执写进另一项目或继续派发；已经在远端运行的实验保持原状。

Mac Plan 选择请使用完整项目相对路径，例如 `experiments/plans/中文/A.yaml`。`A.yaml` 与 `a.yaml`、不同目录及文件名真实首尾空格分别保留；字面 `%20` 不转换为空格，Unicode 拼写不自动改写。面板选择、保存选择、提交身份和分布式重试不再合并这些不同路径。多个 Plan 使用同一显示名时必须选完整路径；错误完整路径不会退回另一个已选 Plan。终端参数加引号，查看实际文件名后重新选择，不靠改变大小写或删空格绕过失败。此批通过编译队列、真实生成面板与后台方法的本地模拟验证；结果/监控及完整科研仍继续适配，M5 未验收。

Plan 目录默认为 `experiments/plans`，在 Mac 设置 `simpleExperimentMac.planDir` 中填写实际项目相对目录；保留中文和真实空格，不填绝对路径、反斜杠或 `..`。扫描与单文件摘要按实际目录条目区分大小写，YAML 文件名末尾真实空格也会保留。Plan 目录以下的符号链接和非普通文件会拒绝；读取期间文件、内容或工作区变化时，不使用该次结果，请核对文件后重新识别并预检。显式错误 Plan 不会自动改选唯一的另一个 Plan。摘要保留原读取预算和截断标记，完整本地配置检查读取全文。分布式路径合同、预演及入队使用真实相对路径，坏路径不会自动改成另一目录。以上通过编译模块与 POSIX 文件系统模拟验证；远端 Agent 输出路径、归档写入、结果/监控与 M5 验收仍继续分批。

Agent 持久队列的 Plan/outputDir 身份、接收回执、旧队列派发及 recall/停止匹配也保留真实大小写、Unicode、字面 %20 和首尾空格；非法相对路径或非字符串不自动改写后接收。旧 queued 行的坏路径会等待处理，运行中记录不自动修改。该检查需服务器使用配套新版 Agent：更新扩展后，通过“准备项目与 Agent”核对并确认上传，在 Termius 手动启动后再检测；不要为升级中断已有实验。Agent 启动参数与 scheduler 的正式输出、历史只读 attempt 子目录、工作目录、声明输入/输出及 Plan 状态 key 同样保留真实拼写。Plan 必须是项目内现有普通文件；已有路径条目按实际名称核对，符号链接、别名冲突和非法路径会在启动前拒绝。依赖检测后再次检查路径与原 Plan revision；原 Plan 读取全文，不受摘要预算限制。以上仅通过隔离编译函数和模拟 POSIX 文件系统验证；检查到实际启动/写入之间仍有变化窗口，结果/归档写入、真实科研与 M5 继续适配。出现路径身份冲突时核对原 Plan、完整回执和远端状态，不盲目重发。

在保存的 Plan 中配置正式种子列表 `seeds`，然后重新校验与预演。在线 `experiment run --seed …` 与 API `workflow.plan`/`workflow.run` 的 `seed` 参数会报“不支持 seed 覆盖”，不静默忽略；删去覆盖参数后再调用。离线预览不应用 `--seed`，返回 `seedApplied: false` 与 `seedWarning`。旧手工本地记录器 `run --seed` 保留，不能当作正式 Plan 运行。

| 现象 | 操作 |
| --- | --- |
| 业务面板打不开 | 使用底部 Mac preview 状态栏或命令面板检查更新 |
| 找不到更新通知 | 手动检查，然后运行“安装 preview 配套更新” |
| 配置说明 Markdown 预览不可用 | 插件回退为文本打开同一份说明 |
| 仍看到 Xshell 字段或旧命令 | 使用“配置 Termius 手动端点”“准备项目与 Agent”和“Agent/tmux 指引”；不在 Mac 上配置 `.xsh` 文件 |
| 上传完成但 Agent 检测失败 | 在对应 Termius 终端核对实际 Python 环境、tmux 中的 Agent、端口和当前项目路径；上传不会自动启动 Agent |
| 手动端点保存后报错 | 核对完整字段、整数端口、唯一 ID/启用端口及绝对 POSIX 路径；在用户设置 JSON 修改 |
| 路径无效、目标冲突或 Agent 项目路径不一致 | 逐项核对大小写、中文、目录名首尾空格和完整绝对路径，清除 `.`、`..` 或控制字符；不要通过放宽允许目录或删除空格绕过确认 |
| 服务器列表为空 | 打开共享服务器配置填写真实目标，再选择服务器 |
| Termius 已登录但传输失败 | 运行“SimpleSFTP Mac：配置服务器认证”，核对该目标的地址、用户名、SSH 端口与方式；两插件不读取 Termius 凭据 |
| 隧道已打开但 Agent 不可达 | 核对记录的端点、远端 Agent 是否运行和实际环境；勿重启运行中的实验 |
| Windows 旧设置没有出现 | Mac 扩展身份和命名空间独立，按本文填写 Mac 设置 |

## 正式任务、结果与PLAN审核

新增操作和参考提交见[2026-10-13功能说明](windows-sync-2026-10-13.md)。新runtime需空闲后由用户主动更新并检测；旧Worker缺正式身份环境、无attempt停止或shell预检能力时拒绝操作，现有实验继续。失败job“重新排队此 job”遇占用输出会引导“审核遗留文件”，只读预览精确原job；审核执行和返回卡片重排分别确认，成功同伴和PLAN保持原状。

整个正式Plan成功后，声明产物经SimpleSFTP在启用Worker间自动镜像；身份/路径/owner/SHA冻结，冲突和离线保留未完成项。结果解析、汇总与发布仍手动，原始文件不因此下载到本机。可通过live API的`tasks.preflight`、`tasks.preflight.status`、`tasks.preflight.cancel`检查原失败job，`environmentOnly: true`仅验证配置shell；先读discovery和capabilities，不使用诊断代替真实运行。

| 页面入口 | Mac操作与结果 |
| --- | --- |
| GPU区 | 按服务器及GPU编号查看固定容器内任务标签。当前用户须与设置前缀及完整本机派发/Worker回执匹配；其他用户/未知负载继续显示，不靠SSH用户名推断 |
| Plan区 → 校验并提交运行 | 校验、预演后使用Plan声明的稳定输出目录及CSV。Worker须具备`declaredJobPaths: true`；旧Agent按“准备项目与 Agent”手动升级并重新检测，现有实验不中断 |
| 执行区 → 失败/不可用任务 | 先查看精确拒绝原因及任务身份。启动前拒绝显示未启动；未知保持未知。正式失败不会自动增attempt重跑，人工处理保留原始历史 |
| 结果区 → 解析/刷新/同步结果 | 按当前Plan/revision/owner只读读取CSV、JSON、日志及二进制，内存解析后保存摘要和来源SHA/大小；不新建原始下载副本。现存文件与旧attempt历史保留 |
| Plan区 → 清除 PLAN 及关联产物 | 打开独立审核页，选择操作并“完整预览”，核对所有节点/精确路径/所有权，再按页面确认。离线项留待只读核查和重新预览；不会重连后自动清理 |

新正式任务不创建`attempts/…`子目录，不直接覆盖已有正式产物；旧attempt只用于历史读取，旧draft真实执行会明确拒绝。目录冲突需先人工核对原运行/产物，不能通过改名伪造新的身份。macOS尚无可靠打开文件句柄证明，清理执行报`HANDLE_CHECK_UNAVAILABLE`时保持阻断；永久删除的两次确认及物理直接父目录检查仍然必要。

参考提交和本地测试见[Windows功能同步说明](windows-sync-2026-10-12.md)。发布及验证规则见 [Mac 发布与验收](mac-release-guide.md)。本地验证与 M5 真机验证分别记录；真机测试由用户安排，未执行的项目不标记通过。

## Agent 离线依赖

自 Experiment Mac 0.5.326 / SFTP Mac 0.2.107 起，辅助 Agent 与 Scheduler 使用固定的 PyYAML 6.0.3。依赖锁、上游源包摘要、未修改的纯 Python 包与 MIT LICENSE 保存在源码 vendor/python；构建验证锁定摘要后将离线 zip 内嵌到 cluster_agent.py、cluster_scheduler.py，原有 runtime 哈希和上传核验同时覆盖依赖内容。没有额外联网安装步骤，不需要 pip、ensurepip、venv 系统包或编译器。

运行环境为机器现有 Python 标准库加插件自己的版本化依赖目录，不是训练 Conda 环境，也不在系统 site-packages 安装。受管启动使用解析到的绝对 sys.executable，加 -I -S 隔离标志，忽略终端激活、PYTHONPATH、用户及系统 site-packages。检查、依赖发布和启动使用同一解释器；训练命令和所选训练环境保持原配置。依赖文件位于实际 runtime 所在目录的 .python-dependencies，仅发布固定摘要的 zip，不展开项目或历史产物。损坏的受管 zip 从同一已验内嵌包原子修复，历史版本目录不自动清理。

首次安装、从 0.5.325 升级或修复部署：安装本 Release 两份 Mac VSIX 并 Reload Window，按现有“准备项目与 Agent”确认目标后上传 runtime。配套 SFTP 在停止旧 Agent 的指定窗口前先检查离线依赖；失败时保留旧 Agent，返回 AGENT_RUNTIME_DEPENDENCY_FAILED，包含解释器、PyYAML 版本、受管路径、原始原因和修复指引。正常受管 ensure/restart 继续核对完整 runtime 文件哈希，不采纳未知依赖、不更改研究环境。停止和只读 inspect 不安装依赖；旧协议调用不强制启用新依赖检查。

服务器离线时仍使用同样的两份脚本，不需要连接 PyPI。若 runtime 不完整、校验失败、目标是链接或目录不可写，请先通过原准备流程重新部署已验证脚本，或修正该受管 runtime 目录权限后重试；不要删除配置、计划、结果或任务历史，不要给训练环境重复安装 PyYAML。

手动诊断可使用“同一绝对解释器 -I -S 实际 cluster_agent.py 路径 runtime-check”；所有路径从当前配置/进程读取，不照搬示例机器或端口。此命令只准备受管依赖并返回 JSON，不连接 Agent、不启动训练。Agent /health 的 runtimeDependencies 字段报告实际解释器、sys.prefix、yaml 模块来源、版本、摘要和 safeLoad 能力。能力检查实际解析含锚点、列表及多行命令的 YAML，计划仍使用 yaml.safe_load，不改回正则。

本轮仅在 Windows 与本机隔离 Linux Worker 环境验证；不是用户服务器验收，也未部署、重启或自动提交用户训练。请在授权的受管更新完成后核对实际 Agent 为 0.5.329，再只做依赖核验与提交前检查。

## Scheduler 协议探测

0.5.326 将离线 PyYAML 数据嵌入 Scheduler 后，旧的前 8192 字符扫描看不到后面的协议声明。即使桌面、Agent 和 Scheduler 同为 0.5.326，也可能返回 projectManagedValidation=0 等七项误判；不要把这种情况简单当作旧包未更新。

Mac 0.5.327 对实际 Scheduler 文件作完整 AST 静态解析，只接受顶层、唯一且类型正确的字面量声明，并核对版本、对应实现入口及运行 Agent 已记录的配对文件摘要。不 import/exec Scheduler，不按固定文件位置判断，也不把读取窗口改成更大数字。沿用受管 runtime 的 8 MiB 文件上限，只有完整文件在预算内才解析；超限拒绝，不静默截断。

/api/capabilities 中的 schedulerProtocol 给出实际文件路径、Agent/Scheduler 版本、声明、缺失项及配对摘要核验结果。status=ok 表示这次解析与配对通过；unsupported 表示真实缺少协议或实现入口；read_error 表示文件缺失、权限或文件预算问题；parse_error 表示编码、语法或声明解析失败；version_mismatch 表示实际版本不同；runtime_mismatch 表示磁盘 Scheduler 与运行 Agent 的配对文件凭据不同。桌面刷新探测和提交前检查保留这些原因，不统一要求重复升级。

更新至 0.5.327 后，仍须通过原受管流程部署配对 Agent/Scheduler 并重启指定实例。首次准备的延迟核验路径和单独 ensure/restart 路径都会清除所选 Worker 的旧能力记录，其他 Worker 不受影响。之后“检测/刷新”从当前配置端点读取新能力。应核对 schedulerProtocol.status、schedulerVersion 与七项能力，不只看桌面版本号。停止/重启不自动提交训练，不清空配置、历史或结果。

本机回归仅使用最终打包文件、隔离 HTTP 端点和受控生命周期回执；真实用户服务器的在线能力、目标进程及缓存刷新仍需在授权的 Mac 受管更新后核验。

## 文件打开与源码输入

0.5.328 修正 Path.open 模式被当作文件路径的问题。内置 open(file, mode)、io.open 及其导入别名从 file/第一个位置参数取路径，从 mode/第二个位置参数取模式；已确认的 Path 实例从接收对象取路径，从 mode/第一个位置参数取模式。默认模式为 r；read_text/read_bytes 从接收对象读取。导入别名和词法作用域内遮蔽会参与识别，不把其他对象的 .open 一律认作 Path。

纯 w/a/x 模式是输出访问，不要求日志文件提交前存在，即使输出 Path 的值是动态的。r、默认读取以及含 + 的读写模式保守要求核验已有输入，包括 a+ 可能读取的既有字节；不会只要看到 a 就忽略 a+。若同一个模式变量有多个已知值，只要可能读取，就保留输入核验。摘要读取仍作为完整性依赖，未消费的发布元数据不展开。

未知接收对象/文件 API、未知模式或展开的 *args/**kwargs 不会被猜成文件路径或纯输出。错误包含源码文件、行号、依赖链及 source_dependencies.inputs（摘要访问用 integrity）声明指引；已知读取路径依旧收集，动态部分只能在明确声明输入后保守通过，并在 conservative 中说明。动态读取路径沿用同一显式声明契约，不自动改用户 PLAN 或代码。声明的文件仍须存在、位于项目内且通过原字节核验与大小限制。

桌面、包内 Agent/Scheduler 均为 0.5.329，SFTP 沿用 0.2.107。安装和重载后，实际服务器仍须按原受管流程更新配对运行时。本轮只验证隔离依赖核验和提交前分支，不连接服务器、不启动训练，保留全部配置及历史产物。

0.5.329 在上述契约上补齐展开参数：即使 *args/**kwargs 让模式未知，Path 接收对象或已知第一个路径参数仍须核验，不能因用户另行声明一份输入就漏掉已知文件。只对真正未知的路径依赖显式声明；已知路径缺失、越界或变化继续拒绝。0.5.328 已发布包保留，本次追加更高补丁。
