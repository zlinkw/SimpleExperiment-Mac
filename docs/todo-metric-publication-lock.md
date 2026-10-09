# 指标下载发布锁范围修正

目标：修复“下载指标并重新汇总”与后台 Worker 任务快照互相阻塞；保持同文件、多窗口和结果世代保护。

- [x] 读取 AGENTS、项目约束、Git 状态与两插件 discovery/capabilities；主项目只存在原有两个 dirty .pyc。运行/安装版本为 SimpleExperiment 0.5.223、SimpleSFTP 0.2.51。
- [x] 追踪按钮到 downloadMappedResultBatch：缓存复用与新下载分发都申请整个项目根的 publishMappedResult 锁，后台快照只锁自己的文件；无关路径因此被拒绝。withHostOperationLease 还未传递 waitForConflict/signal。
- [x] 在实际按钮生产调用链用真实同 Host 租约复现：修复前两个回归失败，报错与截图一致；修复后 31/31 用例通过。新覆盖后台快照、新下载、缓存、同文件等待、取消和工作区切换。
- [x] 分发锁缩小到真实源文件、目标文件和既有固定暂存文件；缓存/新下载共用 publishMappedResultDownloads；透传 waitForConflict/signal，同文件竞争等待，取消可中断，进入临界区和逐文件发布前检查当前工作区/请求；暂存通过原子 rename 消耗，无新随机临时文件。
- [x] 串行目标回归：14 文件、158 用例通过；build 内 Webview 脚本 1 用例通过，共 159 个独立用例。npm run build、vm.Script、git diff --check 通过。
- [x] SimpleExperiment/runtime 统一递增到 0.5.224；npm run package 通过，VSIX 187 项 runtime SHA256 与工作区/build manifest 全部一致，buildId=9b5f6b08fb57，无 .pyc。首次打包的 vsce ls 在 8 秒门禁内超时，独立包闭包门禁和完整打包重新执行均通过；未放宽超时。
- [x] 实现提交 cc122606 已推送 origin/master，并 fetch 确认 HEAD 一致；npm run install:latest 对 0.5.224 安装一次，VS Code 安装版本和 simpleex 入口均核对。已安装 186 项 runtime 文件 SHA256 与构建一致（package.json 由 VS Code 增加安装 metadata，另行核对版本），buildId=9b5f6b08fb57。SimpleSFTP 仍为 0.2.51。安装后停止面板/API操作。
- [x] 明确代码验证与 MultiModal 现场汇总验收边界；现场新版本同步保留给重载后验收，不宣称已成功下载真实新结果。

回归文件：pendingResultMetricSync（31）、hostOperationLease（14）、resourceLeaseCompatibility（1）、hostOperationLeaseIntegration（3）、projectResultSyncCompleteness（16）、projectResultTables（18）、projectResultPublication（9）、runCompletionResultRefresh（1）、safeRequestRetry（13）、sftpProgressWait（6）、panelStateFlowControl（10）、panelStateProgress（13）、panelRenderHealth（12）、panelLifetimeRecovery（11）；均按单文件、20 秒门禁串行运行。

不删除活动锁、不全局放行本 Host、不暂停快照刷新、不使用旧结果缓存掩盖下载失败。

现场只读佐证：截图持有窗口的 PID 与当前运行的 SimpleExperiment discovery 相同（38020）；快照文件位于 simple_cluster/tmp/worker_task_snapshots，而指标位于结果树，两者没有实际文件重叠。当前 API 无法装载尚未发布的新 Host 代码；代码验证使用完整生产按钮和真实锁 manager，SFTP 返回/文件内容以受控 fixture 替代远端传输。实际 MultiModal 新版本同步须重载后复核，不能把 fixture 数据当作真实结果。

交付时 git status 仅保留原有两个 dirty .pyc；未修改或清理 MultiModal 真实结果、活动租约和运行任务。人工验收：Developer: Reload Window 后点击“下载指标并重新汇总”，检查通知完成、最新 raw/method/final 内容及结果页数值；新 Host 的真实远端传输与汇总尚未验证。
