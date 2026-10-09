# 完整重建本机结果目录

范围：手动“同步服务器结果并更新总表”成功后，替换配置的结果根目录。实际目标由当前项目和 resultCsvDir 决定，不硬编码 MultiModal 路径。

同步输入会忽略旧版项目级汇总别名 `simple_cluster/results/project_seed_mean_std.csv`、`project_final.csv` 和 `project_final.md`。这些全项目派生表在 Worker 之间可能互相覆盖；新的数据集结果来自按 Plan 或数据集分层的指标文件。

- [x] 读取插件约束、清理技能、MultiModal 的 AGENTS.md 与结果/Git 状态。
- [x] 新结果先准备，完整成功后备份旧目录并填入新结构；原始服务器结果不变。
- [x] 安全路径、失败保留、备份轮换、下载和聚合回归。
- [x] 补丁版本 0.5.191、构建、打包安装与入口核对。
- [x] 提交、推送及最终一致性验证。

备份标准路径为 `<项目>/clean_dir/<结果根相对路径>`。旧结构仅在第一次完整手动同步时备份并重建；`.dataset-layout.json` 标记重建成功和配置目录，后续同步就地刷新数据，不再创建备份或重建暂存目录。已有同路径备份按原拓扑移入 `clean_dir/_superseded/<批次>/`，再备份当前结果。MultiModal 的项目约束明确允许结果产物有未提交改动及已有备份轮换，必须记录 Git 状态、大小、SHA256；不能删除或覆盖备份。当前用户已授权自动清理该结果范围，进度通知展示完整来源和备份路径；不增加目录清理确认弹窗，不执行永久删除。

本轮只修改插件，未移动或删除 MultiModal 的实际目录。现场 API 发现文件缺失，未尝试服务器传输。

完整成功：同步发现的 Plan 全部收录，且没有缺指标/失败条目。旧布局只在首次切换时从当前注册表生成干净的数据集表，并拷贝本次指标文件到暂存目录；随后目录预检、备份和替换。后续使用原映射路径更新，不创建新的完整目录副本。部分失败维持既有增量同步行为，禁止整目录清理。替换失败且目标未创建时恢复旧目录；没有自动删除。

备份记录：clean_dir/MANIFEST.md 以 UTF-8 追加每次目录移动的来源、目标、批次、Git 状态、文件字节长度和 SHA256。拒绝路径越界、受保护区域、链接、挂载边界、批次碰撞、暂存重叠和校验期间变化；单目录上限 20000 项。备份与暂存父目录不自动清理。

验证均退出 0，测试逐文件串行使用 `node --test --test-force-exit --test-timeout 20000 <文件>`：

| 文件 | 通过 |
| --- | --- |
| test/features/resultDirectoryRebuild.test.js | 6 |
| test/features/pendingResultMetricSync.test.js | 25 |
| test/features/projectResultSyncCompleteness.test.js | 15 |
| test/features/metricsDownloadEndToEnd.test.js | 5 |
| test/features/panelWebviewScriptHealth.test.js（build 内） | 1 |

合计 52 项。覆盖真实按钮链路的旧平铺目录消失、新数据集表和 raw 保留、第二次同步不增加备份，以及发布故障/工作区切换恢复、链接与保护路径拒绝、未授权 dirty 结果拒绝。部分 Worker/Plan 失败和科学聚合既有回归通过。

build、vm.Script、git diff --check、VSIX runtime closure（159 模块）、package/postpackage 安装通过；已安装 simple-local.simple-experiment@0.5.191，simpleex --help 正常。安装目录的 extension/legacy.js、ResultDirectoryRebuild.js、RuntimeManifest.js 与工作区 SHA256 一致。

两个原有 pyc 修改未写入、未暂存，SHA256 保持不变。测试目录保留。用户需重载 VS Code 后在 MultiModal 项目点击手动同步，实机流程尚未运行。

代码提交 `1c36ec85` 已普通 fast-forward 推送 origin/master，fetch 后 HEAD 一致。本记录的完成状态单独提交，没有后续代码修改。
