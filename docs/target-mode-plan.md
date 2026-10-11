# 目标模式当前计划：mac 适配，更新发布优先
字符上限 12000，达到 10800 自动压缩。历史证据保留在 Git 和 release-artifacts。

## 固定边界
- 原目标为两款独立公开 darwin-arm64 preview 扩展、本机构建发布与完整Mac科研业务；Windows项目独立，普通同步origin/master。
- Apple Silicon/macOS26+；M5/24GB/macOS27.0验收待用户。排除Intel/Dev Containers/PPT/Actions/shop/自动清理与开发机安装。
- 用户授权静态preview.json替代用户端REST查询；附件同一Release、不可覆盖、绑定同步提交，平台/版本/大小/SHA核验。
- 保护三拓扑、业务API/Plan、现有入口、远端实验及删除物理直接父目录/两次完整路径确认。
- 每批至多3个相关问题/8源文档测试文件；目标逐文件串行20秒，Python隔离10秒；build/闭包/面板vm门禁。
- 用户要求先完成不需要真机的剩余工作，完成交付后暂停目标模式；完整目标未完成，不能标complete。
- 先完成后完善，缺真机延期；README/配置说明按里程碑集中更新，不每批重复修改。
- 固定分母29；报告已取得M5环境、最小启动及匿名检查证据后核实原条目，缺证据整条保留剩余。完整目标维持paused；本次仅执行用户新授权的缺陷修复与发布。

## 当前授权：Windows分叉后功能同步
- 2026-10-12用户追加：检查Windows从8934ed8b分叉之后的提交，将对应功能页和方法适配到Mac。参考冻结Exp42902a5a、SFacae730，Windows未提交pyc仅只读；Mac身份/路径/Termius/静态更新/传输退出证明/GPU内部标签保留。
- 范围：持久面板恢复、GPU快照与本机派发归属、失败召回/明确不可用、结果进度与正式路径/内存汇总、PLAN清理审核及配套受限接口、启动前拒绝回执。8b4aed70用户隔离和GPU窗口已同步，核对保留；不复制Windows发布/安装/入口默认值。
- 分批：061队列与GPU/召回基础；062实时快照；063清理协调基础；064配套清理接口；065清理宿主/API；066正式runtime；067结果契约；068面板集成；069完整回归/发布。每批至多8文件，必要时细分；不执行真实传输/清理/Agent更新或任务操作。原目标18已验证11剩余，整体paused，仅执行本次授权。

## 当前批次 mac-sync-067a（passed，版本注入构建门禁修正）
- 067七个源/测试文件保持未提交，未计通过。正式测试揭示Mac旧构建注入会改写新协议re.search字符串；Windows42902a5a构建脚本已有整行常量门禁。067a只改构建脚本、实际纯函数回归和本计划3文件，build/面板vm/版本注入测试后独立同步；不改运行中的远端runtime。
- build/面板2/vm、实际版本注入1通过，完整常量更新/正则字符串与注释不改/重复注入幂等。067宿主确认测试留至068整合后补回，不以依赖未接入的测试调整生产逻辑；原目标18/11。

## 待完成批次 mac-sync-067（正式队列/结果与不可用判定接口）
- 066提交ac9e0e2已同步。8文件边界：PlanRunFreshness/PlanArtifactSyncStatus/ExperimentRunner/ProjectAdapterTemplates/JobAvailability、正式执行测试及Python夹具、本计划。保留Mac严格路径/空选择拒绝，采用正式身份/结果内存读取和显式不可用判定。正式执行测试使用AST隔离函数及mock工作进程，10秒上限；不运行科研。

## 已完成批次 mac-sync-066
- 065提交a679708已同步。8文件边界：Agent/Scheduler/WrapperResultBundle/FourStateMetricBundle、正式结果契约测试及Python夹具、GPU身份测试、本计划。正式declared路径、训练/测试/预检拒绝及无attempt新执行同步；Agent冲突保留Mac严格POSIX函数并采用历史attempt只读规则。第一次正式结果测试发现collector仍缺新CSV契约，纳入同批依赖后复验。保留Mac物理GPU容器/内部Pane规则；只AST提取函数，Python10秒，不部署runtime。
- build/面板2/vm、结果契约3/GPU环境身份1/MacGPU内部标签5通过，diff通过。实际科研项目仅纯路径接口只读核对，未执行训练或文件传输；原目标18/11。

## 已完成批次 mac-sync-065
- 064 SF11d6f7e、Exp记录c9d9823已同步。7文件边界：PlanCleanupHost/PlanCleanupPanel/LocalApiServer、完整清理26/重连9/消息桥9测试、本计划。补回063宿主/UI/API用例，审核页先注册桥、真实阶段进度、过期响应拒绝、独立双确认和重连只读观察，不执行服务器操作。
- build/面板2/vm、完整清理26/重连9/审核桥12通过，原Windows文档旧9计数以实际12为准。三方合并保留Mac API身份；界面接入待068，原目标18/11。

## 已完成批次 mac-sync-064
- 063提交2961599已同步。8文件边界：SF extension/api-server/cleanup-file-api/cleanup-files/package/verify-runtime/cleanup测试，加本计划。三方合并保留Mac认证/租约/持久恢复；新增包依赖闭包，VSCE纯元数据枚举上限30秒，Python及测试上限不变。Mac缺可靠句柄证明返回HANDLE_CHECK_UNAVAILABLE，不放行清理。
- SF build/28闭包及清理18通过；初次VM未注入Mac路径依赖失败，修正为真实workspace-path消费者后通过，未修改生产路径规则。永久删除全模拟，实际移动仅测试新建夹具；未触碰真实目标，原目标18/11。

