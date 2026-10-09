# SimpleExperiment Mac 配置说明

面向 Apple Silicon、macOS 26 及以上的 VS Code 用户。快速入口见 [README](../README.md)，文件传输配置见 [SimpleSFTP Mac 使用说明](https://github.com/zlinkw/SimpleSFTP-Mac/blob/master/readme.md)。

**当前 preview 已交付独立安装与配套更新入口，完整科研业务仍在适配。** 本文区分可以立即使用的本机配置与后续 Termius 接入流程。M5 真机更新、认证传输和三拓扑尚未验收；界面中保留的 Xshell 自动配置、启动会话和“准备 Agent 并启动”入口暂不适用于 Mac。

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

已有 `~/.ssh/config` 可运行 **SimpleSFTP：导入 VS Code SSH 配置** 导入连接描述；它读取本机 OpenSSH 配置，不读取 Termius 私有会话。当前传输仍依赖系统 SSH 配置，独立密钥、ssh-agent、密码和私钥口令的认证界面及 SecretStorage 记忆正在适配。**导入或选择配置不等于已验证认证成功。** Termius 登录也不会自动授权 SimpleSFTP。首次上传/下载及断连恢复请以后续版本说明和真机验证为准。

## 5. Termius 手动隧道接入（后续业务适配）

以下是 Mac 科研接入的操作约定，端点保存、Agent 部署和检测界面仍在适配；当前不要用旧 Xshell 自动启动功能执行这些步骤。

1. 在 [Termius](https://termius.com/) 中自行配置 Linux 主机、SSH 端口和认证，手动登录。
2. 为每台需要连接的服务器建立本地端口转发（Local port forwarding）：本机监听使用 loopback，目标是该服务器的 Agent 监听地址与端口。
3. 手动启动转发并保持 Termius 连接；每个服务器使用不同的本机监听端口。记录真实端点，以后填入插件的对应服务器配置。
4. SimpleSFTP 单独配置同一台服务器的 SSH 身份，用插件传输 runtime；Termius 的登录凭据不由插件读取。
5. 在 Termius 终端按 Agent/tmux 指引启动或接入现有会话，再由插件检测版本、项目路径和 Worker 状态。

端点记录示例仅用于理解，**不是固定探测端口**：

| 角色 | 本机监听 | 在对应 SSH 主机上的转发目标 |
| --- | --- | --- |
| Hub | `127.0.0.1:18765` | `127.0.0.1:18765` |
| Worker A | `127.0.0.1:18766` | `127.0.0.1:18765` |
| Worker B | `127.0.0.1:18767` | `127.0.0.1:18765` |

单 Worker 不需要 Hub；多 Worker 各自维护转发；Hub/Worker 模式同时记录 Hub 和所有启用 Worker 的端点。Agent 不启动时，单有 SSH 登录和转发不能使 Agent 检测通过。

远端需要 Linux、可写的项目父目录、Python 3、tmux，以及实际执行环境中的 PyYAML。可在用户已登录的 Termius 终端查看 `python3 --version`、`tmux -V`；环境名、目录和会话名以你的服务器为准。恢复连接时重新启动手动转发并检查现有 tmux 会话，不因本机断线或插件更新停止远端实验。

## 6. 科研主流程与三种拓扑

| 模式 | 使用方式 |
| --- | --- |
| 单 Worker `single_worker` | 一台执行机，无 Hub |
| 多 Worker `worker_pool` | 多台 Worker 分片执行，无 Hub |
| Hub/Worker `hub_worker` | Hub 调度与汇总，Worker 执行 |

业务适配完成后按以下顺序接入：确认服务器与端点 → 部署并检测 Agent → 接入本地项目 → 在 `experiments/plans/` 写 Plan → 校验 `validatePlan` → 预演 `dryRunPlan` → 确认后 `runPlan` → 监控 → 结果预览与归档。业务 API 方法和 Plan 格式沿用现有契约，项目结构与结果约定见 [科研项目契约](plugin-project-contract.md)。

运行前核对最终远端项目路径、Plan revision、拓扑、启用 Worker、执行环境、GPU 限制与结果位置。文件传输由 SimpleSFTP 完成；正式实验不直接调用训练脚本代替 Plan。远端删除仍要求路径规范化、直接父目录核验及两次明确确认。

这三种拓扑、认证上传下载、中文路径和断连恢复仍需 M5 真机验收。首阶段更新成功不代表完整科研功能验收通过。

## 7. 数据目录、API 与常见问题

| 内容 | Finder 路径 |
| --- | --- |
| Experiment API 发现 | `~/Library/Application Support/SimpleExperimentMac/api.json` |
| SFTP API 发现 | `~/Library/Application Support/SimpleSFTPMac/api.json` |
| 服务器配置 | `~/Library/Application Support/SimpleSFTPMac/server-profiles/servers.json` |
| 两插件共享租约 | `~/Library/Application Support/SimpleLocalMac/SimpleExperiment/` |

更新设置及扩展状态由 VS Code 管理，不迁移 Windows 原版数据库。不要手动修改租约或事务状态来绕过更新门禁。

API 每次调用前读取当前发现文件和 `/api/v1/capabilities` 或 `/api/v1/openapi.json`，从实时版本获取地址、token 和参数。CLI 名称为 `simpleex-mac`、`simple-sftp-mac-api`，源码 npm 包提供入口，VSIX 安装不会保证它们进入 shell PATH。

| 现象 | 操作 |
| --- | --- |
| 业务面板打不开 | 使用底部 Mac preview 状态栏或命令面板检查更新 |
| 找不到更新通知 | 手动检查，然后运行“安装 preview 配套更新” |
| 配置说明 Markdown 预览不可用 | 插件回退为文本打开同一份说明 |
| 仍看到 Xshell 字段或按钮 | 属于待适配的旧业务入口，不在 Mac 上配置 `.xsh` 文件 |
| 服务器列表为空 | 打开共享服务器配置填写真实目标，再选择服务器 |
| Termius 已登录但传输失败 | SimpleSFTP 认证独立；核对自己的系统 SSH 配置，独立认证入口尚待交付 |
| 隧道已打开但 Agent 不可达 | 核对记录的端点、远端 Agent 是否运行和实际环境；勿重启运行中的实验 |
| Windows 旧设置没有出现 | Mac 扩展身份和命名空间独立，按本文填写 Mac 设置 |

发布及验证规则见 [Mac 发布与验收](mac-release-guide.md)。本地验证与 M5 真机验证分别记录；真机测试由用户安排，未执行的项目不标记通过。
