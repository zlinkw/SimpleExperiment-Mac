# 人工待删除候选

本文件只记录需要整体删除的完整文件或目录候选，不记录文件内部的局部内容调整。清单不授权 Codex 删除、移动、清空或暂存删除任何项目文件；用户应逐项审核，并仅由用户本人手动删除。后续发现确认无用的完整文件或目录时，继续追加准确的仓库相对路径，禁止使用通配符代替路径。

## 2026-09-19 远端误上传候选

| 路径 | 类型 | 原因 | 风险与依赖 | 发现日期 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `/data/qgking/zlk/MultiModal/cluster_agent.py` | file | SimpleSFTP 将本应部署到 Agent runtime 目录的文件写到了项目根目录；正式运行时使用 `/data/qgking/zlk/simple_agent/simple_cluster/runtime/cluster_agent.py`。 | 上传可能覆盖同名旧文件。删除前须核实远端内容、调用方及运行中的进程；本清单不授权删除。 | 2026-09-19 | 待审核 |
| `/data/qgking/zlk/MultiModal/cluster_scheduler.py` | file | 同次目标解析错误将 Scheduler 文件写到了项目根目录；正式运行时使用 `/data/qgking/zlk/simple_agent/simple_cluster/runtime/cluster_scheduler.py`。 | 上传可能覆盖同名旧文件。删除前须核实远端内容、调用方及运行中的进程；本清单不授权删除。 | 2026-09-19 | 待审核 |
| `/data/qgking/zlk/simple_agent/cluster_agent.py` | file | 再次上传时文件落在 Agent 安装目录根部，而正式运行时使用 `simple_cluster/runtime/cluster_agent.py`。 | 上传可能覆盖同名旧文件。删除前须核实远端内容、调用方及运行中的进程；本清单不授权删除。 | 2026-09-19 | 待审核 |
| `/data/qgking/zlk/simple_agent/cluster_scheduler.py` | file | 同次上传将 Scheduler 文件落在 Agent 安装目录根部，而正式运行时使用 `simple_cluster/runtime/cluster_scheduler.py`。 | 上传可能覆盖同名旧文件。删除前须核实远端内容、调用方及运行中的进程；本清单不授权删除。 | 2026-09-19 | 待审核 |

## 状态说明

- `待审核`：证据表明文件大概率无用，但尚未由用户确认。
- `保留观察`：可能无用，但当前恢复、审计或追溯仍可能依赖。
- `用户已删除`：仅在用户明确报告已手动删除后更新；该状态本身不授权 Git 删除。
- `已授权删除`：用户在 2026-07-26 明确授权按本清单清理，且删除前已逐条校验绝对路径前缀为 `D:\GitRepo\MCP\simple-experiment`。

## 2026-07-26 授权清理裁决

- 历史 VSIX 一律不处理：`simple-experiment-0.2.2.vsix`、`simple-experiment-0.2.2-xshell-only.vsix`、`simple-experiment-0.2.4.vsix`、`simple-experiment-0.2.6.vsix` 保留，遵循 `docs/target-mode-plan.md` 的固定边界。
- `src/test/fakes/FakeRemoteCommandRunner.ts` 保留：`test/engineeringHardening.test.js` 仍引用其编译产物，文档所列风险条件不成立。
- `保留观察` 两项未授权，维持原状。
- 已授权范围共 48 项，其中 47 项由 `git rm` 删除并可从 Git 历史恢复，`dist/runtime/__pycache__/` 为可再生字节码缓存。
- 删除后全量静态测试 765/765 通过；用例数由 780 降至 765，差额即随 7 个废弃别名测试文件一起移除的用例。

## 待审核候选

