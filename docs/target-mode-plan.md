# 目标模式当前计划：mac 适配，更新发布优先
字符上限 12000，达到 10800 自动压缩。历史证据保留在 Git 和 release-artifacts。

## 固定边界
- 原目标为两款独立公开 darwin-arm64 preview 扩展、本机构建发布与完整Mac科研业务；Windows项目独立，普通同步origin/master。
- Apple Silicon/macOS26+；M5/24GB/macOS27.0验收待用户。排除Intel/Dev Containers/PPT/Actions/shop/自动清理与开发机安装。
- 用户授权静态preview.json替代用户端REST查询；附件同一Release、不可覆盖、绑定同步提交，平台/版本/大小/SHA核验。
- 历史首版三拓扑要求已被2026-10-15用户指令替代：仅明确启用Worker，Hub退役。保护API/Plan兼容、现有入口、用户资产/远端任务及删除物理直接父目录/两次完整路径确认。
- 每批至多3个相关问题/8源文档测试文件；目标逐文件串行20秒，Python隔离10秒；build/闭包/面板vm门禁。
- 用户要求先完成不需要真机的剩余工作，完成交付后暂停目标模式；完整目标未完成，不能标complete。
- 先完成后完善，缺真机延期；README/配置说明按里程碑集中更新，不每批重复修改。
- 固定分母29；报告已取得M5环境、最小启动及匿名检查证据后核实原条目，缺证据整条保留剩余。完整目标维持paused；仅执行用户新授权的缺陷修复及功能同步发布。
- 历史074授权为2026-10-13 Windows新增更新参考同步；冻结参考Exp7bb96599（基线42902a5a）/SFed75a5d（基线acae730）。Mac身份/更新/Termius/POSIX/租约/GPU内部标签保留；不复制Windows安装、部署、发布设置，不触碰现有任务。

## 当前批次 mac-align-075（源码实施结束，运行验证deferred）
- 用户2026-10-15授权继续完成源码对齐，Windows唯一权威；只保留macOS必要适配。此次明确禁止构建、测试、生产连接、安装和发布。原目标仍paused，本轮不恢复目标模式。
- 实际冻结Windows Experiment0.5.327/ea7137d388fc4990016319a1b0be10cef659e055（master fc6387fe仅文档）、SFTP0.2.90/23beafc52e4e310001e74a5730f0eae541bbc1bc。最初0.5.326/0.2.89核对期间发现后续稳定提交，075d同步4源文件：SSH部署通道Scheduler证据，部署不依赖尚未启动的本地隧道。Mac起点Exp57d3c6e/SF3c58e082。Windows工作区、用户配置、服务器资产、运行任务、真实产物为保护区域。
- 075a：325份Experiment生产TS和SFTP20份生产JS/Python与package逐项投影；按至多7文件记录源批次，直接复用共同业务，不重推旧Mac规则。075b：OS目录/POSIX/Termius/CLI/凭据及更新分发适配；075c：统一说明与冻结源码指纹。每个后续修正分组≤8文件，不执行真实清理。
- 业务源码覆盖Worker-only、PLAN检查与并行准备、主动查询/原commandId、独立Scheduler、GPU调度、精确停止、最新job产物交集、实查文件树与清理、Windows面板和SFTP生命周期/进度。Mac旧更新事务/门禁改为共同实现的兼容转出，不保留第二套状态机。
- 静态记录：TS AST语法及相对依赖路径、JS/Python语法解析、冻结文件指纹、git diff --check。未加载应用模块。具体文件覆盖与平台例外见windows-alignment-2026-10-15.md和scripts/windows-source-baseline.json。静态结果不是类型检查、构建、测试或行为通过证据。
- 验证deferred：构建/串行测试/生成面板/包闭包/VSIX/更新过渡、M5、服务器流程。Mac缺可靠句柄证明的清理仍显式阻断。未来构建需递增两仓版本，SFTP≥0.2.102；当前版本号保留历史值。
- Git记录：本轮没有提交或推送。强制构建与提交门禁在用户禁止构建的边界下未运行，不能把此次批次标记为已验证成功提交。实际修改仅在两Mac工作区；未改Windows、未部署或启停任务。
- 本轮授权源码修改无预定待执行子批次；剩余7类验证详见对齐记录。不得把旧18/11计数套作本轮覆盖率。后续仅按新授权执行验证或修复。

