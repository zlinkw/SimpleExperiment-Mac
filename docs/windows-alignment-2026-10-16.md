# Windows 0.5.341 源码对齐

本轮为2026-10-16用户授权的源码修复。Windows仍是唯一业务权威，直接采用其稳定提交；Mac只保留已登记的路径、Termius、凭据、CLI、更新分发和原生句柄适配。没有构建、测试、操作插件UI、连接生产服务器、部署、训练、安装、发布或处理真实产物。

## 实际基线

- Experiment Windows **0.5.341**，业务提交`33b48126478b9f610f9a434c7541eeb385fd378a`；已只读fetch，origin/master为`255f4a71d234ee62e97180e19557c524397ba92f`，仅追加0.5.340/0.5.341交付说明。交付记录用于识别稳定基线，其Windows验证结果不算Mac验证。
- SimpleSFTP Windows **0.2.90**，`23beafc52e4e310001e74a5730f0eae541bbc1bc`；fetch后无后续源码提交。保留Mac前轮独立认证、路径、共享更新租约及Darwin句柄适配，不重复覆盖这些平台叶子。
- 上轮Experiment参考为0.5.327/`ea7137d388fc4990016319a1b0be10cef659e055`。本次逐项核对其后的14个业务提交及配套交付说明，冻结到0.5.341，不跟随未提交的Windows缓存、脚本或现场状态。

## 已修改的源码

34份Experiment TS差异已落到Mac工作区，其中7份为新增同源模块。按5组、每组至多7源文件执行；SFTP没有本轮新增Windows业务差异。下表的路径均相对Experiment仓库根。

| Windows版本/提交 | 同步的修复或功能 | 主要实现位置 |
| --- | --- | --- |
| 0.5.328 / 608fcf31 | PLAN清理保留PLAN和共享配置，仅审核独占配置及关联产物；Scheduler子进程显式携带设置前缀，实际会话/窗口精确绑定 | src/extension/PlanCleanupHost.ts、features/PlanCleanup.ts、runtime/TmuxTaskLifecycle.ts |
| 0.5.329 / 377e1e47 | 未决启动槽跨轮保留，不能因短暂查询缺失把同一卡重复放行 | src/features/DistributedPlanQueue.ts、DistributedSchedulingPolicy.ts、clusterSchedulerRuntime.legacy.ts |
| 0.5.330 / b2e0fbad | 未知tmux退出不等于成功；提交前重新核对Worker能力，不借旧快照放行 | src/runtime/TmuxTaskLifecycle.ts、features/TaskLifecycle.ts、extension/PlanRunHost.ts |
| 0.5.331 / 787be76b | 主动查询完成态统一，执行结果与产物完整性分开；不以旧completed或旧清单代替真实退出证据 | src/features/TaskLifecycle.ts、PulledTaskControl.ts、runtime/TmuxTaskLifecycle.ts |
| 0.5.332 / 9f2a6c3c | 正常健康刷新重建客户端不再丢失覆盖确认；真实项目/端点变化仍阻断；清理查询有界并报告真实进度 | src/extension/PlanRunHost.ts、PlanCleanupHost.ts、features/ManifestCleanup.ts |
| 0.5.333 / cc22e406 | 实时结果汇总使用当前PLAN声明、启用Worker、真实清单和指标；只保存最新汇总JSON及CSV/Markdown，不回填旧历史 | src/extension/ResultCollectionHost.ts、results/FreshResults.ts、LatestResultExport.ts |
| 0.5.334 / 3e07e864 | 产物复制不再全局阻塞PLAN提交；真实重叠路径仍保护。GPU直接采样，合并同秒请求，迟到事件不能覆盖新查询 | src/extension/legacy.ts、clusterAgentRuntime.legacy.ts、tunnel/RealtimeTunnelClient.legacy.ts |
| 0.5.335 / 73ba0170 | Worker重连不再重复触发历史清理提醒；显式审核入口继续保留 | src/extension/PlanCleanupHost.ts、PlanCleanupPanel.ts |
| 0.5.336 / 2fee8995 | 未确认原请求在重新手动派发前可精确停止；保持原commandId、目标GPU和既有确认边界 | src/features/ManualJobDispatch.ts、extension/ManualDispatchHost.ts、runtime/TmuxTaskLifecycle.ts |
| 0.5.337 / 6c07a1ce | 运行异常与干净完成分维展示；日志需匹配本次命令并完整分析，异常项进入复核范围 | src/features/RuntimeDiagnostics.ts、runtime/RuntimeLogDiagnostics.ts、results/FreshResults.ts |
| 0.5.338 / 39ca3cf5 | 旧完成任务主动核实原日志；未核实不能因历史completed标记显示干净成功 | src/runtime/TmuxTaskLifecycle.ts、RuntimeLogDiagnostics.ts |
| 0.5.339 / fed08389 | 日志重新分析后刷新任务卡；异常job可走原有覆盖确认单独重跑；新增只读tasks.analyze及CLI入口 | src/extension/RuntimeLogAnalysisHost.ts、api/LocalApiServer.legacy.ts、cli/index.ts、ui/PanelHtml.legacy.ts |
| 0.5.340 / b5f56930 | 多选PLAN只提交显式勾选项，逐个复用单PLAN流程；失败、取消、未知结果或工作区/目标变化后停止后续项，空选择不能变成全部 | src/extension/SelectedPlanBatchHost.ts、legacy.ts、ui/PanelHtml.legacy.ts |
| 0.5.341 / 33b48126 | Worker独立刷新，pending不伪造失败；本机回执时间判断新鲜度；上传结束释放旧准备名单限制；手动派发丢弃旧commandId勾选 | src/extension/legacy.ts、ManualDispatchHost.ts、features/DistributedPlanQueue.ts、DistributedSchedulingPolicy.ts、ui/PanelHtml.legacy.ts |