## 已完成批次 mac-sync-063
- 062提交913a794已同步。8文件边界：PlanCleanup/PlanCleanupEvidence/PlanArtifactSync/PlanOutputRetention/SimpleSftpProgressWait、清理与重连两测试、本计划。只移植审核/回执/所有权和隔离规则；精确目标、祖先Git、根/父目录/类型/双确认保护保留。Mac文件句柄无法证明时必须阻断，不声称Mac真实清理通过。
- build/面板2/vm、协调22及重连6通过。初次全文件包含尚未引入的宿主/UI/API依赖而失败，现拆为基础范围；原完整用例保留参考快照，065补回4+3例并完整验证。非清理真实目标，仅临时夹具与模拟执行端；原目标仍18/11。

## 已完成批次 mac-sync-062
- 061提交11ae916已普通同步。062边界：RealtimeTunnelClient/MultiEndpointRealtimeClient/OperationPayload、GPU快照恢复测试、本计划。保留Mac动态端点与身份，验证build/面板vm/实时快照后同步；原目标18已验证11剩余。
- build/面板2/vm、GPU快照恢复8通过，diff通过；所有HTTP/WS均测试替身，零服务器通信。

## 已完成批次 mac-sync-061
- 8文件边界：DistributedPlanQueue/DistributedSchedulingPolicy/GpuJobOwnership/FailedJobRecovery/PanelPlanStatusSummary、两个对应纯接口测试、本计划。三方内容合并只写当前批次，验证build/面板vm和逐文件目标后普通同步。
- build/面板2/vm、GPU纯接口6及召回3通过。Windows旧召回6例未跟随正式任务退休而失败，已改为验证正式重试委托/历史只读/上下文拒绝；GPU最后1项依赖未同步宿主UI，留至068补回并执行。原目标18已验证11剩余，不以基础模块通过冒充页面集成。

## 已完成批次 mac-native-060
- 059源码4ee7c34d2e1bb0154800aa01624ea37da9765394、SF源码2f5cec01a2953a0841a1fc11c8280df07648d28e均普通同步master；.312/.99完整prepare98目标/99含面板标记、227/26闭包与vm通过，实际包129场景、1553/84源码快照通过。
- Release409772036于2026-10-11T16:07:03Z公开，三附件完整核验；静态索引d3fc69e4ed05ab2eeb4ee6e5e547f2d1153af45a已普通推送/fetch。真实包客户端匿名4请求均200、REST0、缓存/同版/高版跳过及两包CRC/身份/平台/大小/SHA通过，无本机安装。
- 5文档边界：README、事实、验收证据、固定29目标计数、本计划。集中说明旧版更新锁需手动安装一次配套VSIX；不删除真实锁、不连接服务器、不触碰现有任务/Agent。macSetupGuide1/1、UTF8/29条计数18已验证11剩余/字符上限/diff门禁通过，收尾提交普通同步；完整目标保持paused，后续仅按用户反馈修复。

## 已完成批次 mac-native-059
- .311/.99 prepare98目标/99标记、实际包126及1553/84快照通过但未发布；产物不可覆盖，全部保留。本地追加“没有旧恢复槽时”复现活跃/EPERM/标准身份更新持有者3失败：过期本身不能证明退出，不能抢占混合版本更新门禁。
- 7文件边界：旧租约源码/实际消费者、Exp package/lock/runtime、prepare说明、本计划。Mac更新租约无论TTL均须ESRCH退出证明，非更新旧入口保留；补例总10。版本递增.312，SF继续已同步.99，真实完整prepare与实际包129场景重做后发布。
- 18已验证/11剩余，完整目标paused；仅虚拟进程磁盘，未动真实锁、远端任务或Agent。验证后普通同步，保留失败回执，不覆盖.311。
- .312 build、旧更新租约10/10、更新门禁1/1、共享租约14/14、runtimeManifest1/macRelease4、227模块闭包、面板vm及diff检查通过；正式prepare、实际包及发布证据见060。

## 本批记录
- 历史公开.310/.98：Exp5c93ff7271071dbe68c5e412435ba67a78061db7/SF60fe32015a07e29f1235d17da815af936707fa79；索引5a0b05b43f8c349c11127e4cadff91aeb80bdd3d。新报告仍装.309/.97，原目标当前18已验证/11剩余。
- 历史公开.309/.97：Exp880b653a8a08024b81446b45b327d2153fe707ff/SF2f464eb75e362150de5cbe61e1946504c3497a0a；回执/实际包/快照/匿名请求证据保留release-artifacts/preview-v0.5.309，历史14已验证/15剩余。
- 历史公开.308/.97：Expab8bda82da5c5fbc3c950c9413ed37e279628d57/SF2f464eb75e362150de5cbe61e1946504c3497a0a；prepare82目标/83标记、实际包26场景及1542/83源码快照通过。
- .308 Release408701623，2026-10-10T05:52:35Z，三附件完整核验；索引41e1aa347fa79d95cac7d5e280d7be9549864460普通推送。实际匿名4请求200、REST0、包/SHA与缓存/版本跳过通过，M5pending。
- .308前门禁漏拦与runtimeManifest误路径均以新提交补正；失败证据和.264以来完整历史保留Git与产物。无自动安装/Actions/真实科研或删除。