## 当前授权 mac-sync-080（续接079，验收返修中，2026-10-22）
- 原完整目标保持paused。本轮由当前主会话亲自执行，禁止任何子代理/CLI子会话。用户授权本地编译、隔离回归，必需门禁通过后发布原配套preview；不连接业务服务器、不传输/清理/训练、不启停任务、不部署、不安装开发机扩展。冻结Windows Exp30626e78/SF13ef630a，不追新、不反改Windows。
- 当前候选Exp0.5.315/SF0.2.102；两仓master，HEAD仍57d3c6e/3c58e082，索引空，保留075–079改动。未提交、未打包、未发布。079交接原文保存在本会话附件；完整历史日志在/repos/.079-evidence，不把局部绿灯当最终验收。
- 080核实prepare原实际161项唯一文件，079cp清单仅98项、漏63项；已抽出同一执行列表的纯清单入口，新增目录身份/serverQueueLifecycle/durablePlanQueue/metricAliasRebuildWorkflow/syncResolution后166项，build已执行的panel测试不重复。影响域仍需审核，166不是完整覆盖保证。
- 已恢复ResultLayout的Mac精确POSIX身份及生成Python对应规则；Windows分支保持冻结行为。最新build exit0（pi-test-3s72da1e，含面板5项）、目录身份3/3；OpenSSH补齐配置快照、监听await后退出/取消复查、及时清单飞缓存、拒绝额外转发/代理、禁复用/后台派生、认证后重核更新门禁、子进程error不冒充退出，34/34（pi-test-np_5iwjc）；手动隧道10、无直连5、删除替身13、SFTP认证桥4均通过。均为开发证据，最终候选尚未验收。
- case夹具已删除恒真or True和吞AssertionError；按冻结发现逻辑显式声明同目录输入，并将CSV与同次export的真实报告对照，8/8、exit0（pi-test-2kcfohnd），中途红记录保留。项目聚合仍1/8、exit1（pi-test-n3jemosk）；Plan/claim/archive/result-files旧接口及POSIX链路未完成，不恢复旧业务状态机、不删断言换绿。发布/压缩脚本各6通过，当前166项完整导出在/repos/.079-evidence/final-gate-manifest-080.json。
- 本次build暴露计划压缩保留最早075并丢弃后续授权；修复为识别当前授权、保留最后活动章节，并在压缩前将原文按SHA写入release-artifacts/plan-history。此次已被旧脚本压缩掉的未提交文字不宣称可从Git找回，079事实由交接与原始证据重建；后续须审查压缩差异。
- Windows专属pwsh安装策略、mappedBatchDownload真实SSH取消路由及结果发布租约仍须host_windows真实隔离验收。本会话工具未提供host_windows，禁止换AgentDock/SSH等入口绕过原审批；远端fetch/push/Release暂不可执行。Mac M5/OpenSSH/libproc/真机体验未验，保留preview披露，真实安全保护不得省。
- 新阻断：交接中的/repos/.mac-align-*冻结快照目录现已不可读取；未删除、迁移或重建。静态指纹检查exit1（pi-test-394ad8gs），既有MacHostAdapter/SFTP extension/transfer-settlement三项未刷新，不盲改哈希冒充核验；另快照读取失败记录pi-test-22x4dsjt。verify:package-runtime外层45秒退出124（pi-test-h0_zbq5t），内部回执complete=false/exit未知；未重试或放宽。下一步须核实冻结证据、返修组G及闭包，再完成全部门禁后经host_windows交付preview。

## 当前授权 mac-sync-081（优先缺陷已返修，完整验收仍阻断）
- 继续080授权与全部固定边界；仅当前主会话，无子代理，不绕过host_windows审批。冻结Windows30626e78/13ef630a不变，候选0.5.315/0.2.102未提交/打包/发布，完整目标仍paused。
- 组G八文件63项全过（081-G-development最新八份回执），恢复严格POSIX/尾空格身份、受检输入/归档/项目及分析读取；补SHA字节复核避免同clock tick漏检，保留Windows新调度/schema2和不隐式claim检查。Exp/SF build通过；SF结算/恢复/认证/relay78项、Exp手动适配10项通过。Linux夹具转持久原生目录以避免9p慢IO，保留位置及超时失败，20秒/10秒不变。
- 包闭包通过过291模块；VSCE清单与真实CLI对照8/8，改直接调用固定VSCE同一listFiles而保留8秒预算和全部快照复核；最新292模块/2入口闭包exit0（2tecchpe），本地430指纹exit0（6wijukab）。12条当前源码指纹按审查更新，WindowsSHA不变，不视作行为验收通过。新增SF transferErrors后prepare167项实际同源清单，仍需全量验收。
- 冻结目录是ENOENT；9p挂载仍正常，无证据归因删除者。按既存冻结哈希恢复332/386，缺54不猜造。host_windows为原生Windows Pi扩展，本Codex和动态工具未提供；不直接运行扩展或换AgentDock/SSH绕过审批。
- 影响域仍六文件红：macPlanIdentity/macResultCandidates/macPlanResultCandidates/macResultIdentity/metricAliasRebuildWorkflow/durablePlanQueue。下一步须审查缺失Mac系统适配及当前冻结契约，不恢复旧状态机/弱化测试；补冻结54份及原host_windows入口后执行Windows必验和完整门禁，全部通过才发布原配套preview。详见项目事实081与/repos/.079-evidence；M5仍未验证。

