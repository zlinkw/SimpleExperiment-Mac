# Hub 退役复核

## 2026-10-29 当前 Worker 流程复核

当前支持一台或多台 Worker，统一 worker_pool；单 Worker 不需要额外控制节点。本文下面的 0.5.311 记录是历史修复背景，不能作为当前配置教程。当前入口为 [使用说明](simple-experiment-setup.md)、[最小项目接入](experiment-integration.md) 和 [配置字段参考](configuration-reference.md)。

本轮发现并修正的有效残留：

| 区域 | 发现 | 当前处理 |
| --- | --- | --- |
| 面板与引导 | 拓扑帮助、旧操作标签、搜索词、就绪/结果提示仍出现可用的控制节点描述 | 正常流程统一显示 Worker；旧入口明确标记退役 |
| 结果操作按钮 | 缺少 Worker 能力时，有一个旧项目级回退条件绕过按钮侧阻断 | 直接按对应 Worker 能力阻断，不再假定旧控制节点可处理 |
| 命令确认 | 批量 PLAN 确认仍描述进入旧全局队列和汇总目录 | 改为当前 Worker 队列、原执行产物及用户勾选的服务器同步范围 |
| runtime 与生成模板 | 两处旧错误文案、生成的项目说明仍误称控制节点 | 使用当前 Worker 或明确退役分支；不改变旧拒绝协议 |
| 配置文档 | setup 和旧多隧道文档仍教新建 Hub，参数表与当前注册值不一致 | 重写当前使用说明，旧链接转到 Worker 说明，列出全部注册设置与实际覆盖边界 |
| 项目接入契约 | 旧默认 attempt、强制项目特定双 CSV、共享大表、自动科研校验等内容与新协议矛盾 | 明确协议 2 / declared 路径、通用命令与最小指标适配；保留消费项目的科研责任 |

以下仍包含名称但不是可执行 Hub 功能：

- 旧 schema 中的 hubHost、hubUser、hub_job_dir、hub_console_log，以及历史事件/结果解码；不能补成新连接或新结果身份。
- runtime manifest 的 hub_agent 组件键和旧组件类型，是现有 Agent 文件的兼容传输标识；部署目标仍只来自已启用 Worker。直接改名会破坏旧协议，不能靠换拼写声称功能已去除。
- HubControlApi、旧 start/upload 等兼容入口明确拒绝；服务端与 CLI 对新退役目标请求保留 HUB_REMOVED 等错误。
- 旧持久化角色联合类型、CSS 类和诊断读取结构；端点工厂拒绝新 Hub，历史登记进入执行 registry 前排除它。
- 少量历史命名的内部状态辅助符号仍被复用；它们不产生独立角色或目标，不应以全局字符串替换改动其兼容语义。
- GitHub 发布、更新、PR 与仓库功能不属于已退役的集群角色。

没有清空任何用户连接、任务、产物或状态记录；没有连接训练服务器部署或停止旧服务。回归覆盖实际生成 HTML 的卡片/帮助/按钮判断、Worker 端点与端口目标，以及真实 Python runtime 中退役执行入口的隔离 AST 片段。验证与发行的真实结果以本批日志和最终交付记录为准。

0.5.439 最终候选的 `npm run package -- --max-parallel 1` 完成 318 项规定作业，全部通过；独立面板帮助测试 5 项通过。生成面板脚本与 vm.Script 语法门禁、VSIX 身份/内容策略和运行依赖闭包检查通过。当前指南的 6 段 YAML、1 段 Python 与相对文件链接已做语法检查；模板未作为科研实验运行。安装重载后的交互与远端部署不由这些本机检查代替。

## 本轮范围

以 0.5.311 的通知残留为入口，同时核对连接、准备、同步、清理、结果来源、命令、设置、前端及 Python runtime。GitHub 发布和检查更新不属于退役对象。未连接、停止或清理旧 Hub 服务，未修改用户的服务器配置。

| 区域 | 复核与处理 | 回归 |
| --- | --- | --- |
| 通知、准备与同步摘要 | 移除 Hub 健康/依赖门禁、同步状态与提示；全部启用 Worker 继续检查，零 Worker 不报告就绪 | hubRuntimeRemoval、tunnelTestCompletionClarity、automaticSyncReadiness、projectCodeSyncState |
| 实时端点与启动 | ProviderRealtime 仅构建 Worker，忽略历史 Hub 标志；工厂拒绝新 Hub 端点，读取旧端点存档时排除 Hub | hubRuntimeRemoval、workerOnlyTopology、workerRouting |
| 设置与面板 | 移除 Hub 模式选项、Hub 启动命令定义、诊断块、虚构 Agent 卡和连接图节点；每个 Worker 继续使用自己的动态端点 | hubRuntimeRemoval、panelWebviewScriptHealth |
| 清理 | 旧清理收集分支不再将顶层旧会话/目录拼成 Hub 目标；受管流程仍查询当前 Worker 及实际文件 | cleanupMissingTargets、planCleanup、manifestCleanup |
| 结果与归档 | 删除 Hub 下载回退和旧远端归档中转；结果来源不明明确报错；调试包改为按原 Worker 或用户选择来源 | windowsWorkflowContract、remoteResultInspectionWorkflow、resultOwnershipScope |
| CLI | 移除通过顶层 Hub/tunnel 配置直接连接文件 API 的旧中转；本地产物操作保留，远端下载使用已有 Worker 结果页或 SimpleSFTP | simpleCli、windowsWorkflowContract |
| Python Agent | 删除旧跨节点采集器；其旧 run 入口明确拒绝。普通事件与超长事件降级均生成 Worker 标识，不再生成 Hub 身份 | hubRetirement 的隔离 AST 夹具 |
| 兼容边界 | 旧 Hub 配置/事件/路径字段可保留读取，退役 API 保留明确拒绝；均不能创建当前连接或运行目标 | hubRuntimeRemoval、hubRetirement、workerRouting |

## 剩余名称的解释

仓库仍存在 Hub 拼写，不能把“搜索零命中”作为迁移成功标准：历史 schema 字段、旧事件解码、退役入口的 HUB_REMOVED 错误和 GitHub 名称必须区分。它们不得恢复为 Hub 能力，也不得成为普通 Worker 操作的前置条件。

本轮不清除真实状态目录、用户旧配置或历史产物。新链路尚须重载和远端升级后的实际入口验收；之后依据具体路径、使用者与主动查询证据确定弃用缓存，不通过删除记录来掩盖仍未确认的启动/停止请求。
