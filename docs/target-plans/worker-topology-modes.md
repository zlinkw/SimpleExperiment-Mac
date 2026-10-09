# 目标计划：三类服务器拓扑与无 Hub 自调度

## 状态

- 目标 ID：`worker-topology-modes`。
- 状态：静态实施已完成；三种拓扑已覆盖配置、UI、Worker 本机调度、Plan 级人工目标选择、结果归属和归档门禁。
- 证据状态：第二十五轮完整非服务器静态测试通过 856/856；全部真实服务器行为仍为 `needs field verification`。

## 目标

插件不再把 Hub 当作所有用户的必选前提。服务器模式固定划分为三类：

1. **单 Worker 模式**：仅配置一台 Worker，不要求 Hub。Plan、调度状态、日志、结果和归档均由该 Worker 本机维护。
2. **仅多 Worker 模式**：配置两台及以上 Worker，不要求 Hub。每次提交 Plan 时由用户人工选择一台 Worker，该 Worker 独立调度完整 Plan；不选举临时 Hub，也不建立 Worker 间控制链路。
3. **Hub 可用模式**：配置 Hub 和至少一台 Worker，沿用 Hub 全局排队、Worker 执行、Hub 汇总索引的现有链路。

三种模式共享同一套 Plan、结果、归档和 UI 对象契约。切换拓扑不能迁移、覆盖、删除或重新解释已有任务与结果。

## 模式选择

- 新增项目级 `topologyMode`，取值固定为 `single_worker`、`worker_pool`、`hub_worker`。
- 向导可根据已启用端点给出建议，但最终模式必须由用户明确保存；Hub 临时离线不得自动把 `hub_worker` 切成无 Hub 模式。
- `single_worker` 必须恰有一台启用 Worker；`worker_pool` 必须至少两台；`hub_worker` 必须有一个 Hub 和至少一台 Worker。
- 配置数量与模式不一致时阻止新运行，并给出可执行修复入口；已有任务仍可查看和恢复。
- 模式变更必须经过强确认，展示调度所有者、状态保存位置、结果保存位置及不会执行的备份链路。

## 无 Hub 调度契约

### 单 Worker

- 插件通过该 Worker 的 Xshell 本地隧道提交完整 Plan。
- Worker Agent 在本机启动 scheduler，自行探测本机 GPU、排队、重试、停止和恢复任务。
- 调度状态、事件 journal、任务日志、结果索引和归档 manifest 只写入该 Worker 的项目命名空间。
- 本机 VS Code 只负责低频控制、状态展示和用户触发的文件传输，不承担远程调度循环。

### 仅多 Worker

- 每台 Worker 都运行独立 scheduler，不允许某台 Worker 充当隐式 Hub，也不允许 Worker 之间直接控制或同步状态。
- 提交运行前必须人工选择一个已检测在线的 Worker；选择结果写入 operation、任务和结果归属。
- 目标 Worker 接收并调度完整 Plan，只探测本机 GPU，只保存本机任务及结果。
- 本机 VS Code 只负责目标选择、低频控制和状态展示，不运行 scheduler、不自动分片、不汇总为权威 Hub 状态。
- 跨 Worker 总览由插件合并各 Worker 经 Xshell 隧道返回的有界状态；该合并结果仅用于显示，不成为新的权威运行状态。

## 保存、归档与备份边界

- 两种无 Hub 模式均禁止尝试 Hub 上传、Hub 结果汇总、Worker 到 Hub 同步、Hub 索引写入和跨节点自动备份。
- Worker 本机项目目录是任务、日志、结果和归档的唯一远端权威来源；离线时保留最后已知状态并明确标记过期，不伪造 Hub 副本。
- “不备份”指不创建 Hub、本机或其他 Worker 的自动副本。用户主动通过 SimpleSFTP 下载、导出调试包或迁移归档仍是显式文件操作，不得被后台流程自动触发。
- 结果归档仍遵循有效结果筛选、预览 CSV 与最终 CSV 契约，但归档包只在所属 Worker 本机生成和保存。
- runtime 覆盖前的同机安装回滚副本属于部署安全措施，不得被当作实验结果备份；是否保留该措施应在实现批次中单独审计并在 UI 中明确区分。
- Hub 可用模式继续保留现有 Hub 汇总和归档链路，但不得读取无 Hub revision 的 Worker 本地结果并冒充已完成 Hub 汇总。

## 通信与安全边界

