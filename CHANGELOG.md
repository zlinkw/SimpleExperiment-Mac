## 0.5.252 (2026-10-09)

- 修复 TMUX 区把服务器已有普通会话的每个窗口都平铺成任务卡片。主区只展示按物理编号固定排序的 GPU 卡片；普通窗口放入默认折叠的“其他会话”，总览内也折叠普通会话，仍可展开查看、选中准确窗格及使用原有确认关闭入口。轮询保留展开状态，选中普通窗口时自动展开对应导航。
- Simple API 实际核对 NWPU5 返回的 m1_git_upgrade、m1local_dev、m1mechanism_dev 等会话，其窗口无插件任务回执；插件任务的 run-时间戳 命名保持不变。本次仅修改显示，未创建、关闭 tmux 窗口或改写任务。回归覆盖大量普通窗口、GPU 固定顺序、空闲 GPU、普通窗口选择、轮询展开状态，以及任务日志跳转与关闭按钮路由。

## 0.5.251 (2026-10-09)

- 收紧 job 自动重试判定。已有成功 job 或过半运行不能覆盖失败类型门禁：AttributeError、导入/语法/配置/输入错误、维度不匹配与原因不明的失败停止自动重试。CUDA 初始化、连接中断等明确可恢复的故障仍需健康证据；内存/显存不足或设备繁忙则退避后返回队列，重新检查 Worker/GPU，无需等待成功种子。保留 30/60/120/240 秒退避和五次实际失败上限，等待资源本身不增加失败次数。
- 每次到期重新核对当前 Worker 完整身份及失败证据；若新的失败详情证明是代码错误，撤销旧重试期限。升级后阻止旧版已生成但未派发的不安全自动 attempt，已派发或运行中的任务仍保留。失败原因与历史日志持久化，面板明确显示停止原因，修复后仍可手动重试。
- 回归覆盖启动时过半运行后全体 AttributeError、成功种子与代码错误并存、未知错误停止、资源不足重新排队、旧期限撤销、升级后的本机待派发 attempt、手动重试及真实 Host 多轮派发。Simple API 读取的六个首次 AttributeError 回执与完整身份通过内存回放，均停止自动重试且没有生成新 attempt；未改写实际队列，残留 tmux 窗口与历史文件保留，未启动新实验或执行清理。

## 0.5.250 (2026-10-09)

- 修复已完成重试的 wrapper 结果被误报缺失：Plan 的 runId 与 job 的重试目录标识各自保留，通过完整 job 身份及队列中独占的 attempt 目录确认来源，覆盖迁移重排与自动重试，不要求重试目录名等于 Plan runId。
- 保留 SHA256、来源、Case/seed、run、attempt 与 checkpoint 校验。复用的旧目录、输出冲突、历史 attempt、未核实任务及真实缺失仍拒绝发布，保留旧完整结果；三种子完整发布和四态、任意 wrapper 产物原子发布规则不变。
- 回归覆盖普通完成、手动重试、跨 Worker 重新分配及自动重试的持久化、无网络本地刷新、重复下载幂等，以及重试中缺文件、哈希不符和 checkpoint 冲突。
- 实际补收使用生产重建链路和 SimpleSFTP API，已发布 MultiModal 的 DPL `distributed-plan-1791379276392-jqzwhi` 与 DRF `distributed-plan-1791379121239-bys2fy`，各六个 job、合计 168 个原始产物的 SHA256 与来源身份全部核对。registry 仅使用对应新版运行的种子，两数据集的 final CSV/Markdown 与新版 registry 重建内容逐字一致，原有 168 个历史产物保持原哈希；未重训。

## 0.5.249 (2026-10-08)

- 修复 Agent 升级后，原排队 job 引用旧 runtime generation 的代码证明而无法启动。只有原证明的完整身份、规范路径及全部文件 stat 绑定仍通过校验，才签发当前运行时的证明；身份冲突、文件变化及不支持的证明格式继续阻塞。
- 新证明持久化到原 job，保留 commandId、runId、attempt 和输出目录，并记录原证明来源。Worker 与本机均在新鲜、身份一致的回执中清除已解决的代码阻塞信息；保留原始失败及重试历史。GPU 繁忙时继续等待空卡，不创建额外训练副本。
- 排队中的代码证明错误显示为启动前校验阻塞，提示更新对应 Worker Agent，不再误报训练失败。只有重载本机插件不足以更新远端续验逻辑，Worker 需要部署并重启此版 Agent。
- 验证覆盖真实 Agent 函数的旧证明续验、身份与文件变化拒绝、服务器队列持久化、GPU 占用等待、重复轮询及面板提示；实际服务器恢复需在本地 API 可用后另行核对。

## 0.5.248 (2026-10-08)