## 当前授权 mac-sync-082（原六失败已修复，扩大回归仍未通过）
- 继续同一授权，仅主会话执行；无子代理/新工具入口，不绕审批。版本0.5.315/0.2.102、Windows冻结30626e78/13ef630a、两仓HEAD和空索引不变；未提交、打包或发布，完整目标paused。
- 补回六源的Darwin POSIX/YAML/Plan选择/结果身份叶子适配，当前Worker-only、主动结果查询与protocol-2生命周期保留。durable夹具改为当前声明任务，保留全部确认/精确取消/重放/重启与唤醒断言、加历史attempt拒绝；指标夹具用真实主动查询与字节/SHA，保留均值/样本SD/原始别名证据，增加全冲突保留旧文件和混合seed新鲜部分汇总。原六文件32项全部exit0，未恢复旧业务状态机。
- 关联87文件实跑52绿35红；另修本机Darwin-arm64租约准入和配套preview提示并通过原断言，最终八文件38项全绿。最新build295模块/面板5项exit0（92ff8qj2），430指纹+编译面板vm exit0（quy7g4f7），包闭包295模块/2入口exit0（5c8wjsv7，VSCE内部8秒不变）；仅审核更新六条localSHA、所有WindowsSHA不变。全部证据在/repos/.079-evidence，不能视作完整验收。
- 仍33文件失败未关闭（dependent-regressions-082.json；含macProjectPrepare一次20秒124，未盲重试）。下一步按Mac路径/摘要范围、拆分依赖夹具及现行共同契约逐批修，不恢复旧队列/Hub/缓存结果回填；重算影响域，167项必需清单不减。
- 冻结目录ENOENT、9p正常，消失原因无审计证据；从既存备份及/workspace精确原SHA匹配恢复370/386份，缺16，合并冻结字节清单frozen-verified-082-7a328293-3e02-437b-b6f3-585cb7c0d5cd/recovery.json。原host_windows属于原生Windows Pi注册上下文，当前Codex/MCP均未接入；不创建桥或换AgentDock/SSH绕审批。补原入口及缺源、完成Windows必验和全部必需门禁后才直接发布原配套preview；M5未验。

## 当前授权 mac-sync-083（原33失败已关闭，终验仍阻塞）
- 继续同一授权与全部固定边界；仅主会话，冻结Windows30626e78/13ef630a、候选0.5.315/0.2.102、HEAD及空索引不变，完整目标paused；未提交/打包/发布，不建执行者或绕审批。
- 原33文件421项全过、无skip；修复POSIX文件身份/摘要严格归属/字节校验，夹具接当前拆分依赖与主动查询，不恢复Hub、旧自动重试或产物回填。再修Agent/调度/CLI路径适配及缓存原始对象/JSON元组，保持声明输出、原Plan大小限制与协议2；错误呈现不绕过正式准入。
- 实际发布清单由167扩为174唯一文件（新增反向调用7文件）；Linux172文件exit0，浏览器主题和10000ms包闭包仍未过，另4个Windows/原生Host skip与Windows结果发布租约/IPC未验。最新build Exp298/SF33运行文件、430本地指纹与面板vm通过；所有WindowsSHA/提交不变。最终逐项证据/repos/.079-evidence/repair-083/final-validation-083.json，不能宣称全部必验通过。
- 按原SHA恢复377/386份冻结原字节，缺9；原冻结目录ENOENT但消失原因无审计证据。host_windows是原生Windows Pi注册工具/千问审批，当前Codex/MCP未接入，检索0；不创建桥或换通道。下一步恢复原入口并取得缺源，完成上述原生与包/UI门禁及最终包/资产核验后直接发布原配套preview，不重复索要授权；M5未验。

## 当前授权 mac-sync-084（冻结源齐备，浏览器与原生门禁已推进）
- 本轮用户明确允许AgentDock控制本机，host_windows暂不可用；不建子代理/会话或审批桥，保留现有审批。主机“宿舍”Windows26200，与共享两仓package SHA一致；冻结Windows30626e78/13ef630a、候选0.5.315/0.2.102、完整目标paused不变。
- 原生只读git cat-file恢复缺9份并匹配原SHA，现386/386完整复核（repair-084/frozen-complete-recheck.json）；旧目录ENOENT仍无消失审计，原host_windows缺当前注册上下文，不等于Pi卸载。
- 闭包原测试Windows2/2、10秒限额不变；安装锁3、SSH取消26、清理别名18、Exp/SF租约14/9、跨插件租约1、结果发布13、认证IPC9均无skip。发布原脚本补入4文件后178唯一必验。
- Linux真实Chromium检出浅色徽标4.41与固定浅色残留，仅修系统主题CSS颜色，保留当前脚本/布局和全部主题断言；三主题已通过。Chrome/Edge宿主空DOM失败保留；无旧状态机恢复。下一步最终影响验收和收包/归档审查，全部必需通过后直接发布原配套preview；远端仍0.5.314，目标0.5.315尚不存在，M5未验。
- 原prepare可选复用全部178个逐文件真实回执，强制同一全部源码/候选/编译字节与精确提交、命令、原始回执SHA、零失败/取消/skip/todo及原生Windows平台，包前后复核；缺失/失配即停止，不提供则运行原门禁。tsc明确LF防跨平台构建漂移，正常忽略生成Python缓存，保留临时证据；新增负向测试已通过，最终证明尚待本候选完整实跑。