新增同源模块为ResultCollectionHost、RuntimeLogAnalysisHost、SelectedPlanBatchHost、FreshResults、LatestResultExport、RuntimeDiagnostics、RuntimeLogDiagnostics。Mac没有另写调度、日志异常判断、结果汇总或清理状态机。

## 平台接缝与保护区域

- extension/legacy及PanelHtml的Windows新增内容以三方源文本合并接入；保留Mac目录、显式转发主机/SSH端口、Termius手动入口、Command操作及独立preview说明。旧窗口/任务仍按共同真实身份匹配，不迁移或关闭现有任务。
- 新结果导出直接使用Windows已提供的跨平台IPC分支，没有另建Mac结果锁或发布日志。原生路径区分大小写，其他结果、异常、取消和恢复规则均复用共同模块。
- 076的Darwin只读句柄适配及SFTP/缓存接线未被覆盖，仍需真机验证ABI、权限和占用释放；证据不完整继续阻断。Windows的confirmed_paths/managed_tmux边界及两次路径确认不变。
- Windows package业务配置没有新增差异：全部53项共同配置声明、39个共同命令ID及激活事件静态核对一致。Mac保持独立身份、CLI、原生运行文件和现有本机打包入口，不复制Windows WSL或测试发布命令。
- Mac package/runtime版本仍为历史0.5.314、配套0.2.101；当前源码没有新VSIX。未来获准构建时统一递增并验证配套SFTP≥0.2.102的首次过渡，不能将本工作区视为已交付版本。

## 静态审查与未执行项

- 34份差异逐字核对冻结投影；完整356份Windows基线中328份仅有身份/命名空间映射，28份有明确平台覆盖原因。包含原生适配在内的398份文件指纹记录在[scripts/windows-source-baseline.json](../scripts/windows-source-baseline.json)，[核对脚本](../scripts/check-windows-alignment.js)可从本地Windows冻结提交只读核验。
- 364份TS仅AST语法及相对依赖存在性检查；23份SFTP JS仅语法解析，6份打包Python仅ast.parse；未加载应用模块。新增嵌入式Python与生成后的面板脚本未构建或运行，其验证留待授权。
- 首次077d计划写入和077e首文件写入遇到Windows UNKNOWN/open；原冻结源与前轮快照保留。改为同文件r+写入后，按冻结投影重新核对并记录完成；最初失败不计作成功验证。
- 本轮没有构建、类型检查、测试、VSIX验证、UI操作、探针扫描、生产连接或发布；Windows交付记录及旧Mac验证不作为本轮通过证据。没有提交/推送，现有构建提交门禁仍待授权。

本轮冻结差异的源码同步剩余0组；仍有7类待验证：构建/类型、串行回归、包/安装、更新过渡、Mac系统/UI、传输/清理、Worker完整流程。新增重点为多选中断、慢Worker独立刷新/时钟偏差、准备失败后恢复派发、旧勾选身份、未知退出/日志异常、实时结果部分失败、覆盖确认重连及清理保留范围。授权边界不变，真机与服务器验证继续延期。

旧批次、Mac平台差异和076句柄细节保存在[2026-10-15记录](windows-alignment-2026-10-15.md)。原目标保持paused，旧29条18/11计数仍仅为历史。