- 修复本机空卡调度反复取消同一排队 job 并分回原 Worker 的循环。原 GPU 已核实空闲时继续等待原任务启动；确需迁移时持久化目标 Worker，只有收到完整的未启动释放证明才创建下一 attempt，分配不会回跳原 Worker。
- 回执核对保留原 commandId 与待核实状态，每次核对至少间隔十秒；重载沿用核对时间。Worker 代码版本、GPU 占用和完整任务身份检查继续生效。
- 快照请求超过短等待窗口时只复用五秒内已核实的快照，不伪造新时间；早于刚接收回执的缓存不会立即撤销排队状态，断联、过期或新快照仍按待核实处理。
- 回归覆盖重复调度、迁移目标、启动竞态、无效 GPU 证据、回执延迟及重载恢复。实际服务器链路需在重载插件且本地 API 恢复后核对。

## 0.5.247 (2026-10-08)

- 同一 Plan 已有核实成功的 job，或正常运行的 job 超过总数一半时，启用失败 job 自动重试；健康依据按运行记录保存，不借用旧运行的成功结果。
- 失败退出与完整身份核实后按 30、60、120、240 秒指数退避重新排队，累计连续五次失败后停止。退避时间与次数持久化，重载不会重置；重试使用独立 attempt，保留原始失败记录，继续检查 Worker 版本及空闲 GPU。
- 当前最新活动运行及选中的部分失败运行可在升级后自动接续；废弃旧运行、未知状态、人工停止及身份冲突不重跑。明确中止 Plan 后，即使远端清理未完成也持久化关闭自动重试。
- Plan 卡片显示重试等待、重试排队、连续失败次数及停止状态。验证覆盖生产 Host 调度、冷恢复、退避上限、身份核验、空闲 GPU 和版本锁；实际服务器自动重跑需重载插件后观察。

## 0.5.246 (2026-10-07)

- 修复清理 GPU 任务标签及关闭单个 tmux 窗口时返回 HTTP 404：Agent 的通用 POST 路由白名单遗漏了已有的 kill-window 接口，使请求无法进入处理函数。
- 增加提取生产 HTTP 处理函数的回归测试，覆盖 Worker 与 Hub 模式、截图中的四个窗口、认证和本机访问限制、精确目标、关闭失败及关闭后仍存在的窗口；保留现有 Worker 身份核验与用户确认。
- 已验证本机 HTTP 测试与打包运行时；未关闭实际服务器窗口。服务器需要部署并重启此版 Agent，单独重载本机插件不能修复旧 Agent 的路由。

## 0.5.245 (2026-10-07)

- Agent 健康接口立即返回依赖检查中的明确状态，合并同一环境的并发检查；缓存身份包含 Scheduler、解释器文件变化和环境配置。启动 Plan 前仍保留新鲜依赖检查。
- 部署校验并行读取各 Worker 的文件 SHA256 和版本，复用本次核验，减少重复请求。依赖检查中不会显示为已就绪。
- 同步与下载通知只列未成功项，最多六条；完整明细保留在结果区。已被新请求替代的结果请求不再重复弹出取消通知。
- 版本审核按 Plan 分表，每次运行一行，按数据集及指标对齐正式统计，显示四位小数的均值±标准差；预览及核验失败保留并明确标识。临时结果仅存于审核页内存。
- 配合 SimpleSFTP 0.2.61 核实旧清单读取请求的退出回执，解决 NWPU5 遗留 projectInventory 请求阻挡代码发布。未确认退出或目标身份变化时继续阻止重发。
- 验证包含提取生产函数的冷启动并发检查、版本审核渲染与选择、旧请求退出核实、通知及既有结果链路回归。当前服务器只核对了遗留请求身份与原版本热探测；新 Agent 冷启动速度需部署并重载后实测。

## 0.5.54 (2026-09-21)

- 代码上传不再读取或阻止 Worker 的 Git 修改、未跟踪文件和版本差异；用户确认目标路径后按所选上传范围直接覆盖。上传后的文件哈希校验继续用于确认传输完整。

## 0.5.53 (2026-09-21)

- 任务失败时 tmux 仅回显原始程序 stderr，stderr 为空时才回退 stdout；不再输出包装器报告、完整命令参数或 `CalledProcessError` traceback，同时保持非零退出码。

## 0.5.52 (2026-09-21)

- tmux 详情原样展示远端窗口的历史内容，不再识别、筛选或截断错误；自动刷新时保留用户滚动位置，仅在已位于底部时继续跟随最新输出。

## 0.5.51 (2026-09-21)

- tmux 详情读取最多 2000 行历史并合并自动换行，优先展示原始异常附近的 traceback；不再用命令参数开头的 12000 字符覆盖显存不足等根因。

## 0.5.50 (2026-09-21)

- 上传与下载分别使用独立范围配置；彻底移除旧“设置跳过文件”命名和兼容入口。

## 0.5.41 (2026-09-20)

- 部署 Agent 点击路径不再同步输出完整面板状态和重复计算诊断信息；预检 Xshell/SSH 配置时不再重复推送未变化的面板状态，减少弹窗前的界面卡顿。

