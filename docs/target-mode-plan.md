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

## 后续边界
- 所列不依赖真机的本地修复、协作核查和发布已交付；用户暂停授权的前提已满足，收尾提交同步后将目标设为paused，未经用户恢复不继续批次。
- M5启动/更新重载/补装/Termius/认证传输/中文路径断连/三拓扑仍待验收；收到反馈后再考虑完善，模拟不替代真机。

## 当前批次 mac-release-053（passed，本地测试读取修正；发布pending）
- 起始Exp34f712d/SF60fe320同步；prepare重试到resultCsvDirectoryConfig出现1项220字符跨度断言，CRLF增加字符但监听逻辑未改变。4文件：sourceReader、新增LF/CRLF消费者测试、prepare门禁、本计划。仅统一测试文本为LF，生产不变；旧失败日志保留，.310产物目录仍未创建。
- 新增读取器2、结果目录6/缓存6逐文件20秒、build/面板2、227闭包/vm/UTF8/diff通过。普通同步后重跑完整prepare，结果以保留日志为准。目标仍paused，剩余12/29；发布pending。

## 前批 mac-release-052（passed，本地门禁修正；发布pending）
- 起始Exp43f7a72312af51863544a2240bfb4112517bb741/SF60fe32015a07e29f1235d17da815af936707fa79同步干净；完整目标paused，原目标剩余12/29。
- prepare首次在resultsSummaryWebviewCache普通断言失败2项，读取CRLF源码却仅用LF定位声明；生产声明未改变。2文件边界仅测试换行规范化与本计划，不改生产行为。保留失败日志；尚未创建.310产物目录或发布。
- 单文件6、build/面板2、227闭包/vm/UTF8/diff通过；提交普通同步后重跑完整prepare与实际包验证。生产源码不因测试改变，失败日志保留。

## 前批 mac-release-051（metadata passed，发布pending）
- 起始Expc48747160215cb0c9866abf4dcf39394595e875c/SF10670081f62c3dd1f544900e2d5c47e75b3dfe1d同步；完整目标保持paused，只完成本次新授权请求。
- 8文件：两仓package/lock、Exp runtime版本/prepare/common/计划；递增.310/.98，prepare纳入用户前缀/UI/关闭/隔离GPU调度/停止/单文件上传恢复目标，发布说明区分.309/.97部分真机与新版待复验，强调远端Agent必须用户空闲时主动更新。发布源仅fetch已核定origin/master。
- metadata两仓build、227/26闭包、面板2/vm、runtimeManifest1/发布脚本4、UTF8/版本/差异通过；runtimeManifest首次命令路径误写features，按rg所得实际test/runtimeManifest.test.js通过。SF元数据60fe32015a07e29f1235d17da815af936707fa79已普通同步。Exp提交后源同步再prepare真实darwin-arm64两VSIX及清单，实际包消费者、源码快照与匿名索引/附件验证，再发布索引；发布尚未完成。无开发机安装、Actions或服务器通信，原方案剩余12/29。

## 前批 mac-native-050（passed，部分真机证据归档）
- .309/.97用户报告按证据归档至mac-native-acceptance-2026-10-11.md，不发布个人目录/服务器地址/用户名，不假称读取原始Mac截图回执。4文档：报告摘要、事实、固定目标状态及计划。
- 原02环境、06无服务器启动及四入口、15失败/恢复检查取得完整条目所需补证；17已验证/12剩余。认证、Termius attach、真实在线安装/补装、三拓扑及独立Agent版本按钮最终回执仍待验；旧历史15/29仅历史记录。
- mac-native-049 SFTP8源测试文件已验证提交10670081f62c3dd1f544900e2d5c47e75b3dfe1d，TLS多次失败后普通fetch master/push/fetch确认HEAD=origin/master；未修改origin或关闭TLS校验。取消回调/双端只读认证前置、旧upload.files退出证明与已确认新请求安全恢复；新原生消费者5/auth9/relay9/旧退出7/recovery25/settlement3/API进度4、build26闭包及diff通过。仅本地替身，现有远端任务保持不动。
- 前批UI ec4f7a41ea25aefce54b7747a797d09fa87a365d，调度32a5ee0e3a96d65c1c31fd98fc728ca6289ee64a均普通同步。下一批只更新.310/.98元数据、prepare新增门禁/发布说明并交付。完整目标维持paused。

