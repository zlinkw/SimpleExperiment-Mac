# Windows 分叉后功能同步

本轮参考 Windows 已提交历史：SimpleExperiment 从 `8934ed8b80fe96981a0f8deb1c0481039e9c1568` 到 `42902a5a`，SimpleSFTP 从 `d2b7d20f0d5649c783f4f9d15bc5d9427bee6b13` 到 `acae730`。参考点冻结于2026-10-12，不复制 Windows 工作区未提交文件。

## 页面与方法对应

| Windows 提交 | 页面/行为 | Mac 同步与本地证据 |
| --- | --- | --- |
| `99e84695` | 面板长期打开、重连与重载提示 | 异步状态反馈不阻塞配套更新；panelOvernightRecovery 8项，保留Mac加载代次与磁盘版本保护 |
| `ba2994c9` | GPU初始快照与缺失服务器行 | HTTP/bootstrap恢复、最后有效采样与错误提示；gpuWorkerSnapshotRecovery 8项、mergedGpuWebviewCache 5项 |
| `ff33788d` | 失败任务召回与历史留存 | 保留明确人工处理入口；failedJobRecovery 3项。新正式任务不自动增attempt或隔离，旧历史仅精确授权接口兼容 |
| `234e1a73` | 后台产物收集保留任务 | 结果收集不清掉执行状态；planOutputRetention 20项、manualDistributedResultSync 25项 |
| `5612b991` | GPU当前用户任务归属 | 必须是本机派发的command/workflow/job且有新鲜完整Worker回执；用户名、Plan名、插件标记不足以证明归属。gpuSubmittedJobOwnership 7项 |
| `c3a3bff7` | 明确不可用任务 | 执行区人工标记/恢复不可用，保留原因和原始状态；逻辑9项、UI 2项 |
| `7eb92c7e` | 结果阶段、同步进度与新鲜度 | 结果区显示实际阶段，按当前Plan/revision核对；planRunFreshness 10项、result进度路由3项 |
| `cbeda63e` | PLAN清理审核与API | Plan区“清除 PLAN 及关联产物”；协调/宿主26项、完整路径与身份审查 |
| `1bd16749` | Git祖先与精确授权 | 防止错误工作区/路径继续清理；包含在清理与重连回归，Mac物理路径保护保留 |
| `523713dc` | 离线节点与人工续办 | 未完成项只读核查、重新预览与重新确认，不因重连自动执行；重连9项 |
| `95a7f7a5` | 清理页面消息桥 | 注册消息桥后才启动预览；避免丢回执，planCleanupPanelBridge 12项 |
| `93aed2fd` | 清理阶段进度与所有权 | 精确操作身份、过期响应拒绝、真实阶段提示；不接管其他任务 |
| `da4de3ae` | 占位任务与限定预检 | 缺证据保持未知/不可用，不能伪造完成；执行总览25项、idleGpuDispatchLifecycle 19项 |
| `8b4aed70` | 用户前缀与GPU容器内部标签 | Mac此前已同步，保留更严格缺前缀拒绝；macSchedulerGpuTabs 5项、tmuxOtherSessionsDisclosure 13项 |
| `e0460020` | 正式CSV声明与一致路径 | 新任务只使用Plan声明的稳定目录/CSV；planResultPathContract 3项 |
| `8a95b516` | 正式任务与内存结果 | 禁止新attempt、draft真实执行及直接覆盖；所有格式只读入内存，落盘摘要/来源哈希。formalJobExecution 6项、wrapperResultPersistence 26项 |
| `42902a5a` | 持久启动前拒绝回执 | 精确身份failed/neverStarted，丢即时回执后由快照恢复；preflightDispatchRejection 6项，不为未启动任务显示tmux日志按钮 |

SimpleSFTP配套参考了 `058e1c4` 传输元数据、`cab96c0` 受限清理、`274b538` Git祖先核验、`9076b2e` 重连、`acae730` 物理别名与 `d39ac7d` 生产进程退出证明。Mac保留独立认证、SecretStorage、本机流式中转及更严格持有者退出证明；cleanupFiles 18项通过。Windows磁盘大小写与Xshell行为没有直接套用到Mac。

## Mac使用与限制

- 更新入口仍为底部Mac preview状态栏、⇧⌘P配套更新命令，以及面板“设置 → 插件配套更新”。按SimpleSFTP Mac → SimpleExperiment Mac顺序安装并重载。
- 用户前缀/GPU展示在插件更新后生效。新派发按GPU编号使用固定容器，任务放入内部标签；旧独立会话只显示/兼容，不自动迁移、关闭或删除。
- 新正式执行要求Worker报告 `declaredJobPaths: true`。旧Agent会被明确拒绝；任务空闲后由用户主动“准备项目与 Agent”确认上传，再在Termius手动处理并检测。此次同步不部署任何运行中的Agent。
- 已有正式目录冲突或失败时先核对原始任务、日志、owner及产物，再决定人工处理。自动策略不会创建新attempt或替用户覆盖；历史attempt保留只读收集。旧draft执行入口保留明确拒绝说明。
- 结果格式不限于CSV；CSV/JSON/日志/二进制均只读入内存解析，保存摘要与来源大小/SHA，不生成新的原始下载副本；现存原始文件不删除。
- PLAN清理页可预览关联节点、精确目标与未完成信号。macOS尚缺可靠打开文件句柄证明，实际清理会返回 `HANDLE_CHECK_UNAVAILABLE` 并阻断，不能靠重新确认或换入口绕过。永久删除仍须两次完整路径确认与物理直接父目录核验。

## 验证边界

全部为本机build、依赖闭包、生成面板语法、实际编译消费者、隔离Python函数及串行目标回归。Python10秒、每目标文件20秒；没有运行完整Agent或科研实验，没有连接服务器、启停远端任务、真实传输、部署Agent或安装开发机扩展。旧回归夹具按正式契约更新，失败记录保留，未跳过门禁。

M5用户已提供部分`.309/.97`验收；本轮新增页面/正式执行/内存结果/清理预览尚待真机，不使用模拟结果冒充真机。原目标固定29条，18已验证、11剩余，整体保持paused；本轮仅完成追加授权的功能同步和发布。


交付：[preview-v0.5.313](https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.313)，配套0.2.100。源码`1be91b4248518c32d06c667b3c73c8b8d5c4b28c`/`2d5d5aced0a49621d84e5a9f00d65b22c053f2f3`，静态索引`bd7e14f0d8c5081031f05be4bc77bad6eed460f9`。127目标文件、实际包200消费者、234/28闭包、1588/87源码快照、匿名四请求200/REST0通过；两仓普通同步origin/master，未执行Actions、开发机安装或远端任务操作。
