# 传输等待、退出核查与通知收口

## 2026-10-07 本地结果独立刷新与旧只读下载恢复

- [x] 当前 Host 28164 运行 0.5.230 / 0.2.58。API 返回 catalogLoadStatus=error，缺少 dist/extension/results/ProjectResultCatalogWorker.js；实际线程在 dist/results。上轮 fake Worker 及直接 catalog 函数验证漏掉真实入口；本次先用实际编译目录启动 Node Worker 复现失败，修正相对路径后通过。新增只读“刷新本地结果”，重置读取失败退避、取消过期读取并按当前 results interest 重读；不连接服务器、不下载、不汇总，保留最后可信目录，独立于远端同步锁/失败回执。
- [x] 只读 transfers.list：sftp-3512-1791292735154-glofj6d6ou6 仍 outcomeUnknown、childCount=0，旧 instance=3512:2026-10-06T13:17:53.723Z。两插件恢复白名单原来只支持服务器间传输，不能核实旧 mapped download。现在匹配原 operation/instance/requestKey/下载目标，只允许 remoteMutation=false 的读协议；两次核实旧 Host 与本机运输进程退出后持久化 settled 再允许一次新请求。活跃 child、旧 Host/运输进程仍存活、身份不匹配、无法证明只读、回执写入失败继续阻止；不凭 childCount=0 清记录，服务器间写入保护保持。
- [x] 串行 SimpleExperiment 151、SimpleSFTP 72 个 Node 场景通过（含 build Webview 解析门禁 1 个，不重复统计同文件重跑）。覆盖真实 Worker 启动、已提交/回滚与真正发布事务、本机已有表格/部分同步失败/离线刷新、取消 generation 的迟到回调、精确目标恢复及活跃请求保护；主目标 panelResultCatalogCache 7/7、safeRequestRetry 14/14、resultDatasetHierarchy 8/8、transferRecovery 22/22。状态 ACK/背压/健康/生命周期、指标同步完整性、gzip 内存下载、传输退出回执与 API 回归均通过。两插件 build、Webview vm.Script 通过；SimpleSFTP 首次 build 的 vsce ls 触及原有 8 秒超时，后续完整 build 通过，未放宽门禁。
- [x] scoped commit/push/fetch：SimpleExperiment 3a4dc326 / SimpleSFTP a8b7e00 均普通 fast-forward 推送，fetch 后 HEAD=origin/master。各执行一次 install:latest 安装 0.5.231 / 0.2.59，无 force/降级；code 列表、simpleex / simple-sftp-api 入口、安装后去重的 192 / 18 个运行文件及 package.json（排除 VS Code __metadata）核对通过。安装后停止 API/Panel 操作，原有两个 dirty pyc 未暂存；新版网络与 UI 仍需重载验收。

打包核对：SimpleExperiment 0.5.231 / SimpleSFTP 0.2.59。VSIX 内去重后的 192 / 18 个运行文件与工作区逐字节 SHA256 一致，真实目录 Worker 收录且无 pyc；buildId=3f6f9b55ee9b。VSIX SHA256 分别为 5b34a4686ba71ceb81df868a0d15ea0f4d9f0d735a0c3a7f03e71d34514e79ff / 3b83ef796d65569d9bbc0788de7dbed41019819a38ce46c5528bb7962d1210a2。主项目首次 package 也因原有 vsce ls 8 秒截止失败；进程退出后完整 package 重跑通过，没有绕过或延长门禁。

真实只读边界：修正后的同一生产 Worker 从真实 MultiModal 目录读到 BUS final 32 行、PAD final 34 行，分别 17 个 method 表；该结果证明本地文件可独立读取，不代表缺失 seed 已补全。未调用真实下载、清理或取消旧请求，未改写 MultiModal。旧请求自动核实与新版按钮需用户重载窗口后验收；旧 Host 的错误/空目录状态不能冒充补丁已生效，两个 dirty pyc 保留未暂存。

