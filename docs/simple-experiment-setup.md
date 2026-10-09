# SimpleExperiment Mac 配置说明

面向 Apple Silicon、macOS 26 及以上的 VS Code 用户。快速入口见 [README](../README.md)，文件传输配置见 [SimpleSFTP Mac 使用说明](https://github.com/zlinkw/SimpleSFTP-Mac/blob/master/readme.md)。

**当前 preview 已交付独立安装、配套更新、Termius 手动端点配置、项目与 runtime 上传及 Agent/tmux 指引，完整科研业务仍在适配。** M5 真机更新、独立认证传输和三拓扑尚未验收。Mac 不使用 Xshell 会话文件；“准备项目与 Agent”需确认后上传，Agent 和隧道由用户在 Termius 手动启动。

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

## 5. Termius 手动隧道与端点配置

在 [Termius](https://termius.com/) 中自行配置 Linux 主机、SSH 端口和认证，手动登录。为每个端点建立 **本地端口转发（Local port forwarding）**，本机监听使用 loopback，目标为该 SSH 主机上的 Agent 监听地址与端口。手动启动转发并保持 Termius 连接。

### 保存端点

打开 SimpleExperiment 面板 **设置 → 服务器 → 配置手动端点**，或按 **⇧⌘P → SimpleExperiment Mac：配置 Termius 手动端点**。在打开的设置页搜索结果中编辑 `tunnel.manualEndpoints`；数组在 JSON 中编辑。

这是全局应用设置，使用 **Preferences: Open User Settings (JSON)** 打开用户 `settings.json`，不要写入项目 `.vscode/settings.json`。将以下字段合并到已有 JSON，不覆盖其他设置。下面是单 Worker 示例，主机、用户、端口和路径都需替换为自己的实际配置：

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
| `id` / `role` | Worker ID 唯一，含小写字母、数字、点、下划线或连字符；Hub 固定为 `id: "hub"`、`role: "hub"` |
| `host` / `user` / `sshPort` | 真实 SSH 主机、登录用户和 SSH 端口；HTTP 检测只请求下方转发端点，不用这些字段自动登录 |
| `localForwardHost` / `localForwardPort` | Termius 在 Mac 上实际监听的地址和端口；每个启用端点的端口唯一，可使用 `::1` |
| `remoteAgentHost` / `remoteAgentPort` | Termius 转发目标及对应远端 Agent 的实际监听地址和端口 |
| `projectParentDir` | Linux 实验项目父目录；最终项目为此目录加当前本机工作区名称 |
| `agentInstallDir` | 可选 runtime 安装目录；省略时为 `<projectParentDir>/simple_agent` |
| `condaEnv` | 可选完整环境目录，可精确到 `/bin/python`；显式空字符串用 `python3`，省略继承全局 `tunnel.condaEnv` |
| `enabled` / `maxConcurrentGpus` | 默认启用；GPU 上限为 `"auto"` 或 1–64 的整数 |

示例端口不是固定探测端口。插件按每个端点的真实值检测；无效端口、重复 ID/启用端口或非法路径会报配置错误，不回退到默认端口。路径保留中文、空格和大小写，不填 `~`、盘符、`.` 或 `..`。

### 选择拓扑并检测

在面板 **设置 → 服务器 → Mac 服务器拓扑** 选择模式，点击 **保存拓扑**；也可在当前项目工作区设置写 `simpleExperimentMac.topologyMode`：

- `single_worker`：启用一个 Worker，当前模式不使用 Hub。
- `worker_pool`：启用至少两个 Worker，当前模式不使用 Hub。
- `hub_worker`：配置并启用 Hub，加至少一个 Worker。

模式保存在当前项目；手动端点保存在用户设置。新增 Worker 时复制数组中的 Worker 对象，修改 ID、主机、账号、路径和本机端口。Hub 使用相同字段结构，ID/角色改为 `hub`，使用独立本机端口。停用端点可设 `enabled: false`。

远端需要 Linux、可写项目父目录、Python 3、tmux，实际执行环境还需 PyYAML。SimpleSFTP 单独配置每台服务器的 SSH 身份；Termius 的凭据不会被读取。

### 准备项目与 Agent

1. 打开本机项目，保存有效拓扑与端点，在 SimpleSFTP 中配置各服务器认证。SSH 认证与 Agent HTTP 隧道分开，上传前无需 Agent 已运行。
2. 点击 **设置 → 服务器 → 准备项目与 Agent**，或按 **⇧⌘P → SimpleExperiment Mac：准备项目与 Agent（手动启动）**。运行环境准备区域的同名按钮也可使用。
3. 确认对话框列出每台服务器的 `用户名@主机:SSH端口`、最终项目目录及 runtime 安装目录。逐项核对后点击 **确认上传并查看指引**；取消不修改目标或上传。确认后端点/工作区变化会要求重新预览。
4. 插件通过 SimpleSFTP 分别上传最新版 runtime 与当前本机项目。项目遵循现有上传忽略规则，不自动清理远端文件。默认 runtime 位于 `<项目父目录>/simple_agent/simple_cluster/runtime/`；最终项目位于 `<项目父目录>/<当前工作区名称>/`。
5. 上传成功后打开下方的 Termius/tmux 指引。此时仅证明上传完成，尚未证明 Agent 就绪；不会自动登录、启动转发、重启 Agent 或停止远端实验。按指引手动操作后点击 **检测全部**。

上传失败先核对 SimpleSFTP 的目标和认证、父目录权限及传输错误，再重试准备；已运行的实验保持原状态。这个准备流程已通过本地模拟测试，真实 SSH 和 M5 仍待验收。

### Agent/tmux 操作指引

“准备项目与 Agent”成功后自动打开指引。需要再次查看时，点击服务器卡片 **Agent/tmux 指引**，或运行 **SimpleExperiment Mac：打开 Agent/tmux 操作指引**；单独打开这个入口只生成文本，不传输文件。命令按当前端点、项目名、runtime 目录和 Python 路径生成。

1. 在对应服务器的 Termius 终端按指引接入已有 tmux 会话，或创建尚不存在的会话。
2. 已有 Agent 正在运行时只检查；仅在新会话或确认 Agent 未启动时执行生成的启动命令。配置改变不会自动重启远端进程。
3. 如设置了 `simpleExperimentMac.tunnel.agentToken`，在远端按指引交互输入同一 token；生成文本不会包含设置中的 token 值。
4. 按 **Ctrl+B，再按 D** 分离远端 tmux，保留 Agent 和实验。回插件点击 **检测全部**，检查版本、项目路径及 Worker 能力。

SSH 登录、转发打开和 Agent 可用分别核对；没有运行 Agent 时，SSH 成功并不代表检测通过。Mac 断线或插件更新后恢复 Termius 转发，先检查已有 tmux 会话；不因此停止或重复启动实验。

Mac 的版本/哈希检查只读，不会自动部署或重启。检查不一致或不可达时，Plan 前置校验会报告缺项，即使以前的连接状态显示正常也不能视为已就绪。需要升级 runtime 时主动点击 **准备项目与 Agent** 确认上传，在 Termius 核对任务后处理 Agent；不要终止训练 tmux。

## 6. 科研主流程与三种拓扑

| 模式 | 使用方式 |
| --- | --- |
| 单 Worker `single_worker` | 一台执行机，无 Hub |
| 多 Worker `worker_pool` | 多台 Worker 分片执行，无 Hub |
| Hub/Worker `hub_worker` | Hub 调度与汇总，Worker 执行 |

业务适配完成后按以下顺序接入：确认服务器与端点 → 部署并检测 Agent → 接入本地项目 → 在 `experiments/plans/` 写 Plan → 校验 `validatePlan` → 预演 `dryRunPlan` → 确认后 `runPlan` → 监控 → 结果预览与归档。业务 API 方法和 Plan 格式沿用现有契约，项目结构与结果约定见 [科研项目契约](plugin-project-contract.md)。

运行前核对最终远端项目路径、Plan revision、拓扑、启用 Worker、执行环境、GPU 限制与结果位置。文件传输由 SimpleSFTP 完成；正式实验不直接调用训练脚本代替 Plan。远端删除仍要求路径规范化、直接父目录核验及两次明确确认。

这三种拓扑、认证上传下载、中文路径和断连恢复仍需 M5 真机验收。首阶段更新成功不代表完整科研功能验收通过。

### 使用 project.bootstrap API

先按第 7 节读取当前 API 发现文件及实时 capabilities，确认方法和参数。`project.bootstrap` 不带 `confirm: true` 时返回确认预览；确认后返回 `operationId`，通过 `project.bootstrap.operation` 查询后台结果。

若上传完成但 Agent 尚未手动启动或检测未通过，操作记录为 `status: "blocked"`、`phase: "manual_start"`，提供 `manualStart.guide` 和后续 `calls`，不标记科研准备成功。按指引在 Termius 处理后，可从记录中的预览调用重新确认，使用 `deployRuntime: false`、`uploadProject: false`、`autoTest: true` 再次执行 `project.bootstrap`。这会产生新的操作记录，重新检测当前端点与 runtime 版本/哈希，避免重复上传；旧阻塞记录保留供查阅。只有检测与 Plan 校验均通过才记录成功，不会自动运行实验。

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

去掉 `--check --dry-run` 才申请 `workflow.run`，随后在 VS Code 确认。初始 `requested: true`、`submitted: false`、`waiting_confirmation` 和 `operationId` 是等待确认的本地回执，不表示实验已在远端运行；使用实时契约中的 `operations.list` 核对后续操作状态与提交证据，取消或失败时不要盲目重复运行。项目外或链接逃逸的 Plan 拒绝，中文/真实首尾空格保留。旧 `run --name … -- command` 入口继续保留为手工本地记录器，正式科研使用配置和 Plan；真实科研三拓扑仍待后续验证。

Mac API 的 `workspace` 必须指向当前窗口已打开的同一个真实项目目录。服务端在准备、校验与提交的关键异步边界复核目录身份；切换窗口项目或替换目录后会拒绝继续，请重新打开正确项目并预检。晚到的运行回执不写入另一个项目。若检测到已有活动 Plan，会阻止新提交；Mac 路线不通过旧自动停止 fallback 停止原实验，用户主动选择“停止并重新运行”仍保留人工确认。

提交后等待证据时，请保持当前窗口项目；切换项目后的活动记录不会证明原请求已提交成功，需回到原项目重新核对操作和远端状态。人工重试在读取旧任务、确认与精确停止前复核目录身份；多 Worker 分布式路线在异步同步、预演、历史产物选择及排队关键边界继续复核。变化后不会把原回执写进另一项目或继续派发；已经在远端运行的实验保持原状。

Mac Plan 选择请使用完整项目相对路径，例如 `experiments/plans/中文/A.yaml`。`A.yaml` 与 `a.yaml`、不同目录及文件名真实首尾空格分别保留；字面 `%20` 不转换为空格，Unicode 拼写不自动改写。面板选择、保存选择、提交身份和分布式重试不再合并这些不同路径。多个 Plan 使用同一显示名时必须选完整路径；错误完整路径不会退回另一个已选 Plan。终端参数加引号，查看实际文件名后重新选择，不靠改变大小写或删空格绕过失败。此批通过编译队列、真实生成面板与后台方法的本地模拟验证；结果/监控及完整科研仍继续适配，M5 未验收。

Plan 目录默认为 `experiments/plans`，在 Mac 设置 `simpleExperimentMac.planDir` 中填写实际项目相对目录；保留中文和真实空格，不填绝对路径、反斜杠或 `..`。扫描与单文件摘要按实际目录条目区分大小写，YAML 文件名末尾真实空格也会保留。Plan 目录以下的符号链接和非普通文件会拒绝；读取期间文件、内容或工作区变化时，不使用该次结果，请核对文件后重新识别并预检。显式错误 Plan 不会自动改选唯一的另一个 Plan。摘要保留原读取预算和截断标记，完整本地配置检查读取全文。分布式路径合同、预演及入队使用真实相对路径，坏路径不会自动改成另一目录。以上通过编译模块与 POSIX 文件系统模拟验证；远端 Agent 输出路径、归档写入、结果/监控与 M5 验收仍继续分批。

Agent 持久队列的 Plan/outputDir 身份、接收回执、旧队列派发及 recall/停止匹配也保留真实大小写、Unicode、字面 %20 和首尾空格；非法相对路径或非字符串不自动改写后接收。旧 queued 行的坏路径会等待处理，运行中记录不自动修改。该检查需服务器使用配套新版 Agent：更新扩展后，通过“准备项目与 Agent”核对并确认上传，在 Termius 手动启动后再检测；不要为升级中断已有实验。本批仅隔离编译函数与本机队列验证，实际启动参数、scheduler 输出/状态、结果/归档写入和 M5 仍继续适配。出现路径身份冲突时核对原 Plan、完整回执和远端状态，不盲目重发。

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

发布及验证规则见 [Mac 发布与验收](mac-release-guide.md)。本地验证与 M5 真机验证分别记录；真机测试由用户安排，未执行的项目不标记通过。