## 0.5.40 (2026-09-20)

- 实验准备区只显示当前下拉框选中的 Plan 卡片；切换 Plan 后立即更新卡片，不再堆叠其他计划。尚未选择或未识别时显示明确提示。

## 0.5.39 (2026-09-20)

- 运行进度按 Plan 显示单行摘要，运行中和异常置顶，已结束的 Plan 折叠；展开 Plan 可就地查看任务与日志，完整记录仍可按需打开。
- 诊断与自检默认只显示服务器健康状态和近期待处理问题，检查矩阵、审计、历史错误与工具按需展开。

## 0.5.36 (2026-09-20)

- 全项目结果重建采用手动请求预算查询每个 Plan，避免沿用后台快照的 60 秒间隔，导致本机 API 等待超时。
- 结果区仅将插件生成的 `final/final` 和方法表作为简洁入口；同步当前 Plan 时仅下载原始 seed 与详细追溯表，不再生成重复的 `trace/<Plan>_final` 副本。

## 0.5.35 (2026-09-20)

- 全项目和各方法结果分别写入 experiments/results/final/ 与 experiments/results/<方法>/；跨 Worker 逐 seed 去重后重新计算均值和样本标准差。
- 当前 Plan 的原始 seed、详细聚合及计算副本按方法放入 raw、detail、trace 子目录，批量同步仍限当前 Plan。
- 结果区新增按列、搜索词条、手选或批量选择和保留列生成 CSV 子表；修复跨 Plan 查询没有传递 Plan 路径。

## 0.5.34 (2026-09-20)

- 结果区将当前 Plan 简洁汇总提升为独立主卡片，明确区分 CSV 精确值与 Markdown 可读版；缺失文件时直接显示原因和重建入口。
- 原始 seed 表、详细汇总与跨 Plan 项目总表改为分组折叠；按钮文案说明范围，悬浮提示解释计算内容、同步位置及文件来源。

## 0.5.33 (2026-09-20)

- Plan 结果新增按方法、数据集、比例、评估端点分行的简洁 CSV 与 Markdown，项目总表也提供简洁版；原始表及详细均值标准差表保留。
- 修复不同评估端点被合并到同一行的问题，并对缺失 seed 标记参与数。跨端点派生指标仅在结果区明确配置后计算。
- 结果区优先打开简洁表；按钮通过现有 Agent 隧道同步到本机 `experiments/results/`，轻量归档包含新表。

## 0.5.32 (2026-09-20)

- 结果列映射改为结果区就地展开：case、seed、指标名称、指标值先显示，其他字段按需展开；下拉候选显示原始 CSV 列名与样例值。
- Agent 结果预览增补受限样例值，供插件界面解释列含义；设置页保留跳转入口。

## 0.5.31 (2026-09-20)

- 结果区增加“一键同步所有结果”：按当前 Plan 最新摘要批量下载原始表、汇总表及已有分析结果到本机 `experiments/results/`，多 Worker 分目录保存。
- 已有本地文件时只确认一次，可选择覆盖或只同步缺失文件；下载按 Agent 隧道请求预算依次执行，显示进度和失败清单。

## 0.5.30 (2026-09-20)

- 结果列映射改为插件设置中的交互表单，候选列来自当前结果预览；输出接入规则保存为工作区插件配置并同步到 Agent 自有状态目录，不再要求项目存在 `experiments/simple_project.yaml`。
- 结果文件“打开”入口先确认目标，再同步到本机 `experiments/results/` 后打开；跨 Worker 副本分别放入服务器子目录。
- 停止在项目准备和 Plan 校验时自动生成 `simple_project.yaml`；旧文件继续作为可选兼容输入。

## 0.5.29 (2026-09-20)

- 结果区直接打开当前 Plan 原始表和插件生成的跨 seed 均值/样本标准差表，支持列映射预览与重建。
- 增加当前 Plan 轻量归档副本：远端 Worker 与本地各保存一份，原始共享 CSV 按 Plan case/seed 筛选，不复制 checkpoint。
- 单 Worker 文件入口复用 Worker Agent 隧道，多 Worker 按归属显示文件入口。

## 0.5.28 (2026-09-20)

- 修复面板各卡片的“折叠/展开”按钮未携带区块标识、点击无效的问题。
- 标量曲线对比上限调整为主图加 19 个附加 case，插件 API 与 Worker 同步支持 20 个；曲线颜色扩展到 20 种。
- 曲线卡片底部悬停详情改为每个 case 一行的紧凑对比表；case 与 step 列按内容收紧，将宽度留给数值列。常规曲线的数值表头标为“均值”，极值点和原始单 seed 曲线分别标为“极值”和“原值”。每个 seed 独占固定列并以蓝色表头标识，缺值显示“—”；窄卡片保留核心字段，去除卡片内部纵向滚动。平滑均值改用粗实线、原始均值改用细虚线；标准差阴影以原始均值为中心且先于所有折线绘制。
- 插件重载后保留本机曲线页的授权，原有标签自动重连并恢复曲线刷新；优先复用本机 API 端口，原生内容标签在重连后重新加载。