## 2026-10-06 指标批次启动与本地目录读取回归

- [x] 只读 discovery/capabilities 确认 Host 3512 运行 0.5.229 / 0.2.57，API state 的 catalogLoadStatus=loading；真实本机发布记录为 committed、75 个文件，与 registry generation 一致。17 个 Plan 已发布，未删除或重发旧产物，两个 dirty pyc 保留。
- [x] 128 个长路径映射复现 SSH argv 超限；固定远端脚本、1 MiB 有界 UTF-8 stdin manifest，不逐文件启动 SSH，不写暂存脚本。同步 spawn 失败曾泄漏无子进程的 controller；现在直接释放，仅已启动的子进程继续遵守退出核查。SHA256/大小/路径/取消及 gzip 门禁保留。
- [x] committed/rolled-back 记录存在被当作 publicationPending，导致线程永远无法启动；读取明确状态，preparing/publishing 才等待，无效状态显式错误。后台线程生命周期回归证明部分成功目录 ready 并 postState；只读真实 MultiModal 目录已能读取 BUS/PAD 各 34 行 final、各 17 个 method 表。该验证不等于已在运行中的旧面板展示，也不代表缺失 Worker 指标已下载。
- [x] 串行 SimpleExperiment 147、SimpleSFTP 69 个场景通过；另含 build Webview 解析 1 个，两项目 build 与 vm.Script 通过。初次新回归明确复现 argv 超限、controller 泄漏及 settled journal 假等待；未删除失败测试或提高任何超时/内存阈值。
- [x] 补丁 0.5.230 / 0.2.58 打包验证：194 / 18 个运行文件与工作区逐字节 SHA256 一致，无 pyc；buildId=341aabeb0be9。VSIX SHA256 分别为 ed344f1026f57739f0887470765a0fb9d8f0dc050cb359b26d0de04acdf643e1 / 0f55161536a37bf9a5d7e74614fa2a0c0dc82626949ec35eb45ac7f566d1e328。
- [x] scoped commit/push/fetch：SimpleExperiment c1208082 / SimpleSFTP 6c1c1e0 普通 fast-forward 推送，fetch 后 HEAD=origin/master；自动安装 0.5.230 / 0.2.58 各一次，无 force/降级。CLI 版本、simpleex / simple-sftp-api 入口及安装后 194 / 18 个运行文件身份核对通过（package.json 排除 VS Code __metadata）；随后停止 API/Panel 操作。两个原有 dirty pyc 未暂存。

现场边界：本次已只读证明原先成功收录的 17 个 Plan 结果文件真实存在且可解析；修补后的目录状态检查为 publicationPending=false。运行 Host 尚未加载补丁，大批次修复通过真实生产 seam 及有界 stdin 回归验证，未重发真实下载、取消旧请求或改写 MultiModal。缺少来源指标的 3 个预实验仍属待指标，不能冒充成功；新网络下载及面板展示需重载后验收。

## 2026-10-06 指标直取与结果重建回执