## 前批 mac-native-048（passed，本地调度GPU标签页）
- 起始ec4f7a41ea25aefce54b7747a797d09fa87a365d=origin/master；重读实际调度launch、存活、停止、tmux元数据与目标测试，保护原远端任务/旧入口。
- 5文件：Agent runtime模板、隔离编译消费者JS/Python、既有停止消费者测试及计划；新run-plan按本机真实GPU编号共享容器新建标签，Hub无GPU使用共享control容器；绑定稳定pane与PID启动身份，不杀整个GPU容器。旧sch记录仍可显式精确停止，不迁移或自动关闭。GPU任务创建失败不再新建独立任务会话。
- build/面板2、隔离Python5（10秒）、Planlaunch8/身份5/队列29/停止路由5/PlanStopClear33逐文件20秒通过。PlanStopClear先发现两个既有Mac夹具缺实际require/执行模式，补齐实际模块与显式train输入后通过，未为夹具改变生产行为。闭包第一次vsce ls在8秒超时，独立检查后同一门禁通过227模块；vm/UTF8/diff通过。没有执行真实远端任务或GPU命令。
- 完成后普通同步，真实提交记录以Git为准；下一批SFTP认证取消/旧upload.files退出证明，最后统一归档用户部分真机证据、版本元数据及prepare门禁后发布。完整目标继续paused。

## 前批 mac-native-047（passed，本地UI修复）
- 2026-10-11用户授权参考Win11最新8b4aed70d048c96f4a5062f3ec699a3a8449768a，同步Mac用户识别/GPU标签页并处理真机报告后发布。起始Exp f81d10ee99053ef3f9a0dc6ac0d857d4f3253d44/SF2f464eb75e362150de5cbe61e1946504c3497a0a；两仓master，保护Windows源码、所有现有远端任务与Agent，不执行服务器通信或安装。
- 8文件边界：两处宿主/UI、新GPU关闭模块、四目标测试与本计划。先复现UI7失败，再移植配置前缀与统一折叠，缺前缀不归属任何用户GPU。GPU关闭仅显式用户确认稳定窗口身份；本批不调用该入口。旧两测试缺配置叶子先失败，移植donor叶子后通过。
- build/面板2、UI13、GPU关闭8、清标签5、单标签关闭1逐文件串行20秒通过；vm.Script/UTF8/diff通过。提交前diff仅本批8文件，无远端通信；真实GPU/用户隔离复验等待新版。提交以Git记录为准。
- 真机报告作为用户证据：M5/24GB/macOS27/VSCode1.141、.309/.97，A1–A4/A7通过，Termius端点/密码与中文%20下载/SecretStorage取得部分证据。A5在线安装及D/E科研未验；私钥未知口令、独立SSH也拒绝agent、第二端凭据未证实不能标插件已修复。
- 下一批边界：实际run-plan调度路径仍创建sch会话，必须改为固定GPU内精确标签页并保护旧记录；SFTP认证取消255误判和upload.files缺退出证明单独批次。原P1未知记录不凭无子进程直接清除。

## 前批 mac-release-046（passed，本地交付完成，用户要求暂停）
- 起始Exp200c57f28d3a0450ac4df170c2064e712fa05608/SF2f464eb75e362150de5cbe61e1946504c3497a0a同步干净；重读事实/计划/Git/版本与发布门禁。
- 元数据4文件：Exp package/lock/runtime/计划，SF保留.97；metadata build面板2/runtimeManifest1/226闭包/vm/UTF8/diff通过，880b653a8a08024b81446b45b327d2153fe707ff普通同步后打包。收尾仅更新计划/状态两文档并核验UTF8/计数/diff/普通同步。
- prepare86目标文件通过，87含面板标记；实际VSIX消费者35场景通过（Exp28/SF7），包含虚拟Mac缓存和双插件POSIX租约；源码快照1545/83文件逐字节/大小/SHA一致。没有用替身证明真实macOS行为。
- Release408721560，2026-10-10T06:20:03Z，完整三附件验证后发布；manifest SHA fbc1df56932fc0ba0843f3cc4a441223e1a6a8a6e815f7c641869a29ef82df18。静态索引76e2b03b4b39d2a526b581e5d57e6c6cfd37a8a3普通同步、fetch HEAD=origin/master；保留历史版本，不覆盖附件。
- 实际包匿名客户端4请求全部200、REST0；索引/清单/两VSIX与本地产物一致，CRC/身份/版本/平台/大小/SHA、缓存复用、同版/高版和未变化SFTP跳过通过。公开地址https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.309；无安装/Actions/真实科研/服务器通信/删除。
- 本地工作修复36f880f7284bc82220e0b9aa9f929e1922493b2e、压缩与协作200c57f28d3a0450ac4df170c2064e712fa05608均普通推送；源码核查明确局限，M5待验15/29。交付完成后按用户授权暂停目标模式。