## 0.5.27 (2026-09-20)

- 实验曲线侧栏将主图选择与加入对比分开，增大对比按钮，并显示独立的 seed 数标签。
- 侧栏支持拖动调宽、键盘方向键、Plan/case 搜索和“仅看已选”；长名称自动分行。

## 0.5.26 (2026-09-20)

- 标量页面设置可选择每行曲线数量；不足一行的单张图保持统一宽度，窄窗口自动减列。
- 每张曲线可单独切换“单行显示”，并保存本地布局偏好。
- 图例明确标注 step 总数与最后一个 step 的有效 seed 数。

## 0.5.25 (2026-09-20)

- “准备 Agent”完成后的可选提示不再占用宿主租约；后续按钮动作重新通过命令入口申请租约。
- 重载后若旧 Extension Host 进程已退出，立即回收其租约；仍存活的窗口继续受到互斥保护。

## 0.5.24 (2026-09-20)

- 实验曲线页选中 case 后自动列出全部指标，滚动到图表时批量加载可见曲线。
- 每张图加入去偏指数移动平均平滑，以及均值和各 seed 的最大、最小值标记；极值从原始值计算。
- Agent 支持一次查询多个指标，同一 Worker 每轮只接收一次合并请求。

## 0.4.92 (2026-09-02)
- 工厂化重构：48新文件+28 legacy归档，17 Facade，全仓 <250行，@ts-nocheck 清零
- 修复面板加载：PanelHtml 回退、provider 导出注册、packageJSON 容错
- 修复按钮静默：void catch、cancelled 通知、prepareAgents throw
- 修复文件传输：HostOperationLease 重入、runtime 路径 __dirname、runDraftDebug 统一
- 验证：build/tests/P0 双重门禁通过，手动测试通过，标记为最新可用版本

## 0.4.87

- 修复 UI 渲染失败：恢复 renderDetectedProject / renderExecutionSection / renderTaskSection / handleTaskPlanScopeClick / handleTaskSelectionChange 等在精简通信矩阵/集群运行态/调度占位时误删的渲染函数，消除 ReferenceError: renderDetectedProject is not defined at renderPlanSection:6483 与 renderExecutionSection is not defined at refreshTerminalUi:2719
- 执行 npm run build 全量门禁（typecheck + node -c + vm.Script + 10890 零命中），升 patch 版本

## 0.4.77

- 修复调度误判：看门狗 90s“无有效日志增长”误判为启动失败（running 4 pending 102 但持续 dispatch_probe error=目前无空卡 被判 255 未收到终态）
- clusterAgentRuntime wait_scheduler 增 busy-waiting guard：running>0 时 dispatch_probe“目前无空卡”/wait pending/dispatch/done 均视为有效进展，刷新看门狗 last_progress，passive_interrupt_requeue 视为有效日志进展（attempt 1/3 主动重入队非致命）
- RunOperations reconcile 增 busyWaitingActive 判定：liveLogTail 含 dispatch_probe 无空卡+running>0 或 passive_interrupt_requeue 时 hasActivity=true，runOperationShouldStaleByStall 亦豁免，仅 running==0 且无 dispatch/done/passive_interrupt 等进展且超时才判 stale/调度器启动失败
- extension refreshOperationStatus evHasActivity 同步修复：liveLogTail 解析 busyWaiting，forceStale 仅在非 busyWaiting 时触发，避免 GOP 忙时 GPU 满载正常等待被标 stale
- 升版 package 0.4.76→0.4.77、Runtime 0.4.76→0.4.77（write-agent-runtime 自动同步）

## 0.4.53

- 彻底去HUB、协议可配、UI断线
- MultiEndpointRealtimeClient: getDiagnostics/getAuditTail/getOperation/postAction/postAvailabilityBatch/listRemoteFiles/downloadFile/uploadFile 8个方法由 hubClient() 单点改为 workers->HUB 聚合（workers先直连HUB再聚合，否则直接聚合 workers），复用 getAggregatedGpuHistory fanout+merge 模式，失败单端忽略
- TunnelClient: GpuHistoryQuery 增加批量能力协商字段 batch/bucketSeconds/retentionHours，HttpTunnelClient 透传至 /api/gpu/history；RealtimeTunnelClient 透传聚合；extension openAuditTail/postTunnelAction 调用点从 hub 直调改为多端聚合
- Agent 协议参数化: src/clusterAgentRuntime.ts 与 dist/runtime/cluster_agent.py 将 GPU_HISTORY_BUCKET_SECONDS/RETENTION 硬编码 60/72 改为可配置（环境变量 SIMPLE_GPU_HISTORY_BUCKET/RETENTION(_SECONDS/_HOURS) 或启动参数 --gpu-history-bucket/--gpu-history-retention*），保留 60/72 默认回退，移除 300 硬编码
- UI 渲染去零填充: 移除 fill_gpu_history_points 补零（imputed True 按0补），改为 downsample 仅 real points，query_gpu_history 不再 fill 后 downsample，fill 仅返回 real；PanelHtml 文案“个缺失点按0补齐”改“个缺失点断线”；GpuHistoryState boundedNumber 默认 300→60，evenlySample 保持 gapBefore 断线逻辑
- 版本 package 0.4.52→0.4.53，Runtime 0.3.11→0.3.12

