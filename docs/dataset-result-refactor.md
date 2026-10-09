# 结果按数据集分层 TODO

范围：统一目录模型、本机与 Agent 聚合、下载链、catalog/UI、论文/PPT 路径、回归与发布。
保护：原有两个 pyc 修改；旧结果只读保留，无迁移或删除；统计、seed、revision 与 Worker 语义。

- [x] 读取约束、附件与 Git 状态（版本 0.5.187）。
- [x] 统一数据集安全名称与稳定 Plan 目录，dataset-first build/catalog。
- [x] Extension 配置根、写入/open/split 与同步路径/payload。
- [x] Agent Plan/project/paper 分区及多 Worker summary 协议。
- [x] 动态 dataset → 表格 → Plan UI 与 PPT 消费路径。
- [x] 文档、逐文件回归、build 与 vm.Script。
- [x] patch 0.5.188、package/install 与安装版本/入口检查。
- [x] 最终产物复核、审查提交推送。

已验证：核心表 15、远端候选 13、alias 重建 2、下载链 5、pending 22、完整性 15、位置 6、配置 6、Plan 聚合 6、catalog/UI 2、多数据集 Agent 1、PPT 1、PPT 既有 6、evidence 7，均通过。命令统一为 `node --test --test-force-exit --test-timeout 20000 <单文件>`；没有执行完整 npm test。

原子性：所有数据集计算与名称/alias 检查完成后才写入；单文件临时写入加 rename。文件系统故障可能留下暂存文件，未自动清理。
临时测试目录与 Python 脚本保留在系统临时目录，不自动删除；Python 仅加载测试函数静态依赖，使用 -B、10 秒超时与隐藏窗口。
构建、vm.Script、package、安装版本与 simpleex 入口通过；代码提交 `bbe43b4d` 已普通 fast-forward 推送至 origin/master，fetch 后 HEAD 一致。远端 Agent 实机与 VS Code 手工交互尚未运行。

版本：package.json、lock 根节点、RuntimeManifest 同步至 0.5.188；Python runtime 由 build 注入。

## 逐项验收命令

以下测试均逐文件串行执行，退出码 0。统一前缀为 `node --test --test-force-exit --test-timeout 20000`。

| 完整测试参数 | 通过数 |
| --- | --- |
| `test/features/projectResultTables.test.js` | 15 |
| `test/features/remoteResultInspectionWorkflow.test.js` | 13 |
| `test/features/metricAliasRebuildWorkflow.test.js` | 2 |
| `test/features/metricsDownloadEndToEnd.test.js` | 5 |
| `test/features/pendingResultMetricSync.test.js` | 22 |
| `test/features/projectResultSyncCompleteness.test.js` | 15 |
| `test/features/projectResultLocationClarity.test.js` | 6 |
| `test/features/resultCsvDirectoryConfig.test.js` | 6 |
| `test/features/planSeedAggregate.test.js` | 6 |
| `test/features/datasetAgentTables.test.js` | 1 |
| `test/features/datasetResultCatalog.test.js` | 2 |
| `test/features/datasetPptTables.test.js` | 1 |
| `test/features/planScopedStatisticsPlotSource.test.js` | 1 |
| `test/features/resultPptArtifactReadiness.test.js` | 5 |
| `test/features/resultSectionRefreshDependencies.test.js` | 3 |
| `test/evidenceTooling.test.js` | 7 |
| `test/features/panelWebviewScriptHealth.test.js`（build 内） | 1 |

- `npm run build`：通过，含 typecheck、runtime 生成、node -c 与 Webview 脚本健康检查。
- `node -e "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8'))"`：通过。
- `npm run package`：通过，含 runtime closure 验证和 postpackage 安装。
- `code --list-extensions --show-versions`：simple-local.simple-experiment@0.5.188。
- 已安装扩展的 `simpleex.cmd --help`：退出码 0，bin 为 dist/cli.js。
- `git diff --check`：通过。
- 未运行：完整 npm test、远端实机 Agent 与手工 VS Code/PPT 交互。

受保护 pyc SHA256：Agent `394a7826404848a497303cff15fc49f4da8110ecd3256a38a1ee34536625627f`；Scheduler `b6261fd32d49af800dab701da24d2daa4e9f982ccacdf30a73d00e82eed00c74`。本轮未写入或暂存。

交付完成：17 个逐文件测试合计 111 项通过。旧结果无迁移、无删除；两个用户 pyc 修改保持未暂存。最终仅补充本验收记录，未继续修改代码。用户自行重载 VS Code 窗口并做实机交互验证。
