# 服务器产物同步校验回归

本轮边界：仅修产物哈希查询的目录深度、同一请求内校验批次和失败原因；保留最新完整 run 权威、内容校验、压缩传输和发布门禁。基线 `ac3b9836` / 0.5.218，配套 0.2.48。原有两个 `.pyc` 不纳入提交。

## 现场证据

2026-10-05，运行中 Host 为 0.5.218。同步报 108 个 job 的来源/镜像不可用，三个 Worker 的健康探测均成功。通过当前 discovery/capabilities 和 SimpleSFTP 只读 API 查询同一个真实嵌套结果片段：`relativePath="." + scopePaths=[精确文件] + recursive=false` 返回零文件；改为 `recursive=true` 返回 18,700 字节文件及有效 SHA256。两次调用分别 730 ms / 594 ms。文件实际存在，此例排除“全部镜像确实丢失”。

`distributedOutputHashes()` 将精确嵌套 scope 与非递归根目录扫描组合；SFTP 的非递归语义仅扫描直接子文件。旧 mock 只按 scope 过滤，漏掉目录深度行为。每 job/每 Worker 重复调用还放大了失败等待时间。

## TODO

- [x] 用遵循目录深度语义的 fixture 复现真实失败，保留全部副本缺失的失败回归。修复前三条新增用例均失败；修复后通过。
- [x] 精确 scope 递归校验，限制单次最多 128 个路径 / 10 KiB UTF-8 JSON 参数；禁止扫描全部历史。
- [x] 单次同步内按 Worker 合并预校验，同时最多两个 Worker 查询；传输后的目标重新查询，不复用传输前哈希。不同请求不复用缓存。
- [x] 缺失、哈希不同、调用失败分别保留有界具体原因，系统性失败不再吞掉。
- [x] 串行目标回归、build、vm.Script、打包与身份校验。
- [x] 补只读现场校验结论、版本交付一次；仅提交本轮文件，Git 交付以本文件同批普通提交及 fetch 后 `HEAD==origin/master` 核对为准。

没有发起实际传输或删除；本轮不把只读校验通过称为完整同步验收。源码修改后的完整按钮流程须重载后核验。

## 只读现场复核

对截图中同一完整 run 的六个 job，批量查询三类必要结果片段共 18 个精确路径，并逐项比较 durable queue 中原有 SHA256：两个 Worker 分别 18/18 匹配，0 缺失、0 冲突；另一个此前被清空的 Worker 为 18/18 缺失。三个批次分别 748 / 614 / 591 ms。现有同一 run 的可信副本仍可作为修复缺失镜像的来源，不能把非递归查询得到的空清单当作全部副本丢失。

短时回归共 14 文件、166 用例通过：manualDistributedResultSync 13、distributedQueueStartup 19、pendingResultMetricSync 26、projectResultSyncCompleteness 16、planOutputRetention 15、distributedJobArtifacts 3、runCompletionResultRefresh 1、distributedQueueCacheStability 7、planRunFreshness 5、distributedRerunAndWorkerDelta 8、projectResultTables 18、panelStateFlowControl 10、panelStateProgress 13、panelRenderHealth 12。未启动新的实验或重放用户的完整同步请求；真实完整按钮耗时和正式表发布仍须重载后观察。

`npm run build`、实际内联脚本门禁（1/1）和独立 `vm.Script` 均通过，187 个 runtime 模块 buildId 为 `ba138959dd54`。代码/lock/runtime 同步推进 0.5.219，配套无需改动。文件修改后的中文内容已按 UTF-8 复读，未删除本地或远端文件。

交付补记：首次 package 在本地 VSCE 清单子进程的 8 秒门限停止（ETIMEDOUT）；核查固定本地工具版本 4.0.0、入口及无遗留 VSCE 进程后，同一 8 秒限额的闭包门禁通过，未提高门限。后续完整 package 成功，VSIX 为 2,328,800 字节；只读 ZIP 门禁验证 187 个源码 SHA256、package/VSIX 身份及配套 16 文件一致。显式安装 0.5.219 一次，VS Code 列表和全局 simpleex 包均核对为 0.5.219，配套保留 0.2.48。安装后停止 Panel/API 访问；须用户 Reload Window 后再点击完整同步按钮核验。

## 0.5.219 后续：本机队列替换 EPERM

基线 `07d98f31`，两个用户 `.pyc` 保留。运行中 API 确认为 0.5.219；失败路径明确是 globalStorage 中 `distributed-plan-queues/*.json.writing -> *.json`，不是远端产物。Plan 运行请求在同步期间被 guard 拒绝；该 guard 不取消同步，不能凭时间接近断言点击造成文件锁。

`saveDistributedQueue()` 仍自行写固定槽并单次 rename，而通用 StateStore 已实现 EPERM/EACCES/EBUSY 的有界退避。现场文件为普通 Archive 文件；当前记录不足以识别是扫描器、读句柄还是其他进程占用，不能声称已经定位占用进程。

- [x] 真实 Host 记录与代码链核对；新增四条回归修复前失败，原七条通过。
- [x] 队列复用通用原子写入；每次 rename 前重查磁盘签名、提交代次，保留多窗口并发保护。
- [x] 固定槽失败只保留一份；最后可信显示及工作副本签名不污染；持久失败标 stale，下一请求可恢复。
- [x] 验证同步期间拒绝 Plan 请求不会取消同步；串行相关回归 17 文件、202 用例通过；build、vm.Script、打包与身份门禁通过。
- [x] 显式安装 0.5.220 一次，安装列表及全局 simpleex 包核对一致；安装后停止 Panel/API 访问，等待用户重载，不重放实际远端同步。Git 交付以本文件同批普通提交及 fetch 后 `HEAD==origin/master` 核对为准。

复现/修正证据：queue fixture 执行真实 StateStore 代码，共享同一个虚拟文件系统，不模拟掉 retry。连续两次 EPERM 后第三次成功；退避 20/40 ms。持久 EPERM 最多六次 rename、五次退避共 550 ms（不含操作系统调用耗时），失败维持 28 个 Plan 和原磁盘签名，只留一个 `.writing`；后续成功消耗暂存槽。重试期间外部写入立即转为 conflict，旧提交不得覆盖；代次失效亦立即拒绝。Plan guard 的四条既有用例继续通过，证明拒绝新提交不取消已有同步。

目标回归：distributedQueueCacheStability 11、planStopClear 33、resourceMutationRouting 2、resultSyncFailureVisibility 4、manifestStagingLifetime 4、hostOperationLease 14、resourceLeaseCompatibility 1、manualDistributedResultSync 13、pendingResultMetricSync 26、projectResultSyncCompleteness 16、distributedQueueStartup 19、projectResultPublication 9、panelStateFlowControl 10、panelStateProgress 13、panelRenderHealth 12、panelLifetimeRecovery 11、localApiSseBackpressure 4。resourceMutationRouting 的旧 VM fixture 缺少 StateStore/formatter 导致 1/2 失败，补真实依赖后 2/2；未删除测试或延长时限。目标版本 0.5.220，配套 0.2.48 不变。

交付门禁：`npm run build`、独立 `vm.Script`、`npm run package` 均通过；内联脚本门禁 1/1，187 个 runtime 模块 buildId 为 `b528e807ffec`，VSIX 2,330,682 字节。只读 ZIP 校验验证源码/包内 187 个 SHA256 与版本身份一致，配套 0.2.48 的 16 文件身份一致。没有删除旧产物或用户状态文件；真实完整同步及 Windows 文件占用进程仍未验收。