## 0.4.52

- GPU直连去HUB、历史按serverId路由、调度不依赖HUB
- MultiEndpointRealtimeClient：getGpuHistory 按 query.serverId 直连对应 Worker，重试仅当 target.id!=hub 时 hub fallback；target 为空时在 enabled workers 模糊匹配首个 worker 直连，找不到抛“Worker GPU历史未就绪，请检查隧道”，不再直接 hubClient() 抛 Hub not configured；overview 无 serverId 时走 getAggregatedGpuHistory 聚合多端
- endpointForGpuHistory 增强：case-insensitive 与 workerId 归一（toLowerCase），支持 displayName/sshConfigAlias 匹配
- extension：loadGpuHistoryFromUi 去Hub硬门控，hasEndpointsField && !hasCap 的 throw 改为 console.warn + 透传，允许 worker 早期无 capability 仍直连，保留 legacy 注释
- clusterSchedulerRuntime：hub_availability_cache / hub_cached_snapshot 改中性名 availability_cache，direct_tunnel 重试条件扩展为 age>2s 或空列表即重拉，source 标注 direct_tunnel / availability_cache
- GpuHistoryState：boundedError 透传保留原文；PanelHtml：rememberGpuHistoryState 在 stale/error 时删除 requestLastAt 限频，展开可重试
- 升版 package 0.4.51→0.4.52、Runtime 0.3.10→0.3.11

## 0.4.51

- GPU历史隧道直连去HUB依赖：单/多worker均经隧道更新，不再依赖HUB中转
- MultiEndpointRealtimeClient：getGpuHistory 按 query.serverId 路由到对应 Worker 的 RealtimeTunnelClient（匹配 id/workerId），serverId 为空时并行聚合多端（Promise.allSettled 合并，时间桶去重、按maxPoints截断），失败单端忽略、回退hub
- extension：loadGpuHistoryFromUi 去除 Hub 单端 gpuHistory capability 硬门控，改为 per-endpoint 检查（按 serverId 校验目标 Worker，若多端则任意一端有即通过），错误提示改为“目标 Worker 未暴露GPU历史”
- clusterSchedulerRuntime：probe_idle_gpus 增直连fallback，若 _availability 为空或 stale（目前无空卡且age>5s或无可用/忙列表）则经 127.0.0.1:workerPort 实时取 availableGpuIds（复用 fetch_worker_availability，标记 source=direct_tunnel），作为 hub_cached_snapshot 回退，避免调度卡死
- PanelHtml：requestGpuHistory 失败时 stale/error 提示可观测化，pill 显示“隧道直连失败，已回退Hub”并装饰原始错误
- 升版 package 0.4.50→0.4.51、Runtime 0.3.9→0.3.10

## 0.4.50

- 三触发调度与GPU阈值可调：彻底修复NWPU3误判，允许删重部署无需兼容旧版
- package.json：pollSeconds minimum 60→5，新增 gpuIdleUtilThreshold（0-100默认5）、gpuIdleMemThresholdMb（0-8192默认200）、sessionCheckMinSeconds（1-60默认5）
- extension：schedulerSettings新增三键读取、saveSchedulerConfigFromUi同步更新、actionBody透传 --gpu-idle-util-threshold/--gpu-idle-mem-threshold/--session-check-min-seconds；localWorkerAvailabilityRows改读schedulerSettings().gpuIdle*而非硬编码5/200
- clusterAgentRuntime：阈值改为环境变量注入 int(os.environ.get("SIMPLE_GPU_IDLE_UTIL_THRESHOLD") or 5) / MEM，scheduler启动时注入env并追加三参数
- clusterSchedulerRuntime：argparse新增三参数 default5/200/5，钳制max(5,poll)/max(1,sessionCheck)并注入阈值到probe；三触发：first_cycle首轮sleep 0、定时poll+jitter、完成立刻reap后break重调；reap受sessionCheck可调至5
- PanelHtml：CONFIG_SCHEDULER_BOUNDS追加三阈值，卡片新增三输入并动态文案 空闲判据：利用率<阈值%且显存<阈值MB
- 远端清理：rm -rf /data/qgking/zlk/simple_agent /data/qgking/zlk/simple_cluster/state /tmp/cluster_scheduler 子壳指令（探查不执行，仅写脚本），本地build后scp重部署
- 升版 package.json 0.4.49→0.4.50、RuntimeManifest 0.3.8→0.3.9

## 0.4.49