| 路径 | 类型 | 原因 | 风险与依赖 | 发现日期 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `-First` | 文件 | PowerShell 参数被误写成文件名；内容是旧 Git 状态与目标计划片段。 | 删除前确认其中旧计划内容已由 Git 历史和当前计划覆盖。 | 2026-07-22 | 已授权删除 |
| `-Path` | 文件 | PowerShell 参数被误写成文件名；内容是 `AgentTmuxPolicy` 源码副本。 | 删除前确认正式实现仍在 `src/tunnel/AgentTmuxPolicy.ts`，且无脚本引用此根目录副本。 | 2026-07-22 | 已授权删除 |
| `-Raw` | 文件 | PowerShell 参数被误写成文件名；内容是旧目标计划副本。 | 删除前确认当前计划和 Git 历史足以追溯。 | 2026-07-22 | 已授权删除 |
| `.vscodeignore}else{'NO` | 文件 | 损坏命令产生的异常文件名；内容是 `.vscodeignore` 片段和命令残留。 | 删除前与正式 `.vscodeignore` 对照，避免遗漏有效打包规则。 | 2026-07-22 | 已授权删除 |
| `package.json)` | 文件 | 损坏命令产生的旧 `package.json` 副本，名称不是 Node manifest。 | 删除前确认当前 `package.json` 已包含需要的历史配置；不得用该副本覆盖当前 manifest。 | 2026-07-22 | 已授权删除 |
| `src/extension.ts).Length` | 文件 | 损坏命令输出的长度片段，不是有效 TypeScript 源文件；正式实现位于 `src/extension.ts`。 | 删除前确认无脚本或恢复记录直接引用该异常路径。 | 2026-07-23 | 已授权删除 |
| `src/ui/PanelHtml.ts).Length` | 文件 | 损坏命令输出的长度片段，不是有效 TypeScript 源文件；正式实现位于 `src/ui/PanelHtml.ts`。 | 删除前确认无脚本或恢复记录直接引用该异常路径。 | 2026-07-23 | 已授权删除 |
| `src/ui/PanelHtml.ts)[994]` | 文件 | 损坏命令输出的源码片段，不是有效 TypeScript 源文件；正式实现位于 `src/ui/PanelHtml.ts`。 | 删除前确认恢复审计不再需要该片段。 | 2026-07-23 | 已授权删除 |
| `scripts/tmp-dump-task-card.js` | 文件 | 一次性 UI 源码片段导出脚本，仅生成临时文本。 | 删除前确认不再用于恢复 `renderTaskCard`。 | 2026-07-22 | 已授权删除 |
| `scripts/tmp-inspect-task-card.js` | 文件 | 一次性 UI 检查脚本，只打印源码片段。 | 删除前确认正式测试已覆盖对应检查。 | 2026-07-22 | 已授权删除 |
| `scripts/tmp-patch-task-ui.js` | 文件 | 一次性源码改写脚本，会直接修改 `src/ui/PanelHtml.ts`。 | 不应再次执行；删除前确认其预期修改已进入已验证提交。 | 2026-07-22 | 已授权删除 |
| `scripts/tmp-task-card-block.txt` | 文件 | `tmp-dump-task-card.js` 生成的源码片段缓存。 | 删除前确认恢复审计不再需要该快照。 | 2026-07-22 | 已授权删除 |
| `dist/runtime/__pycache__/` | 目录 | Python 语法验证生成的字节码缓存，不属于 VSIX runtime 源文件。 | 删除前确认没有正在运行的本地 Python 进程依赖该缓存；删除不影响已提交的 `cluster_agent.py`。 | 2026-07-23 | 已授权删除 |
| `src/services/RemoteExecutionService.ts` | 文件 | 旧直连远端执行服务；当前活动扩展入口未导入，现行通信由 Xshell 本地隧道和 Agent 承担。 | 删除前确认无外部测试或历史恢复工具直接导入该类。 | 2026-07-22 | 已授权删除 |
| `src/services/RuntimeService.ts` | 文件 | 旧 runtime 服务封装；当前活动扩展入口未导入，Agent runtime 已由现行部署流程管理。 | 与 `src/runtime/RuntimeManager.ts` 存在内部依赖，需两者一起审核。 | 2026-07-22 | 已授权删除 |
| `src/runtime/RuntimeManager.ts` | 文件 | 旧 runtime 管理实现；仅由旧 `RuntimeService` 引用，当前活动扩展入口未导入。 | 删除前确认恢复审计和独立测试不再依赖旧 runtime 接口。 | 2026-07-22 | 已授权删除 |
| `src/remote/RemoteFileStore.ts` | 文件 | 旧远端文件存储实现；当前文件传输边界已迁移到 SimpleSFTP。 | 删除前确认无外部脚本直接导入，且 SimpleSFTP 已覆盖所需文件操作。 | 2026-07-22 | 已授权删除 |
| `src/test/fakes/FakeRemoteCommandRunner.ts` | 文件 | 旧直连远端命令测试替身；当前活动源码和现行测试未引用。 | 删除前确认不再用于恢复旧迁移测试。 | 2026-07-22 | 待审核 |
| `src/tunnel/MobaXtermCommandBuilder.ts` | 文件 | 已废弃客户端的 Xshell 别名包装；活动实现已直接使用 `XshellTunnelCommandBuilder.ts`。 | 用户删除前确认活动源码与测试均不再导入该包装。 | 2026-07-23 | 已授权删除 |
| `src/tunnel/MobaXtermIntegration.ts` | 文件 | 已废弃客户端的 Xshell 集成别名；活动实现已直接使用 `XshellTunnelIntegration.ts`。 | 用户删除前确认 VSIX 闭包门禁通过且活动入口不再导入。 | 2026-07-23 | 已授权删除 |
| `src/tunnel/MobaXtermLauncher.ts` | 文件 | 已废弃客户端的 Xshell 启动别名；活动实现已直接使用 `XshellTunnelLauncher.ts`。 | 用户删除前确认 Xshell 启动测试通过。 | 2026-07-23 | 已授权删除 |
| `src/tunnel/MobaXtermPortProbe.ts` | 文件 | 已废弃客户端的端口探测别名；活动实现已直接使用 `XshellTunnelPortProbe.ts`。 | 用户删除前确认隧道探测测试通过。 | 2026-07-23 | 已授权删除 |
| `src/tunnel/MobaXtermProcessLauncher.ts` | 文件 | 安装包激活失败涉及的废弃启动别名；活动入口已改用 `XshellProcessLauncher.ts`。 | 用户删除前确认新 VSIX 主入口闭包完整。 | 2026-07-23 | 已授权删除 |
| `src/tunnel/MobaXtermSetup.ts` | 文件 | 已废弃客户端的配置别名；活动类型与归一化只使用 `XshellTunnelSetup.ts`。 | 用户删除前确认服务器配置读写测试通过。 | 2026-07-23 | 已授权删除 |
| `src/tunnel/LegacyTunnelCompat.ts` | 文件 | 仅用于已明确停止支持的旧客户端配置迁移；活动配置不再读取或写入。 | 用户删除前确认现有 Xshell 配置已保存为当前字段。 | 2026-07-23 | 已授权删除 |
| `dist/tunnel/MobaXtermCommandBuilder.js` | 文件 | 上述废弃源码的编译产物，不属于活动 VSIX 闭包。 | 用户应与对应源码一起删除；构建前确认源码已删除，防止重新生成。 | 2026-07-23 | 已授权删除 |
| `dist/tunnel/MobaXtermIntegration.js` | 文件 | 上述废弃源码的编译产物，不属于活动 VSIX 闭包。 | 用户应与对应源码一起删除；新包已排除。 | 2026-07-23 | 已授权删除 |
| `dist/tunnel/MobaXtermLauncher.js` | 文件 | 上述废弃源码的编译产物，不属于活动 VSIX 闭包。 | 用户应与对应源码一起删除；新包已排除。 | 2026-07-23 | 已授权删除 |
| `dist/tunnel/MobaXtermPortProbe.js` | 文件 | 上述废弃源码的编译产物，不属于活动 VSIX 闭包。 | 用户应与对应源码一起删除；新包已排除。 | 2026-07-23 | 已授权删除 |
| `dist/tunnel/MobaXtermProcessLauncher.js` | 文件 | 上述废弃源码的编译产物，曾被错误排除并导致活动入口崩溃；活动入口现已解除依赖。 | 用户应与对应源码一起删除；新包闭包不得引用。 | 2026-07-23 | 已授权删除 |
| `dist/tunnel/MobaXtermSetup.js` | 文件 | 上述废弃源码的编译产物，不属于活动 VSIX 闭包。 | 用户应与对应源码一起删除；新包已排除。 | 2026-07-23 | 已授权删除 |
| `dist/tunnel/LegacyTunnelCompat.js` | 文件 | 已停止支持的旧客户端配置迁移编译产物，不属于活动 VSIX 闭包。 | 用户应与对应源码一起删除；新包已排除。 | 2026-07-23 | 已授权删除 |
| `test/tunnel/mobaxtermCommandBuilder.test.js` | 文件 | 仅测试废弃别名，Xshell 命令构建已有独立测试。 | 用户删除前确认 `xshellCommandBuilder.test.js` 通过。 | 2026-07-23 | 已授权删除 |
| `test/tunnel/mobaxtermExecutableDetection.test.js` | 文件 | 仅测试废弃别名，Xshell 可执行文件检测已有独立测试。 | 用户删除前确认 `xshellExecutableDetection.test.js` 通过。 | 2026-07-23 | 已授权删除 |
| `test/tunnel/mobaxtermIntegrationCheck.test.js` | 文件 | 仅测试废弃别名，Xshell 集成检查已有独立测试。 | 用户删除前确认 `xshellIntegrationCheck.test.js` 通过。 | 2026-07-23 | 已授权删除 |
| `test/tunnel/mobaxtermLauncher.test.js` | 文件 | 仅测试废弃别名，Xshell 启动已有独立测试。 | 用户删除前确认 `xshellLauncher.test.js` 通过。 | 2026-07-23 | 已授权删除 |
| `test/tunnel/mobaxtermPortProbe.test.js` | 文件 | 仅测试废弃别名，Xshell 端口探测已有独立测试。 | 用户删除前确认 `xshellPortProbe.test.js` 通过。 | 2026-07-23 | 已授权删除 |
| `test/tunnel/mobaxtermRealtimeSetup.test.js` | 文件 | 仅测试废弃别名，Xshell 实时配置已有独立测试。 | 用户删除前确认 `xshellRealtimeSetup.test.js` 通过。 | 2026-07-23 | 已授权删除 |
| `test/tunnel/multiMobaXtermCommandBuilder.test.js` | 文件 | 仅测试废弃别名，多端点 Xshell 命令已有独立测试。 | 用户删除前确认 `multiXshellCommandBuilder.test.js` 通过。 | 2026-07-23 | 已授权删除 |
| `docs/mobaxterm-real-integration-checklist.md` | 文件 | 已废弃客户端的真实联调说明，与仅允许 Xshell 的现行边界冲突。 | 用户删除前确认 Xshell 联调说明已覆盖所需验收项。 | 2026-07-23 | 已授权删除 |
| `docs/mobaxterm-tunnel-full-feature-acceptance.md` | 文件 | 已废弃客户端的全功能验收说明，与仅允许 Xshell 的现行边界冲突。 | 用户删除前确认 Xshell 全功能验收说明已覆盖所需条目。 | 2026-07-23 | 已授权删除 |
| `scenarios/mobaxterm-agent-api-incompatible.json` | 文件 | 已废弃客户端场景；现行 Agent API 兼容测试不依赖该场景。 | 用户删除前确认对应 Xshell/通用能力测试覆盖。 | 2026-07-23 | 已授权删除 |
| `scenarios/mobaxterm-agent-unreachable.json` | 文件 | 已废弃客户端场景；通用 Agent 不可达场景已由隧道测试覆盖。 | 用户删除前确认通用不可达测试通过。 | 2026-07-23 | 已授权删除 |
| `scenarios/mobaxterm-custom-port.json` | 文件 | 已废弃客户端场景；Xshell 自定义端口由现行端口测试覆盖。 | 用户删除前确认 Xshell 端口测试通过。 | 2026-07-23 | 已授权删除 |
| `scenarios/mobaxterm-custom-port-realtime.json` | 文件 | 已废弃客户端场景；Xshell 实时端口由现行测试覆盖。 | 用户删除前确认多隧道测试通过。 | 2026-07-23 | 已授权删除 |
| `scenarios/mobaxterm-exe-not-found.json` | 文件 | 已废弃客户端场景；已有 `xshell-exe-not-found.json`。 | 用户删除前确认 Xshell 对应场景可用。 | 2026-07-23 | 已授权删除 |
| `scenarios/mobaxterm-file-api-missing.json` | 文件 | 已废弃客户端场景；通用文件能力门禁已有测试。 | 用户删除前确认文件 API 能力测试通过。 | 2026-07-23 | 已授权删除 |
| `scenarios/mobaxterm-local-port-closed.json` | 文件 | 已废弃客户端场景；Xshell/通用本地端口关闭已有测试。 | 用户删除前确认端口探测测试通过。 | 2026-07-23 | 已授权删除 |
| `scenarios/mobaxterm-local-port-occupied.json` | 文件 | 已废弃客户端场景；现行端口冲突修复已有测试。 | 用户删除前确认端口冲突测试通过。 | 2026-07-23 | 已授权删除 |
| `scenarios/mobaxterm-one-click-config.json` | 文件 | 已废弃客户端场景；现行一键配置只允许 Xshell。 | 用户删除前确认 Xshell 配置向导测试通过。 | 2026-07-23 | 已授权删除 |
| `scenarios/mobaxterm-real-check-success.json` | 文件 | 已废弃客户端场景；Xshell 真实联调由现行验收说明覆盖。 | 用户删除前确认 Xshell 集成检查测试通过。 | 2026-07-23 | 已授权删除 |
| `scenarios/mobaxterm-realtime-connect.json` | 文件 | 已废弃客户端场景；现行实时连接只使用 Xshell。 | 用户删除前确认实时重连测试通过。 | 2026-07-23 | 已授权删除 |
| `scenarios/mobaxterm-tunnel-health-ok.json` | 文件 | 已废弃客户端场景；通用隧道健康检查已有测试。 | 用户删除前确认 Xshell 健康检查测试通过。 | 2026-07-23 | 已授权删除 |
| `simple-experiment-0.2.2.vsix` | 文件 | 首轮恢复候选包仍包含内部人工清理文档，不作为交付包。 | 用户删除前确认后续 `r2` 包存在且哈希已记录。 | 2026-07-23 | 待审核 |
| `simple-experiment-0.2.2-xshell-only.vsix` | 文件 | 第二轮候选包意外包含 5 个已废弃直连模块，不作为交付包。 | 用户删除前确认后续 `r2` 包不包含这些模块且运行时闭包通过。 | 2026-07-23 | 待审核 |
| `simple-experiment-0.2.4.vsix` | 文件 | 打包时误包含本机 `.local-gpt` 助手状态文件，不作为交付包。 | 用户删除前确认 `simple-experiment-0.2.5.vsix` 已生成，且包内容差异只保留预期代码、版本和清单变化。 | 2026-07-24 | 待审核 |
| `simple-experiment-0.2.6.vsix` | 文件 | 首次 `0.2.6` 打包后才确认仍包含 3 个仅供测试的 `dist/test`、`dist/testing` 模块；不作为最终交付包。 | 用户删除前确认 `simple-experiment-0.2.7.vsix` 已生成，runtime 闭包通过且包内不再含测试模块。 | 2026-07-24 | 待审核 |

