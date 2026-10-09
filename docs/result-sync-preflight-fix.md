# 手动结果同步停滞修复

范围：结果同步的摘要、版本清单和可见进度；保护旧结果、统计语义与两个用户 pyc 修改。禁止迁移或删除。

- [x] 读取约束、源码、安装的 SimpleSFTP 清单实现与当前 Git 状态。
- [x] 用生产合并函数复现重复清单请求、空范围扫描和取消问题。
- [x] 摘要提供新旧布局的准确指标路径，逐 Worker 批量校验，通知显示整个前置阶段。
- [x] 逐文件回归、build、vm.Script。
- [x] 补丁版本、打包安装、入口核对与审查。
- [x] 提交与推送，fetch 后确认 HEAD 与 origin/master 一致。

现场限制：本机 SimpleExperiment/SimpleSFTP 的 API 发现文件缺失，未读取现场状态或访问服务器。用户描述不足以确认现场唯一原因。

用户确认停留提示为“正在校验所选目录内各 Worker 的文件版本”，对应本次修复的文件清单阶段。现场耗时和服务器响应仍未取得。

代码证据：原路径按每个输出目录串行执行所有 Worker 的递归 SHA256 清单，只发 4 秒状态栏提示；新摘要的 datasetResultTables 路径未用于合并范围。空范围会退化为根目录扫描。旧结果目录并未被迁移。

修复：先校验摘要的 Plan/revision/run，再使用具体指标文件构建清单。每台 Worker 一次批量清单请求；空清单不扫描项目；版本校验进入可取消的进度通知，取消信号传递给 SimpleSFTP。版本选择与覆盖路径确认保持原策略。旧目录提示不再决定下载范围，原始 Worker 归属仍用于下载。

回归使用 `node --test --test-force-exit --test-timeout 20000 <单文件>`，逐文件串行，均退出 0：

| 文件 | 通过 |
| --- | --- |
| test/features/resultMergePreflight.test.js | 5 |
| test/features/pendingResultMetricSync.test.js | 24 |
| test/features/projectResultSyncCompleteness.test.js | 15 |
| test/features/metricsDownloadEndToEnd.test.js | 5 |
| test/features/syncLatestMerge.test.js | 2 |
| test/features/syncScopeStatus.test.js | 11 |
| test/features/panelWebviewScriptHealth.test.js（build 内） | 1 |

复现：修改前两路径、两 Worker 触发 4 次清单请求；空指标范围仍请求根目录，已取消的 preflight 仍继续。对应 3 项先失败后通过。新增生产链集成回归覆盖旧目录提示、新 datasetResultTables 路径、真实合并函数、下载、dataset final 和旧表原文保留。

发布：0.5.189。build、vm.Script、VSIX runtime closure、package/postpackage 安装通过；已安装版本及 simpleex --help 正常，安装后的 extension/legacy.js 与 RuntimeManifest.js 哈希匹配。曾因版本文件未同时更新导致一次 package 校验失败，同步三个版本文件后重新通过。

保护：两个用户 pyc SHA256 未变，未暂存；未迁移或删除旧目录，未访问服务器，未执行正式实验。测试临时目录保留。

风险：尚未通过用户的现场服务器和 VS Code 手工交互验证；需要重载窗口后再次点击同步。结果目录重组仅在成功下载并发布时产生，失败时保留旧表。

代码提交 `71782f45` 已普通 fast-forward 推送 origin/master；fetch 后 HEAD 与 origin/master 一致。本记录的完成状态单独提交，无后续代码修改。