## 前批 mac-005au-local-completion（passed，本地）
- 起始Exp36f880f7284bc82220e0b9aa9f929e1922493b2e/SF2f464eb75e362150de5cbe61e1946504c3497a0a同步干净；重读事实/计划/Git/压缩器、租约与发布源码。
- 范围至多6文件：压缩器/压缩测试、Mac租约实际跨插件消费者、prepare发布说明/门禁、状态清单/计划。修复达到字符阈值时丢失Mac活动目标的已证实缺陷，核验POSIX两插件租约协议。不执行真实删除或传输，不改变业务职责。
- 检查范围为压缩边界回归、虚拟POSIX跨插件冲突/释放/大小写、相关本地目标单文件串行20秒、build/226闭包/vm/UTF8/diff及普通同步；本批已全部通过并同步。
- 本地核查范围明确：平台入口/Windows依赖、路径/CLI/发现、租约/ABI、手动准备与远端职责、防删除确认；M5 OS/磁盘/系统agent/真实传输/完整科研验收延期。交付.309/.97后按用户要求暂停目标；剩余15/29。
- 压缩器新回归先失败2条，修复后5/5；保留Mac旧标题、全部11条边界与当前批/证据/暂停授权，缺活动目标或无法安全压缩时不覆盖。两插件实际模块共享虚拟POSIX注册目录、双向冲突/释放后接管/大小写/中文%20路径通过（macHostLeasePaths3）。build面板2/226闭包/vm/发布门禁4/UTF8/diff通过，单文件串行20秒。
- 本轮源入口核查：CacheCleanupPanel是已确认的活跃Windows执行缺口，已修正；剩余Xshell启动由Mac提前分支转手动指引，未引用TmuxRemoteExecutor及排除PPT不改。真实SSH/传输由SimpleSFTP认证中转，Mac代码明确避开服务器间免密直连。源码核查不证明真实OS行为。

## 前批 mac-005at-local-boundaries（passed，本地）
- 起始Exp4f4e942f7f264503f8c3b9a590e31857730dc272/SF2f464eb75e362150de5cbe61e1946504c3497a0a同步干净；事实/计划/Git/实际业务测试已重读。
- 确认本机缓存删除固定spawn pwsh.exe；配套SFTP缺失提示仍要求Windows安装ps1。范围8文件：CacheCleanupPanel/Mac删除助手/实际消费者测试/legacy/ABI测试/prepare/状态清单/计划。
- Mac使用当前Extension Host的Node子进程，物理直接父目录与最短子项，身份/大小/时间/SHA再验并核对删除结果；UI两次完整路径确认保留。只注入虚拟文件系统/进程，不执行真实删除。
- 原实际Mac入口复现PowerShell失败；首轮另有Windows缺O_NOFOLLOW测试替身问题，注入native常量叶子后消费者/防护6通过。配套ABI旧namespace/legacyManager夹具先失败，迁移后3通过；缓存面板两确认及上下文7通过。
- build面板2/226模块通过；其压缩器因Mac计划缺旧模板节名覆盖活动计划为待刷新骨架，已根据本轮已读记录及Git重建完整活动目标。本地压缩器问题成为下一批，不继续以骨架执行。
- macCacheCleanup6/simpleSftpIntegrationPreflight3/cacheCleanupPanel7/macProjectPrepare16串行20秒通过；build面板2/226闭包/vm/UTF8/diff通过，真实删除0。下一批修正自动压缩并完成跨插件核验，再发布.309/.97后暂停；剩余15/29。

## 本批记录
- 当前公开.309/.97：Exp880b653a8a08024b81446b45b327d2153fe707ff/SF2f464eb75e362150de5cbe61e1946504c3497a0a；回执/实际包/快照/匿名请求证据保留release-artifacts/preview-v0.5.309。包中本地与M5说明明确分开，M5pending，原目标14已验证/15剩余。
- 历史公开.308/.97：Expab8bda82da5c5fbc3c950c9413ed37e279628d57/SF2f464eb75e362150de5cbe61e1946504c3497a0a；prepare82目标/83标记、实际包26场景及1542/83源码快照通过。
- .308 Release408701623，2026-10-10T05:52:35Z，三附件完整核验；索引41e1aa347fa79d95cac7d5e280d7be9549864460普通推送。实际匿名4请求200、REST0、包/SHA与缓存/版本跳过通过，M5pending。
- .308前门禁漏拦与runtimeManifest误路径均以新提交补正；失败证据和.264以来完整历史保留Git与产物。无自动安装/Actions/真实科研或删除。
