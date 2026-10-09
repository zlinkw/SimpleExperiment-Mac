# 安全重试收口

## 2026-10-07 完成回执与部分远端快照

- [x] 读取 AGENTS/项目约束/Git；Host 33916 与磁盘均为 0.5.231，保护两个 dirty pyc。API 显示 dpl 当前 6 个 job 运行中，drf 最新 run 的 6 个 job completed；只读磁盘队列进一步确认 drf 同时有 6 个 trustedTerminalStatus=completed、remoteAcceptedJobCount=3、recoveryMissingCount=3。生产 preparePlanSafeRetry 对该只读副本复现截图同一错误，未停止或新建真实任务。
- [x] 修正缺失计数：保留最新 attempt 的完整终态身份回执，fresh remoteAcceptedJobCount 仍如实保留远端子集；不可把暂缺服务器快照重新等价为已完成 job 的运行状态未知。
- [x] 修正安全重试前后检查：只在有完整、唯一、最新终态身份证据时消除过期 missing blocker；冷恢复缺 job、unknown、身份缺失/冲突、仍运行及旧 revision 的并发保护保持。另一个 Plan 运行不阻止本 Plan 的合法排队。自动进度查询同样忽略已被完整终态证据排除的过期缺失计数，避免持续查询全部 Worker。
- [x] 用户补充首批 3 个、约一分钟后另 3 个回执：当前 dpl API 的 acceptedAt 为 02:52:02–02:52:12，实际 startedAt 为 02:52:04–02:52:39；Host dispatchMs=24383、clickToFirstAcceptedJobMs=43353。生产 Promise.all 整批结束后才处理/保存回执，首回执计时实际上落在批尾；已改为并发 RPC、按完成顺序串行原子保存并 postState，首回执记录响应到达时间。全部 RPC 收束前不释放 tick，即使写盘失败也不允许新 tick 与旧请求重叠；stop/generation/workspace 变化时拒绝迟到回执。
- [x] 快照读取原来 await 本地 lease/write，会延迟已经收到的任务证据。生产方法测试以阻塞磁盘写入复现 7/8，改为复用 LatestSnapshotWriter，每个 Worker 一份 active、一份可替换 pending；1000 次更新只保存第一份和最后一份，其他 Worker 不受影响，完成/失败后释放 key。仍使用原文件租约/原子写入；失效 workspace/client、扩展停用时丢弃未开始的可选缓存写入，不增加临时文件种类。
- [x] 串行目标回归/build/vm.Script、UTF-8/diff：21 个目标文件共 249 条通过，另内层 Webview 脚本 1/1；npm run build 与额外 vm.Script 通过。
- [x] 0.5.232 补丁打包/包身份验证：完整 npm run package 通过，188 个运行模块闭包与 VSIX 内 192 个身份文件 SHA256 一致，未收录 pyc。VSIX SHA256：96497b81b6f2e46a9833f5943b41925952d8c5f3339ce010ca09b2d6a45271dd。
- [x] scoped 代码提交 `1ba488d2` 已普通推送 origin/master，fetch 后 HEAD 与远端一致。npm run install:latest 仅安装一次 0.5.232；code 列表核对 SimpleExperiment 0.5.232 / SimpleSFTP 0.2.59，已安装 192 个身份文件与本机已验证 VSIX runtime 一致（package 只排除 VS Code 安装元数据）。simpleex 入口存在；安装后没有调用 API 或操作面板。两个 dirty pyc SHA256 未变化。
- [x] 本轮代码收口完成，验收边界已记录：真实 UI/新运行由用户 Developer: Reload Window 后观察；未自动取消 dpl、提交 drf、清理产物或改变隧道/heartbeat 阈值。

初始回归：新增 planSafeRetry 场景 10/11、distributedPlanQueue 23/24；失败分别与截图同文错误及 missingCount=3（期望 0），原有活跃/冲突保护测试仍通过。

本轮验证：planSafeRetry 12/12、distributedPlanQueue 24/24、serverPlanQueueRecovery 4/4、serverQueueLifecycle.integration 7/7、duplicatePlanSubmissionGuard 10/10、distributedRerunAndWorkerDelta 8/8、planSubmissionOwnerReconcile 4/4、idleGpuDispatchLifecycle.integration 7/7、serverAuthoritativeProgress 10/10、distributedQueueStartup 20/20、distributedQueueCacheStability 12/12、idleGpuDurableDispatch 4/4、planSubmissionVisiblePreflight 19/19、planValidationOperationPayload 19/19、planStopClear 33/33、panelStateFlowControl 10/10、panelStateProgress 13/13、panelRenderHealth 12/12、panelLifetimeRecovery 11/11、prequeueRecallLifecycle 5/5、prequeueRecall 5/5。逐文件串行，均使用 20 秒超时与 force-exit。原始等待整批回执的 production tick 测试先失败，改后快回执在慢请求仍 pending 时已持久化；写盘失败会等待其他 RPC 结束再抛错，迟到旧代回执不能保存。