- 三种模式下，本机插件面向服务器的通信都必须经过用户已配置的 Xshell 本地隧道。
- 文件上传下载只使用 SimpleSFTP；不得增加插件内 SSH、SCP、rsync 或一次性远程连接。
- 无 Hub 模式不得为了复用旧 API 而连接不存在的 Hub 端口，也不得高频轮询全部 Worker。
- Worker 状态继续使用至少 60 秒采样周期、事件推送和有界快照；断连重试必须使用退避与抖动。

## UI 契约

- 设置页先选择拓扑模式，再显示对应端点字段；无 Hub 模式隐藏 Hub 必填项和 Hub 专属操作，但保留旧入口的只读兼容说明。
- 概览、资源树、运行确认和路径强确认窗口必须显示当前模式及调度所有者。
- `single_worker` 显示“Worker 本机调度”；`worker_pool` 显示“人工选择 Plan 调度 Worker”；`hub_worker` 显示“Hub 全局调度”。
- 无 Hub 模式不显示“等待 Hub”“同步到 Hub”“Hub 备份”等阻塞或成功状态。
- 归档详情必须显示唯一保存 Worker、项目目录和归档位置，并提示该结果没有自动远端副本。

## 兼容与迁移

- 现有同时配置 Hub 与 Worker 的项目默认解释为 `hub_worker`，不修改已有配置文件。
- 仅有 Worker 的旧配置不得静默启动任务；首次运行前要求用户确认 `single_worker` 或 `worker_pool`。
- 保留现有命令 ID、Plan 格式和任务标识。旧 Hub 入口在无 Hub 模式下返回明确的模式不适用提示，不删除 handler。
- 模式字段必须随项目配置和归档 manifest 保存，使恢复版本仍能区分原始调度拓扑。

## 实施流水

### topology-001 配置与领域模型

- 增加拓扑枚举、项目级持久化、旧配置推断和一致性校验。
- 更新设置向导、运行门禁和强确认摘要。
- 静态覆盖三种合法模式、数量不匹配、Hub 临时离线和旧配置迁移。

### topology-003 Worker 本机 scheduler

- 让单 Worker 接收完整 Plan 并在本机运行现有 scheduler 能力。
- 状态、日志、结果和归档全部落在 Worker 项目命名空间。
- 禁用 Hub 请求、Hub 同步和自动备份分支。
- 静态验证已覆盖 Plan 路由、Worker 动作白名单、Hub 不回退、Xshell 启动目标和无 Hub 可用性上报门禁；真实服务器未连接。

### topology-004a 多 Worker 人工 Plan 目标

- 每个 Plan 提交前显示 Worker 选择器，只允许选择已检测在线且具备 Plan action capability 的 Worker。
- Worker 请求只保留目标 Worker 配置和 owner，并设置 `workerPoolDispatchPolicy=manual_plan_target`；scheduler 建立完整 Plan 队列。
- Worker Agent 拒绝 owner 不匹配、包含多个 Worker 目标或未声明本机 scheduler 的请求。
- 旧 `workerSetRevision` 和索引分片字段仅用于兼容历史任务，不再用于新 Plan 提交。

### topology-004b 多 Worker 结果与归档归属

- 合并只读总览，保持各 Worker 状态独立且有界。
- 将有效 CSV、结果解析、归档、恢复版本和 PPT 最终数据源按拓扑绑定到正确 Worker。
- 阻止无 Hub revision 进入 Hub 汇总分支，阻止跨 Worker 结果误归属。
- 审计所有“备份”“同步到 Hub”“三方一致”文案及 handler 门禁。

### topology-005 静态验收

- 执行构建、lint、拓扑/调度/结果/归档定向测试和完整非服务器静态测试。
- 不连接真实服务器，不重载或关闭 VS Code，不生成或安装 VSIX。
- 真实单 Worker、多 Worker 和 Hub 故障切换行为保持 `needs field verification`。

## 完成条件

- 用户可明确配置并保存三种拓扑，UI、门禁和运行确认一致显示当前模式。
- 两种无 Hub 模式不访问 Hub、不创建自动备份，调度和保存由 Worker 自己完成。
- 多 Worker 模式下每个 Plan 的人工目标可追踪，Worker 集合变化不会自动迁移或重分配已提交任务。
- 结果解析、有效 CSV、归档、恢复和 PPT 数据源不会跨拓扑或跨 Worker 混用。
- 三种模式共享原有 Plan 和任务入口，旧任务及结果不被迁移、覆盖或删除。
- 完成自动化静态验证；真实服务器行为在现场验证前不声明成立。