- [x] 读取约束/Git/discovery/capabilities：本地及三个 Worker 均报告 0.5.228；两个 dirty pyc 保留。只读操作记录显示 12:24 的重建产生 local-file-io 进展，但 684929 字节的 operation_completed 被替换成 journal_gap；另一固定签名重建 ID 命中 10 月 2 日的旧 failed 回执，仍返回旧版错误文字。不能再把本次报错直接说成新版 I/O 监视器失效。
- [x] 三个指标按钮统一按当前 revision 的最新完整 run，从任务所属 Worker 直取逐 seed 指标，只有所属 Worker 缺失时才核验队列已记录且 SHA256 相同的同 run 镜像。无服务器间镜像/权重/日志同步前置步骤，不读取远端 final/aggregate/Markdown 表。通过 SimpleSFTP memoryOnly 协议分来源 gzip 打包，128 文件/4 MiB 有界接收、两端 SHA256、严格 UTF-8/Case/seed 校验；本机只发布规范化 registry 和所需表格，不写 raw CSV、下载暂存或原文缓存。单一通知、取消透传并释放监听器。
- [x] 用户追加取消所有远端自动重建：完整产物同步也不调用 preview/formal rebuild；Agent 与 scheduler 的自动 completion aggregation hook 保留兼容入口但不执行解析/统计或产生远端缓存。原始训练产物、权重、日志及任务状态保留；没有删除已有远端/本机文件，旧汇总不再成为新版 run 的来源。旧显式底层工具保留兼容，指标按钮不调用。
- [x] 旧显式重建 helper 每次真实提交使用新 operationId，manifest signature 仍为成功缓存键；先失败后重试不复用旧回执。超限终态保留 bounded completion/failure/cancelled receipt、outputPaths/counts；输出清单无法完整表示时明确失败，非终态仍报告 journal_gap，不扩大 journal/SSE 上限。
- [x] 生产 seam 验证：三个按钮各读取最新 B 的 6 个 job，BUS/PAD 各 3 seed，忽略 A 共享 CSV 且不创建 raw/staging；所属 Worker 缺失时仅接受 hash 一致的已记录镜像，hash 不同拒绝下载。终态 684929 字节 fixture 保留 completed/failed/cancelled 与完整输出清单。逐文件串行 SimpleExperiment 197、SimpleSFTP 59 个场景通过，包含原子发布、取消 RPC/监听器释放、完整权重同步与 Panel 背压/渲染回归；两项目 build 与 Webview vm.Script 通过。SimpleSFTP 第一次 build 的 vsce ls 在既有 8 秒上限超时，后续完整 build/package 通过，未延长上限。
- [x] 打包 0.5.229 / 0.2.57；VSIX 内 194 / 18 个运行文件与工作区逐字节 SHA256 一致，无 pyc。SimpleExperiment buildId=58038b9efc51，VSIX SHA256=f903e63affa4b596041c9fe503c2d478a1f59d0aee83b85915d721871ab00fce；SimpleSFTP VSIX SHA256=4549d01dba54e7cde8b6f7e3c54c185227bdd0967c904c93f79318de6269291f。
- [x] scoped commit/push/fetch：SimpleExperiment 1f0fa94b / SimpleSFTP 4049e0a 均普通 fast-forward 推送，fetch 后 HEAD=origin/master；自动安装 0.5.229 / 0.2.57 各一次，无 force/降级。code 列表与 simpleex / simple-sftp-api 入口核对成功；安装后 194 / 18 个运行文件身份核对通过（package.json 排除 VS Code 注入 __metadata 后语义一致）。安装后停止 API/Panel 操作，两个原有 dirty pyc 未暂存。现场验收限制见下文。

现场边界：当前运行的 0.5.228 / 0.2.56 不支持新内存协议，本轮没有重发旧入口、停止现有传输或删除历史产物。新按钮与真实 MultiModal 的最终指标/耗时须在用户重载窗口后验收；远端禁用自动重建需准备/更新 Agent 才生效。本次测试证明代码行为，不代表现场同步已成功或速度百分比改善。用户确认取消远端重建，并未提供完整的精确清理路径；旧远端汇总和已有本机 raw 文件不自动删除，但不参与最新 run 的结果选择。

## 2026-10-06 结果重建子进程误判无进展

