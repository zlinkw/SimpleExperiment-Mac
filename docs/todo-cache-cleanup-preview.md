# 缓存审核、设置与最新结果身份收口

范围：缓存审核的连接上下文与生命周期、设置导航、最新运行的全局产物同步状态，以及指标下载到本机 CSV/Markdown 发布链。保留 7 天保留期、活动任务保护、两次完整路径确认及删除路径门禁；不执行文件删除、服务器同步或实验操作，不改当前运行任务。

- [x] 读取 AGENTS.md、项目约束及 Git 状态；原有两个 dirty `.pyc` 保留。
- [x] 核对现场：Extension Host/安装均为 0.5.233，MultiModal 三个 Worker 当前 SSE 与健康检测正常。截图来自 Agent 准备阶段；不能将其 `fetch failed` 当作不存在可回收文件。
- [x] 复核代码：审核窗口捕获旧 client；refresh 不更新连接上下文；pending/无 candidates 响应被当成空清单；远端等待阻塞本机展示；关闭窗口不取消读取。
- [x] 用生产代码 fixture 复现客户端切换、未完成响应、刷新竞争与关闭窗口场景；新约定修复前 6/6 失败、修复后 6/6 通过，继续补路径/未确认删除测试。
- [x] 使用当前连接上下文；上下文变更使旧扫描和两次确认失效，连接状态变化后重读。区分正在读取、连接失败、暂停审核与真实零候选。
- [x] 本机与各 Worker 独立更新；只允许已完成、有效清单进入删除审核，关闭后取消请求并释放订阅。
- [x] 移除普通工具栏和连接页的暂停全部网络/恢复网络按钮，保留底层兼容命令。
- [x] 设置页补即时渲染；卡片工具刷新保留右上角“关闭设置”；资源树排除设置。5/5 行为回归通过。
- [x] 核对 Plan 完成后自动同步：当前 `scheduleResultsSummaryRefreshFromRealtime()`、`refreshResultsSummaryFromRealtime()` 与远端 `maybe_auto_run_completion_pipeline()` 无同步实现。`syncPendingPlanArtifacts()` 无完成事件入口；未新增全服务器自动传输，当前运行保持不动。
- [x] 完成历史卡片显示最新 run 的全局同步状态。启动/连接恢复、run 完成、手动同步或下载结束时只读检测；完整目录含权重、日志和指标。单次至多 2 个 Worker 并行核验，稳定 queue tick 不重复读，临时失败按 60～300 秒退避。
- [x] 同 revision 重跑独立核验；旧同步收据不代表新 run。来源缺失、未读取、队列 stale 或旧版复用目录缺少 run 身份均显示待核验，不宣称同步成功。
- [x] 本机只读复核：`bus_cot_lesion/final/final.md` 在 2026-10-07 12:12:28 写入，36 个 CSV/Markdown 与 registry 内容完全一致。DPL 最新 `distributed-plan-1791341503882-klf0vx` 已完成 6/6、各 job 无预存 artifact hashes；registry 仍是旧 `distributed-plan-1790367245007-4a7gjm`。问题是结果权威选择过滤新 run，而非文件写入或 Panel 延迟。
- [x] 指标同步使用独立的完整运行身份选择，不因尚未保存 artifact hashes 排除已完成新 run；保留严格的历史产物保留/删除门禁。新 run 从来源 Worker 的唯一 `attempts/<runId>` 目录取得指标，先获取 SHA256 再校验下载内容、case/seed，不能借旧共享结果或混合 run。
- [x] “同步服务器结果并更新总表”“下载指标并重新汇总”和当前 Plan 指标同步均验证同 revision A→B 替换：BUS/PAD 各 3 seed，当前方法/总表的 CSV 与 Markdown 一起事务发布，不产生 raw 下载缓存，也不需要远端重建或全服务器镜像。
- [x] 本地刷新对照已收录 registry 修复缺失/陈旧 CSV 和 Markdown；内容一致不重复发布，不访问服务器。已发布 catalog 排除旧世代方法/数据集表，旧文件保留追溯，旧格式纯本机目录索引继续兼容。
- [x] 串行结果回归：freshness 8/8、pending metrics 39/39、dataset catalog 7/7、Panel catalog 7/7、result tables 18/18、sync completeness 16/16、retention 15/15、manual-only 6/6、distributed sync 25/25、rerun 8/8。旧测试补齐生产依赖并更新已退休远端重建的预期；无超时跳过。
- [x] 串行目标及安全/Panel 回归通过：缓存审核 7/7、全局状态 8/8、设置 5/5、队列启动 20/20、execution 16/16；projection 5/5、DOM patch 2/2、render health 12/12、flow control 10/10、state progress 13/13、lifetime 11/11；事务发布 9/9，隧道、导航、结果层级/缓存、generation 与构建身份相关回归通过。
- [x] `npm run build`、Webview 实际内层脚本与外层 `vm.Script` 均通过；代码无服务器标识/隧道端口硬编码新增。
- [x] 递增至 0.5.234，`npm run package` 通过，VSIX 198 个目标文件逐字节核验通过；`npm run install:latest` 仅执行一次，已安装 0.5.234 的 189 项运行文件与本机一致，`simpleex` 入口版本与帮助正常。

Git 交付门禁：仅提交本批次源码、测试、文档和生成运行文件，排除两份原有 dirty `.pyc`；普通快进推送 `origin/master` 后 fetch 核对，提交记录以 Git 历史为准。

现场限制：连接和本机结果身份已只读核实；新审核 UI、全局同步徽标及真实新 run 下载需重载后验收。本轮未下载服务器指标、未更新 MultiModal 文件、未操作当前运行任务，不能宣称实际 DPL 表已切到新 run。