真实只读副本：drf run `distributed-plan-1790838284143-3yb0w6` 的六条 completed/trustedTerminalStatus 记录与旧 missing=3，同一生产 preparePlanSafeRetry 由报错变为返回 false（无需停止，允许后续校验/历史产物选择），按身份聚合 missing=0；输入完全不变，未调用远端、写盘、取消或提交。另一个 dpl run `distributed-plan-1791341503882-klf0vx` 保留。时间范围来自该 dpl 的 tasks.list 和提交 operation；Worker 时钟与本机有约 12 秒偏差，不将跨机器时差当作性能收益。更新后的 UI 显示/再次实际提交尚未验收，需重载后观察；没有实测提速百分比或宣称新的训练任务已排队。

打包门禁记录：第一次 package 的本地 VSCE ls 子进程超过既有 8 秒工具超时（ETIMEDOUT），未修改超时或跳过门禁；单独 closure 检查约 3.2 秒通过，随后完整 package 通过。无最终失败测试；此工具首次超时保留为后续观察项。

## 前序安全重试批次记录

用户确认：失败/取消记录不阻挡重试；同一传输先取消并核实退出；活跃 Plan 一次确认停止后重跑；未知远端结果不并发重发。

- [x] 阅读约束、检查 Git；保护两个 dirty pyc；核对已有 active guard、停止回执、SimpleSFTP 取消协议。
- [x] 三个结果同步入口按项目/动作/Plan 隔离；取消后等待传输控制器实际退出；未知结果保留最多 64 个待核实请求。
- [x] Plan 重跑一次确认，按精确运行身份停止，保留产物/历史；旧失败记录不参与占用。
- [x] 前端开放明确重试入口，旧请求回执不解除新请求 loading。
- [x] 串行回归（含 `planStopClear.test.js` 33/33 和 `tunnelClient.test.js` 5/5）、build、vm.Script；检查 UTF-8、pyc 与 diff。
- [ ] 补丁版本、package、安装一次；提交推送并核对 origin/master。

不删除文件、不清空历史、不绕过真实 active guard；不执行真实训练或取消用户现场任务。现场重试待重载后验收。

验证记录：前序逐文件通过 `safeRequestRetry.test.js` 9/9、`planSafeRetry.test.js` 9/9、`safeRetryFeedback.test.js` 2/2、`duplicatePlanSubmissionGuard.test.js` 10/10、`planSubmissionOwnerReconcile.test.js` 4/4、`planSubmissionVisiblePreflight.test.js` 19/19、`manualDistributedResultSync.test.js` 7/7、`panelMessageDispatch.test.js` 8/8、`sftpProgressWait.test.js` 2/2、`cancelRetry.test.js` 2/2。2026-10-04 依用户要求回检后，`planStopClear.test.js` 33/33、`tunnelClient.test.js` 5/5；内部 Webview 脚本测试 1/1，`npm run build`、`dist/ui/PanelHtml.js` 的 `vm.Script` 门禁和 `git diff --check` 通过。失败测试复核中发现最后订阅者取消时 AbortSignal 的 reason 没有传给底层 Worker fetch，已在 `TunnelClient.legacy.ts` 修复并加断言。此前约 20 秒超时记录保留；当前隔离用例完成约 75ms。两个 dirty pyc SHA256 与保护基线一致。

历史记录（2026-10-03）：`planStopClear.test.js` 的 `stopping during a hung fingerprint cancels that submission and a new one can enqueue` 两次在 20000ms 超时，其余 32 条通过。之后隔离第二个 host 的调度调用；2026-10-04 按用户新要求回检，该用例通过，整文件 33/33。原 timeout 作为历史记录保留，不再作为当前失败。

前序历史快照当时未完成，源码为 0.5.215；该段不是本轮的当前交付状态。当前交付见上方 2026-10-07 记录。两个用户 dirty pyc 持续保留；真实远端重试需用户验收。