- 设置页精简3主+5高级、去TTL文案、旧缓存自愈、单阈值回退：package.json 8参数收敛为3主项（轮询间隔60s±30s抖动、利用率<5%且显存<200MB瞬时判空、事件合并延迟1000ms）+5高级移入<details class="advanced">高级（兼容，已忽略）</details>置灰，TTL加 deprecationMessage“已去TTL化，保留仅为兼容旧配置，修改无效果”；重命名标签并补 configHelp 20-40字tooltip；同步 CONFIG_SCHEDULER_BOUNDS 与 renderSchedulerGlossary 去“TTL过期后不再新派任务”误导；clusterSchedulerRuntime read_availability_cache 旧 reason 洗白为“目前无空卡”并同步 available，refresh_missing 扩展为 stale（reason==“目前无空卡”且age>60s重拉），extension localWorkerAvailabilityRows 单字段回退（仅util<5或仅mem<200即空闲）；extension shouldPushLocalAvailabilityFromRealtime 增加 availableGpuIds 集合变化强制推送，startAvailabilityPushLoop 固定60s去 jitter 耦合，ttlSeconds 固定180；worker_availability.json 旧污染自愈无需手动删；升版 RuntimeManifest 0.3.7→0.3.8 与 pluginVersion 0.4.49 联动

## 0.4.48

- 修正0号卡UUID误识别为0：src/clusterAgentRuntime.ts gpu_row_id 改为显式判 None 而非 falsy（for k in ("index","gpu_index","gpu_id","gpuId","id","uuid") + is not None 且优先 index 数字 0-3 返回 "0"），修复 availableGpuIds 首项为 "GPU-28631210..." 而非 "0"；同步检查 gpu_row_busy 去除 or 误判；固化 start_worker_telemetry_sampler 自刷新（write_worker_gpu_snapshot 后写 worker_availability.json）；升版 RuntimeManifest 0.3.6→0.3.7 与 pluginVersion 0.4.48 联动

## 0.4.47

- 重构空卡判别为瞬时双阈值：利用率<5%且显存<200MB立即判空，不需要时间窗口/历史平均，符合立即调度；修复 NWPU3 dispatch_probe 误判“目前无空卡”但实际全空
- clusterAgentRuntime：删除5秒窗口常量/GPU_5S_HISTORY 及5秒记录写入，保留瞬时 util/mem 写入；新增 GPU_IDLE_UTIL_THRESHOLD=5 与 GPU_IDLE_MEM_THRESHOLD_MB=200（中文注释“利用率<5%且显存<200MB判空，瞬时”）；重写 gpu_row_busy 为瞬时读取 utilizationPercent/utilization/gpu_util 与 memoryUsedMb/memoryUsed/memory_used，满足双阈值即空闲 else 忙，仅字段缺失时回退 processCount>0
- extension：删除 gpuUtil5sHistory Map 与 recordUtil/calcAvg，localWorkerAvailabilityRows 改为直接取 utilization/memoryUsedMb 判断 util<5 && mem<200，busy/available 同阈值，reason 保持“目前无空卡/可用”；clusterSchedulerRuntime probe_idle_gpus 保持去TTL，校验不再依赖历史
- 升版 pluginVersion 0.4.47 与 CURRENT_RUNTIME_VERSION 0.3.6 联动，hash 校验一致，保留中文注释与 esc 脱敏

## 0.4.46

- 修复 history warming 误判：_计算5秒平均利用率 与 extension calcAvg 的 len<3 返回None 改为若任一样本 util==0 则直接允许 avg 计算（1秒判空），否则 len<2 才None；collect_local_gpu 写入 avgUtil5s 时 util==0 仍写入 0
- 修复 capacity 放大：extension capacityLimit 由 worker.maxConcurrentGpus||1 改为 worker.maxConcurrentGpus || total_gpus || 4，确保4卡Worker并发4；调度器侧 capacity max(1,total_gpus) 保留
- 修复 _is_noise_line 误杀：白名单化调度器启动失败/目前无空卡/排队等待中行不被过滤
- 修复日志空链：_read_effective_tail L3 有效尾非空时不因 live_log_count<=3 无关键词而 fallback 稀释；logPath 双字段落盘保留原始相对路径，前端诊断展示相对路径而非“-”；_schedulerErrorZh 前置判目前无空卡/all_busy 再 return ""，避免3行调度日志被判 none
- 中文化残留：failures message 中 all_busy/all_busy_or_disallowed 映射为“目前无空卡”，blockedReasonSuggestion 补充 all_busy_or_disallowed、无可用→“目前无空卡”
- 双端窗口去重与 reset 清 Map 已同步，warmup 1秒判空、噪声白名单、日志路径修复、kind修复

# Changelog

## 0.4.45