## 保留观察

| 路径 | 类型 | 暂不删除原因 | 重新评估条件 | 发现日期 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `_baseline_facts.md` | 文件 | 当前仍记录已安装版抽屉布局恢复依据。 | 完成 UI、Extension、全量测试和安装包差异验收后再评估。 | 2026-07-22 | 保留观察 |
| `simple_cluster/reports/acceptance/acceptance_report_2026-07-03T17-31-17-239Z.md` | 文件 | 是旧版失败验收记录，可能仍用于恢复差异追溯。 | 新版 acceptance 全量通过并生成独立审计报告后再评估。 | 2026-07-22 | 保留观察 |

## 维护规则

1. 只记录需要整体删除的完整文件或目录，并使用准确的仓库相对路径；不记录通配符或整个仓库根目录。
2. 每项必须写明原因、风险、依赖、发现日期和状态。
3. 删除废弃代码、修改配置项、移除重复段落等局部内容调整不进入本清单，由 Codex 按正常编辑流程直接修改并验证。
4. 局部修改后文件必须保留有效内容；不得截断为空、清空全文，或以空内容覆盖代替整体文件删除。
5. Codex 不执行完整文件或目录删除、不移动到回收站、不清空内容、不使用 `git rm`，也不暂存删除状态。
6. 用户手动删除后，如需提交删除记录，应另行明确要求，并先检查 Git diff 与依赖。