- [x] 读取约束、Git 状态和 discovery/capabilities；保留两个 dirty pyc。磁盘已安装 0.5.227 / 0.2.56，采样时 Host 仍运行 0.5.226 / 0.2.55；区分原请求与新补丁，不重发、取消或清理。
- [x] 真实错误文字只来自 Agent subprocess_inactivity_run；file_step=True 的生产入口为 rebuild-distributed-results。现有 MultiModal 正式重建会再次读取每个 best_model.pth，_sha 没有 SIMPLE_PROGRESS；Agent 当前只认可协议行，静默但持续读权重也会在 120 秒后被杀。SFTP 原请求已 settled，不能把该错误说成其网络传输超时。
- [x] 在生产 helper 的提取函数 seam + 子进程/时钟替身中复现：持续静默读取的旧监视器在逻辑 124 秒抛出相同错误。修复后逻辑时间超过 120 秒仍成功；真正无变化、重复协议行、stdin 输入、控制请求和开始/途中取消均保持原有约束。测试没有跑真实 120 秒大权重任务。
- [x] file_step 每秒最多读取一次直属子进程 /proc/<pid>/io（最多 4096 字节），使用包含 pagecache 的 rchar 与文件 write_bytes，扣除 stdin manifest，排除 stdout/wchar、CPU 与进程存在。采样不可用则不伪造进展；无工作/取消仍停止，30/120 秒阈值不变。Linux 计数语义已核对 [内核文档](https://www.kernel.org/doc/html/latest/filesystems/proc.html#proc-pid-io-display-the-io-accounting-fields)。I/O 表示实际活动，不证明结果已完成或可发布；既有 SHA256、终态与正式结果门禁保留。
- [x] 超时诊断保存子进程步骤、最后阶段、I/O 是否可观测及脱敏 stderr 尾部；stderr ring 32 KiB、诊断尾部 2000 字符、stdout 4 MiB（超限拒绝截断结果）、单次读取 64 KiB、协议 phase 最多 32 个 + 一个 I/O phase。UTF-8 明确指定，持续排空输出，不新增日志文件。
- [x] 串行 110 个 Node 场景通过，包含新增 helper 的 9 个场景、异步取消、Worker 并发入口、进展等待、手动产物同步、指标结果完整性、Panel 渲染/背压与 Webview 解析；build / vm.Script / UTF-8 / diff 门禁通过。
- [x] 补丁 0.5.228 完成打包/内容验证；代码 c0140309 普通 fast-forward push，fetch 后 HEAD=origin/master。install:latest 仅执行一次，无 force/降级；code 列表确认 0.5.228 / 0.2.56，simpleex / simple-sftp-api 入口有效，安装后的 194 个闭包/sidecar 文件身份核对通过（package.json 排除 VS Code 注入 __metadata 后语义一致）。SimpleSFTP 未修改或重复安装；安装后停止 API/Panel 操作。两个 dirty pyc 保留未暂存。

打包记录：首次 package 的 vsce ls 超过既有 8 秒上限；单独检查及随后完整 package 成功，未延长上限或绕过门禁。VSIX 内 188 个闭包文件及 6 个 Agent/runtime sidecar 与工作区逐字节 SHA256 一致，无 pyc；buildId=d1f1e2053b11，VSIX SHA256=332c3875ba453ce0b254c34b0ccf48e870aa88e522ec3b0ee2cc9c9e33354ec2。

现场限制：初次只读 transfers.list 显示原 2106/3816 请求 settledAt=2026-10-06T05:40:12.604Z，随后共享结果请求于 05:40:15.521Z settled；settled 仅证明资源退出，不能单独当作内容成功。最新 actionError 为同步入口转发的 Agent 子进程错误。随后 fresh discovery/capabilities 两次监听拒绝连接，未取得完整远端子进程日志、具体停在哪个权重、最终 raw/方法表或新版远端 Agent 状态；没有重发或清理。需重载并“准备 Agent 并启动”使远端加载新版后再复测；仅安装本地 VSIX 不等于远端进程已升级。

## 2026-10-06 校验缓存持久化与差异透明度

- [x] 读取约束、源码与 Git 状态，保留两个 dirty pyc；实际运行 SimpleExperiment 0.5.226 / SimpleSFTP 0.2.55。没有取消、重发或清理正在传输的产物。
- [x] 通过实时 discovery/capabilities 调用只读 projectInventory：nwpu5 的 experiments/simple_project.yaml 570 ms，hashedFiles=0 / reusedFiles=1。仅证明该文件缓存有效，不代表所有权重缓存命中。
- [x] 核实目录范围计数只在整批 RPC 返回时增长；缓存更新也仅在整批结束提交，途中退出会丢失本批已算出的 SHA256。ThreadPool map 的顺序等待还会延迟已完成小文件的统计与缓存写入。截图 3816 个候选、2106 个差异，不能称全部重传；1710 个相同文件应跳过，缺失/内容变化仍需分开统计。
- [x] 用真实 Python helper 复现中断丢缓存；最多 16 个待处理 future / 8 个工作线程，按完成顺序收集；每 32 条或累计 64 MiB 或间隔 1 秒（文件完成时检查）提交，正常结束提交尾批。中断后 inventory / exact batch 均复用已提交 SHA256；慢首文件不阻塞其他已完成文件写缓存。保留五字段身份、稳定读取与 SHA256；暴露缓存可用性、命中与重算数，缓存写入失败仍完整校验。
- [x] 目录校验显示明确任务目录数、实际已校验文件与校验读取字节；差异清单显示相同跳过、目标缺失、内容不同，沿用旧协议 fallback，不增加远端扫描。性能/缓存计数不能成为 wire bytes 或 keepalive；跨 scope 不沿用旧命中数。
- [x] 串行目标与传输回归：SimpleSFTP 79 个、SimpleExperiment 103 个 Node 场景全部通过（含 build Webview 解析 1 个）；两项目 build、Webview vm.Script、编码/diff 门禁通过。打包后 188 / 18 个 runtime 文件逐字节 SHA256 核对成功，无 pyc。
- [x] scoped commit/push/fetch：SimpleExperiment 5732af2a / SimpleSFTP 178c4f2 均普通 fast-forward 推送，fetch 后 HEAD=origin/master；自动安装 SimpleExperiment 0.5.227 / SimpleSFTP 0.2.56 各一次，无 force/降级。CLI 版本和两个命令入口、安装后 runtime 字节身份均核对通过（package.json 排除 VS Code 注入的 __metadata 后语义一致）。安装后没有调用 API 或操作 Panel；两个原有 dirty pyc 未暂存。

SimpleExperiment VSIX SHA256：827980857aa9bc4a02c98a6389527dd5afc3ad45df5eaaf1d3e81d0eb86c1796，buildId=0bfce220cbbd。SimpleSFTP VSIX SHA256：0fe5fc145ba9344248e03b5d31dcd91cf84b08ac0bfadfd69a859c9ea62415d4。

安装前最后一次只读现场：同一请求仍 running/unpacking，3816 候选、2106 差异、已完成 231/2106 文件、21/132 分组，实际流字节 20177671732。没有取消/重发/删除。旧版没有记录 missing/different 分项，不能宣称这 2106 个全是缺失或证明某文件被重复复制。旧失败请求为 3296/4578 差异；两个请求候选不一致，也不能直接比较得到速度提升。新缓存行为已在本机真实 Python helper 验证，服务器大权重的下一轮耗时/命中率未实测；当前同步结束前不要 Reload Window。

## 2026-10-06 分块续传槽位与错误摘要

- [x] 读取约束、Git 状态、实时 discovery/capabilities；运行仍为 SimpleExperiment 0.5.225 / SimpleSFTP 0.2.53，源码为 0.5.226 / 0.2.54。当前 transfers.list 没有活动请求；保留两个 dirty pyc 与所有已完成产物。
- [x] 读取真实 actionErrors：接收端 chunk_state 抛出 `stale or invalid chunk offset`，随后源端 BrokenPipeError。弹窗被 SIMPLE_PROGRESS / SIMPLE_CHUNK_VERIFIED / SIMPLE_COMPRESSION_WIRE 淹没，根因不是指标 CSV 或 Panel 状态延迟。
- [x] 用真实接收器复现：较早槽位释放后同身份续传会丢失原偏移；两个新增场景修复前均失败。已有身份优先恢复，连续大文件流固定槽与 flock 到整文件校验/发布，不逐块重新 claim。
- [x] 保留逐块及整文件 SHA256、offset、所有权与退出核查；失败不删旧产物。接收器 5/5 覆盖空槽竞争、相同身份活跃拒绝、连续多帧、截断/校验失败后只续传有效前缀。
- [x] direct/relay 的错误 ring 只保存有界非性能日志，保留退出码、实际异常与大文件路径/两端身份；进度仍走原有通道。实际进度洪流 fixture 仍能保留起始 tar 异常，包含 UTF-8 分段与无换行超长文本；packedSyncProgress 8/8。
- [x] 串行接收器、压缩/续传、进度、批量同步与退出保护回归：SimpleSFTP 89 个 Node 场景通过（退出探针另有 35 个 Python 场景），SimpleExperiment 客户端/手动同步 33 个 Node 场景通过。旧 guard、两条并行流及 SHA256 差异传输均保留。
- [x] 两项目 build 与 Webview vm.Script 通过；含 build 的 Webview 脚本回归，本轮共 123 个 Node 场景通过。补丁 SimpleSFTP 0.2.55 不变更 SimpleExperiment 0.5.226 的协议或版本。
- [x] 补丁打包及 VSIX 18 个 runtime 文件逐字节 SHA256 核对通过。SimpleSFTP 修复提交 bb19001 已普通 fast-forward 推送并 fetch 核对 HEAD=origin/master；安装 0.2.55 一次，没有 force/降级，CLI 核对安装为 SimpleExperiment 0.5.226 / SimpleSFTP 0.2.55 与两个命令入口。安装后没有继续调用 API 或操作面板。

SimpleSFTP 0.2.55 VSIX SHA256：8e747b09373ab0b8c895dd29577dcb3c193558370fa42f4c113130b585f574fc。

现场限制：在传输已无活动请求后尝试通过 API stat 查询最新 ebmc 的两个权重；该次 discovery 端口拒绝连接，未得到目标目录数据，之后 SimpleSFTP discovery 监听仍不可达。不能宣称已现场核对两个目标的权重完整性，也没有重发/取消或删除任何服务器文件。待用户 Reload Window 后再次同步，差异比较跳过相同 SHA256 文件，失败权重仅在退出核查通过后从有效检查点继续；实际大传输尚未复测。

目标：修复旧传输核查的 `/proc/exe` 权限误判、长传输 RPC 提前失败后后台仍运行，以及同一传输显示两层通知。保护正在运行的任务、历史产物、回执与原有两个 dirty .pyc。

- [x] 读取项目约束、Git 状态、两插件 discovery/capabilities。开始时运行/安装 SimpleExperiment 0.5.224、SimpleSFTP 0.2.52。
- [x] 只读现场：一个活动 serverToServerFpsync 请求；上层 action error 已记录 fetch failed，而该请求仍产生实际流字节。432 是校验候选路径，不是已传文件数；当前差异清单 totalBytes=34169609411（约 31.8 GiB）。队列区分 fragmentWorkerIds 与 mirroredWorkerIds，结果片段同步不等于完整检查点同步。
- [x] 定位生产入口：全局 fetch 的默认响应头等待存在 300 秒截止；RPC 仅在业务结束时发送响应头，修改操作断开 HTTP 不会自动停止。旧回执探针对常驻 SFTP 的 exe/FD 检查还会遇到 Linux ptrace 权限限制。不能把权限不足说成产物文件被占用。
- [x] 为长 RPC 使用无固定响应头/总时长的本机 HTTP 请求；仍由真实进展、AbortSignal 与有界 JSON 控制等待。请求中断只取消该 operation，最多 20 秒核对持久回执；未知退出仍保留 guard，禁止重放。真实 loopback 回归模拟 360 秒业务时间、RPC 断线后等待子任务退出、abort 和 32 MiB 响应上限，4/4 通过；模拟时钟不冒充现场长传输测量。
- [x] 退出核查仅在明确的 staged-tar 协议中区分受保护的独立系统 SFTP 会话，记录最多 32 条未观测摘要；仅对 PermissionError + 睡眠稳定进程 + 绝对路径的 root-owned、不可被普通用户改写的系统 sftp-server 启用。真实协议 writer、可观测目标可写 FD、未知执行文件、PID/命令变化、忙槽及不完整协议证据仍阻止。绝不宣称未观测的外部会话没有写文件；这不是第三方写入互斥证明。生产探针 35 个 Python 场景通过。
- [x] API 调用不创建重复 SimpleSFTP 通知；事件、取消与进度仍保留。清单显示校验数与实际差异数；流式管道统一显示“流处理（打包、传输与解包）”，底层阶段与 scope 继续作为真实进展依据，未改批次 128 MiB / 大文件 8 MiB 校验分块，也没有按块重新建连接。6 候选/2 差异的实际 core fixture 只派发 2 个文件。
- [x] 修正只读 sync.project* 的断线取消归类与容量等待取消。回归证明断线的排队读者释放自己的 ticket，不影响仍活跃的传输。
- [x] 用户补充权重要求：完整同步保持最新版运行选择，不扫描整个 work_dirs。手动 bulk 统一按选定 attempt 目录递归补扫，复用 Worker 批量预检；旧清单即使完整也不漏后添 last_checkpoint.pth、嵌套 safetensors 等文件。已有 SHA256 身份校验不变；旧 attempt、无归属目录及 lock/pid/exit_code 临时状态不进入传输。新增回归先复现漏项，修正后 manualDistributedResultSync 21/21、distributedJobArtifacts 3/3、pendingResultMetricSync 31/31、planOutputRetention 15/15 通过；第二次未变化同步不重新派发。服务器间包含权重，本机指标下载沿用项目不默认下载大权重的契约。
- [x] 串行目标回归：SimpleExperiment 152 个 Node 场景（含新增目录补扫与 build 的 Webview 解析门禁）、SimpleSFTP 80 个 Node 场景均通过；退出探针另有 35 个 Python 场景通过。两插件 build、Webview vm.Script、diff 与 UTF-8 检查通过。首次 SimpleExperiment package 的 vsce ls 在现有 8 秒界限超时；单独核验通过后重新 package 成功，没有延长界限或跳过门禁。
- [x] 补丁版本、VSIX 内容身份验证、scoped commit/push/fetch；按既有授权自动安装一次，安装后停止 API。代码提交 SimpleExperiment e9733c35、SimpleSFTP d46189c 已普通 fast-forward 推送，fetch 后分别确认 HEAD=origin/master；两个原有 dirty pyc 未暂存。当前传输如仍活跃，不提前重载或中断；现场重新同步留待窗口重载后验收。

已完成安装：SimpleExperiment 0.5.225、SimpleSFTP 0.2.53，各执行 install:latest 一次，无 force/降级。code 列表、安装目录的新增运行文件与 simpleex 入口均已核对；安装后没有再调用 API。SimpleExperiment 包内 188 个 runtime 文件与工作区一致，buildId=b7c14a8e66cb；SimpleSFTP 包内 18 个 runtime 文件一致，均不含 pyc。VSIX SHA256 分别为 d26f1b48f4f29ec9d553f9b2a83ccb01f54645942921c9091244b7406ec98d46、ccbc0e7475d52ee06c685ac0fb333b7d3d4f0a2a2cfc05974b4ba0ca5e1e3c3c。

限制：两次只读文件 stat 由于当前传输容量等待超过调用方 25 秒而未取得结果；随后 API discovery 指向的本机端口拒绝连接，无法继续查询现场传输。不能宣称已核实目标检查点缺失、当前任务已退出或所有 Worker 完全同步。未知旧回执仍需真实退出证明；不删除文件、回执或租约，不杀未知远端进程。

依据：[Undici Dispatcher 默认响应头超时](https://undici.nodejs.org/api/Dispatcher)、[Linux proc_pid_exe 权限](https://man7.org/linux/man-pages/man5/proc_pid_exe.5.html)、[OpenSSH 平台进程保护](https://github.com/openssh/openssh-portable/blob/master/platform.c)。默认超时机制已经源码核实；本次旧日志没有保留 cause.code，不能冒充现场取得 UND_ERR_HEADERS_TIMEOUT。

## 2026-10-06 较大归档批次与完成计数

- [x] 读取约束和 Git 状态；保留原有两个 dirty pyc。现场 discovery/capabilities 确认运行 SimpleExperiment 0.5.225、SimpleSFTP 0.2.53；只读 transfers.list：running/unpacking，processedFiles=0、changedFiles=3296/4578、transferredBytes=9670022677、差异文件未压缩总字节=186931445249。没有取消或重发正在运行的同步。
- [x] 回归复现分组完成后仍显示 0：现有 group done 仅更新内部通知，未进入 API completion counter；不同 child/phase 的 processedFiles 还是各阶段局部值。生产 core、controller、SSE 转发及外层通知的四个 seam 均先失败再修正；不是靠隐藏真实完成数过关。
- [x] 默认归档批次改为 512 MiB，维持流式内存、有界 manifest、最多两路和大文件 8 MiB 恢复校验协议；不把 checksum 分块当作独立打包/连接。真实分组函数 fixture 的 6 个 100 MiB 文件从 6 组变为 2 组（5+1），没有分配这些文件内容；这不是现场速度实测。
- [x] 新增整次传输 committed completedFiles/totalFiles、completedGroups/totalGroups；独立于局部 stage counter，经 SSE/poll 转发到统一通知。大文件未完成时不伪造完成文件数，旧版本缺少计数时不显示误导的“已处理 0”。
- [x] 串行回归：SimpleExperiment 93 个 Node 场景、SimpleSFTP 81 个 Node 场景全部通过（同一文件多次执行不重复计数）；包括新计数、512 MiB 分组、乱序并发组累计、真实字节、压缩、取消/恢复、暂存发布、API 与 Panel 背压/健康检查。两插件 build、Webview vm.Script、UTF-8 和 diff 门禁通过。
- [x] 打包 SimpleExperiment 0.5.226 / SimpleSFTP 0.2.54；包内 188/18 个运行文件与工作区逐字节一致，无 pyc。buildId=c906e92b79b9，VSIX SHA256 分别为 adf81de5d148fcc2f9a0cc819b738661dc90eb963202cd649c7f7329d750f8be、4ac69e054de415fa9724a3de7045bcf6e433d8e2b8edbb63b95d88bb8f076814。
- [x] scoped commit/push/fetch：SimpleExperiment 87d524fc、SimpleSFTP e31c6c4 均普通 fast-forward 推送，fetch 后 HEAD=origin/master。各执行一次 install:latest，确认安装 0.5.226 / 0.2.54，核对运行文件与 simpleex 入口；安装后未再调用 API。两个 dirty pyc 保留未暂存。新批次与新计数只在重载后的新请求生效，不能热改正在执行的旧请求；不要为展示新计数重载一个仍有活动传输的窗口。

安装前末次只读采样：同一活动请求仍 running，transferredBytes 从 9670022677 增至 21471241567，旧版 processedFiles 仍为 0。该采样证明实际流字节在增长，不证明已全部完成，也不代表新版现场提速测试。