- 重构空卡判别：去掉 TTL/英文缩写，5秒内显卡平均利用率<5%判空；新增 GPU_UTIL_5S_WINDOW=5/GPU_IDLE_THRESHOLD=5、内存滑动窗口 _GPU_5S_HISTORY 与 _记录显卡利用率/_计算5秒平均利用率（样本<3返回None），collect_local_gpu 每秒采样写入 avgUtil5s/5秒平均利用率 字段，sampler_interval 默认1s；availability_from_gpu 去 ttlSeconds、reason 中文化为“可用/目前无空卡/暂无显卡数据”，gpu_row_busy 按5秒平均判忙，无历史时回退进程数。
- 调度器 clusterSchedulerRuntime 去TTL：probe_idle_gpus 删除 age>ttl/available==False 分支，无可用性时 error="目前无空卡"，简化 availability_age_seconds/is_fresh/note_receipt 与 read_availability_cache/fetch_worker_availability 的 ttl 读写；调度循环 no_dispatch_error_cycles>=3 由 fail_pending 直接失败改为排队等待（_append_scheduler_log“目前无空卡，排队等待中”+write_current_state“目前无空卡”+no_dispatch_error_cycles=0 继续等待），scheduler_wait_reason 默认“目前无空卡”。
- 扩展 extension.ts 去TTL：localWorkerAvailabilityRows 删除 ttlSeconds 形参，新增 gpuUtil5sHistory 字典每秒记录 utilization 并计算5秒平均，busy/available 按5秒平均，reason 中文化同上，删除 allowedGpuIds 复杂过滤仅保留“显卡被配置过滤”提示；同步更新 PanelHtml.ts blockedReasonSuggestion 增加“目前无空卡”、_schedulerErrorZh/_is_scheduler_source 正则增加“目前无空卡”、升版 pluginVersion 0.4.45 与 CURRENT_RUNTIME_VERSION 0.3.4 联动，hash 校验一致，保留 esc 脱敏与中文注释。

## 0.4.44

- 修复截图“调度已结束但任务快照未回传 首错all_busy 110失败”与“运行计划 执行中 调度已停止 暂无日志 行数0”插件漏传报错日志：明确插件调度失败 vs 程序失败，Agent _classify 运行态过滤放行含 all_busy/busy/no_idle/probe/无空闲/无可用/all worker 的行，不再误判 kind=none；_has_sched_kw 扩充 all_busy|busy|no_idle|no[-_ ]idle|probe|无空闲|无可用|all worker 并大小写不敏感，确保3行调度日志被识别为调度相关。
- 保留3行 scheduler started 小日志不因 _raw_size<512 或行数少而 fallback；fallback 时 _workerResolveErrors 可见；extension 侧 evHasError 放宽已含死证据，保持 head500+tail3000，小日志直接返回不强制合并覆盖。
- 面板 renderOperationLogsWindowed 当 combinedSrc 为空但 ev/liveLogTail 有3行原文时纳入首错 pre 块而非“暂无日志”，红脱敏150与logTail4000联动保留首尾，首错 all_busy 在尾20行可见；operationDisplayMessage dead 判定与日志窗解耦，诊断 pills 正确显示 logPath/liveLogCount/kind=scheduler；复用 blockedReasonSuggestion 新增“无可用GPU，请检查Worker空闲或等待资源释放”。
- 调度器 clusterSchedulerRuntime fail_pending 前将 reason 中文化写入 payload/message 首行：all worker dispatch probes failed 追加“所有Worker均无空闲GPU（all_busy）”到 _append_scheduler_log 与 payload.message，便于 Agent _schedulerErrorZh 捕获并在 UI 首错显示；升版 pluginVersion 0.4.44 与 CURRENT_RUNTIME_VERSION 0.3.3 联动，hash 校验一致。

## 0.4.43

- 修复“调度已停止（远端进程已退出，未收到终态）且日志为空”：Agent 侧 _read_effective_tail 扩充 _has_sched_kw 至 Killed/OOM/out of memory/signal/Segfault/CUDA/NCCL/exit code 等（大小写不敏感），_raw_size<512 时若尾含关键错误则保留不稀释，_is_noise_line 白名单强制保留 Killed/OOM/signal/exit code 行，fallback_candidates 同时尝试 {opId}.log + {planKey}.log + payload.schedulerLog 并将 safe_project_path 越界记入 _workerResolveError。
- 扩展侧 effectiveLiveTail 回填放宽 evHasError（增加 ev.error/ev.dead/ev.liveLogTail 判据），dead 或 liveLogCount==0 时强制回填，fallback 4000 截断改为头 500 + ...[truncated]... + 尾 3000 保留首错，withNl 与 effectiveCount 同步。
- 面板日志窗 renderOperationLogsWindowed 在 combinedSrc 空时优先渲染首错 pre 块，仍空但 operationHasDeadEvidence 为真时兜底“调度已停止但未捕获日志，已记录 dead 证据，请查看远端 simple_cluster/tmp/cluster_scheduler/{opId}.log 原始文件或点击中止清理”并带 pidAlive/tmuxAlive/operationId/fallback 诊断 pills，解耦 operationDisplayMessage 与日志窗。
- 保留 16KB→150→4000→50 分层注释并同步关键词列表，保留 esc/escAttr/compactText 脱敏限长与中文建议同屏。
- 升版 pluginVersion 0.4.43 与 CURRENT_RUNTIME_VERSION 0.3.2 联动，hash 校验一致。

## 0.4.42

- 同屏展示 blockedReasons 列表与 dispatchProbe 的 structuredError.suggestedAction 中文建议（probe_idle_gpus 等），panel 可展开 <ul> 同行 tooltip 限长显示，复用 ErrorModel.ts 的 RUNTIME_OOM/DISK_FULL/RUNTIME_INTERRUPT 及 probe_idle_gpus 两条“确认 Agent 在线…”文案，保持 runnerWarnings 计数逻辑不变。
- 扩展 extension.ts compactProbeForWebview/compactWorkerProbeForWebview 将 structuredError.suggestedAction 透传为 suggestion/structuredError，经 buildState 到前端；clusterSchedulerRuntime.py dry_run 的 blockedReasons 追加“建议：xxx”中文后缀并完整保留 dispatchProbe。
- fallback seq:-1 终态保护单测：新增 test/state/StateReducer.fallback-seq.test.js 覆盖 terminal 集合不被 -1 覆盖、mergeVersionedState/mergeRows seq 注入、stateVersion/generatedAt 倒退拒绝及 sessionId 分流语义。
- 升版 pluginVersion 0.4.42 与 CURRENT_RUNTIME_VERSION 0.3.1 联动，hash 校验一致。


## 0.4.13

- Kept the configured tmux session prefix in compacted panel state so Agent session defaults render and persist the user's value instead of falling back to simple.

## 0.4.12

- Mirrored panel-saved tmux prefixes and Conda defaults into global settings, preserved them across restarts when settings are unchanged, and let changed VS Code settings take precedence.

## 0.4.11

- Backed upload path confirmations with per-workspace VS Code state in addition to the project-local file, so remembered paths survive extension updates, window restarts, and cleanup of generated UI state.
- Rechecked stored update plans against installed versions, hid the install action when both plugins are current, and made update commands return structured results to the local API.

## 0.4.10

- Tagged single-Worker scheduler stop requests as local Worker scheduler operations so the telemetry client routes them to the owning Worker instead of rejecting them as Hub-only actions.

## 0.4.9

- Declared Worker support for `stop-scheduler-operation` and accepted the existing real-action capability on compatible deployed Agents so stale single-Worker runs can be stopped without a second runtime deployment.

## 0.4.8

- Restored the default `invoke` execution branch so commands such as `stopExperiment` return structured results instead of silently returning null.
- Routed single-Worker run reconciliation evidence through the owning Worker Agent endpoint and recorded checked pid/tmux/activity state before stale marking.
- Required a new active `run-plan` or `reproduce-plan` operation before reporting formal workflow submission success; duplicate guards now return structured blockers.
- Fixed `project.prepare` RPC parameter handling, exposed final roots and effective Worker limits in previews, and preserved existing Worker GPU concurrency during partial setup merges.

## 0.4.7

- Added a paired update entry point that checks GitHub Latest Releases for SimpleExperiment and SimpleSFTP, verifies VSIX sizes and SHA-256 checksums when supplied, installs SimpleSFTP before SimpleExperiment, and asks before download/install or reload.
- Added public user documentation for Xshell local forwarding, Hub/Worker settings, remote roots, scheduling limits, result handling, AI/SKILL API constraints, and troubleshooting.
- Moved internal batch-planning notes out of the published repository; durable architecture boundaries now live in `docs/architecture.md`.
- Added orphan `run-plan` / `reproduce-plan` reconciliation against Worker pid, tmux, scheduler state, traces, and live logs before duplicate-run checks and workflow planning.
- Routed single-Worker `stopExperiment` by operation owner or the sole enabled Worker, including structured matched/terminated/reconciled results when no process matches.
- Refreshed missing or expired Worker availability through a bounded Agent query with atomic snapshot replacement and local-clock TTL checks.
- Deduplicated concurrent result parsing by workspace, Plan file/revision, and owner; added filtering/pagination to `operations.list`.
- Preserved remote-root priority and allowed/denied boundary checks across preparation, preview, upload, scheduling, and runtime paths.
- Kept legacy `zlk_cluster` state read-only and surfaced manual cleanup guidance without blocking uploads or rewriting historical evidence.
- Added automatic local/GitHub provenance snapshots for every formal or Debug Plan submission and propagated them into Agent operation audit events.
- Added structured workflow blockers with operation/server IDs and evidence counts; `autoPrepare` remains behind explicit confirmation.
- Expanded reconciliation evidence to Worker task snapshots, taught single-Worker stops to target synthetic requests, and added bounded SIGKILL escalation.
- Merged concurrent result parsing across host-operation lease conflicts instead of opening a duplicate parse.
