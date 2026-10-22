# Mac 项目事实

## 2026-10-22 续接返修（084，终验中）

- 用户本轮明确允许用AgentDock控制本机，替代当前未接入的host_windows；仅当前主会话，无子代理/新会话、不绕现有审批。原完整目标仍paused，冻结30626e78/13ef630a、候选0.5.315/0.2.102不变。AgentDock原生机器名“宿舍”、Windows26200，两仓package SHA与共享工作区一致；未启动旧执行者或改Pi审批接入。
- 原Windows仓库的两个冻结commit可读。只读git cat-file恢复缺失9份，全部匹配既登记的原Windows SHA；386/386完整复核见/repos/.079-evidence/repair-084/frozen-complete-recheck.json。旧快照目录仍ENOENT，无审计证明消失原因；host_windows缺在当前工具注册上下文，未证明Pi卸载。
- 原生Windows包闭包原测试2/2通过（约8.3秒，10000ms子进程/8000ms VSCE及全部绑定不变）；初次10秒失败和诊断7.7秒均保留。Windows installPolicy3、mappedBatchDownload26、cleanupFiles18、Exp租约14、SF租约9、跨插件租约1、结果发布13、认证IPC9已通过且无skip，完整原始回执在repair-084。发布脚本补纳Windows结果发布与租约4文件，实际必验清单178。
- Windows Chrome/Edge退出0但DOM为空，不能当主题通过。Linux沙箱安装独立Chromium headless-shell，以非root账户在现有容器中加载唯一HTML；实测暴露浅色错误徽标4.41对比度和固定浅色面板残留。仅修CSS颜色、系统主题选择/高对比边框与焦点；当前脚本和非颜色布局字节保持，三主题原断言均通过。构建面板5项及vm门禁仍需绑定最终候选，所有失败日志保留，不弱化断言或恢复旧业务状态机。
- 原preview-v0.5.315及标签尚不存在，最新已发0.5.314；两仓远端master仍等于原HEAD。尚未提交、打包、推送或发布；下一步完成最终影响回归、冻结指纹和实际归档审查后，按原配套流程直接发布，不重复索要授权。M5/OpenSSH/libproc真机边界继续披露。
- 为串行跨环境验收去重，原prepare新增可选的逐文件证明复核：全部178个命令、全部当前源码/未跟踪候选及编译字节、精确提交、完整零失败/零skip摘要与原始回执SHA必须匹配；缺项、外来/重复项、超时、错平台或任一字节变化即停止，打包前后均复核。未提供证明仍执行原完整门禁。新增负向回归覆盖这些拒绝路径；tsc显式LF保证同一共享候选跨平台构建字节可比较，生成Python缓存列入常规忽略，不删除证据。LocalApi28原生回归也无skip通过。最终证明尚待当前输入完整实跑后生成。
- 随后178文件/1422项全部通过且零skip，compiled与rendered脚本vm通过；精确提交SF2141553、Exp27d19b6，工作树干净。Exp既存post-commit钩子自动推送，检查结果未及时阻断后续提交为本轮流程失误；已通过AgentDock核实远端并正常FF推送SF，未禁用钩子或绕审批。实际收包审查发现此前只跟require字面量、漏动态工厂/Worker入口，且带入99个未引用编译JS。现补tryRequire/featureImplHints/require.resolve/独立Worker依赖、统一入口路径，闭包315模块；仅收包策略排除99个未引用编译项，保留模板/Python/资源/法律文件，增加额外JS拒绝门禁及动态闭包回归。真实业务源码不变，实际必验清单179；新的归档候选必须重验，未打包/发布。
- 归档候选首轮169个Linux文件全部通过；包前逐项资源审查再排除仅供发布端的旧preview.json与Windows simpleex.cmd，Mac实际读取在线索引并生成POSIX启动器，两者均非运行资源。此次只收紧同批8文件中的收包策略/拒绝门禁；最后候选将再次绑定全部179项，不能复用旧全局字节摘要冒充本轮通过。
- 构建身份直接反向回归panelBuildIdentity补进原清单，最终180唯一文件（Linux170/Windows10）；公开实际PreviewReleaseClient已匿名读取0.5.314在线索引/清单且REST0，发布后仍须核实0.5.315和真实附件。新的候选摘要未沿用旧测试结果，归档和发布尚未执行。

## 2026-10-22 续接返修（083，未发布）

- 仅当前主会话执行，无子代理/新会话、真实业务连接、传输、删除、训练、安装、提交或发布。Windows冻结30626e78/13ef630a、候选Exp0.5.315/SF0.2.102和完整目标paused不变。
- 原33失败文件现全部exit0：421项、无skip。修复Mac严格POSIX路径/摘要完整归属/映射读取字节证明，夹具接入当前拆分模块与主动查询、真实manifest/CSV/SHA；保留协议2、Worker-only、声明输出、历史attempt拒绝和未知结果栅栏。未恢复旧Hub/队列/缓存产物回填状态机。
- 扩展原167项验收发现16个额外失败，14个已修复；其后路径函数反向调用补入7文件，发布原脚本实际清单现174个唯一文件。最新Linux结果172文件exit0，主题浏览器缺失与包闭包子进程10000ms超时仍阻塞；另cleanupFiles 1、installPolicy 2、mappedBatchDownload 1共4个skip不是原生验收通过，Windows结果发布租约/IPC仍欠原host_windows。完整逐文件回执：/repos/.079-evidence/repair-083/final-validation-083.json。
- 后续纯I/O适配保留文件名空格/大小写/Unicode，拒绝类型、别名冲突、链接及启动前Plan父目录变化；1MiB Plan上限保持。摘要缓存以原始对象和JSON元组区分变体，归属过滤保留。运行时夹具只AST提取函数/import，子进程10秒、单文件串行20秒不变，证据和唯一夹具保留；错误输出只读本次新增字节，未绕过正式准入。
- 最新Exp build exit0（pi-test-4v5oicmr，298运行文件/面板5项），SF build exit0（nh4buksf，33运行文件）；430本地指纹和编译面板vm.Script exit0（32gh4z8z）。只审核更新本轮实际源字节的localSHA/适配理由，所有WindowsSHA与提交不变。静态指纹、Linux exit0和历史闭包成功均不代替最终原生验收。
- 从/workspace既存普通源文件按原冻结SHA精确匹配，新增恢复7份：现377/386，仍缺Exp package/lock、extension/legacy、RuntimeManifest，SF api-server、cleanup-files、extension、package/lock共9份。复核377份零不匹配：/repos/.079-evidence/repair-083/frozen-partial-recheck.json。没有反向身份合成或Windows donor Git读取；缺原始冻结test/scripts导出也不以当前夹具冒充。
- 冻结原目录在健康9p挂载视图为ENOENT；没有删除/迁移审计，不能归因谁或何时使其消失。原host_windows注册于原生Windows Pi API，依赖Qwen modelRegistry审批；当前Codex工具清单与AgentDock动态检索为0，属于接入上下文缺失，不能推断Pi被卸载。未建桥或改用AgentDock/SSH/GitHub替代入口。恢复原入口与缺源、完成全部必需门禁后，仍直接发布原配套preview；M5真机边界继续披露。

## 2026-10-22 续接返修（082，未发布）

- 本轮仍仅当前主会话，无子代理、CLI子会话、真实业务连接、安装、提交或发布；冻结Windows30626e78/13ef630a、候选Exp0.5.315/SF0.2.102及完整目标paused不变。
- 原六个失败文件已修复：macPlanIdentity 7、macResultCandidates 6、macPlanResultCandidates 7、macResultIdentity 8、durablePlanQueue 1、metricAliasRebuildWorkflow 3，共32项全部exit0。补回Darwin原始POSIX/YAML/Plan选择与结果路径适配，保留当前Worker-only、声明输出和protocol-2状态机。旧自动重试只在明确的历史表示夹具检验；新增protocol-2不得进入旧自动重试断言。
- durable夹具提取当前函数、使用声明任务，保留持久确认/精确取消/重放/重启栅栏/慢处理器及唤醒失败断言，并增加历史attempt拒绝。指标夹具接入实际主动查询、manifest与CSV字节/SHA链；均值/样本SD/原始别名来源断言保留，覆盖全部冲突不覆写既存CSV/Markdown，以及单seed冲突时只汇总另一个新鲜seed、标1/2且不借用旧值。当前共同结果契约三源文件的冻结SHA证明见/repos/.079-evidence/metric-alias-082-7c90e86d-f5ba-43b8-81e6-2a34450ddc07/frozen-contract-proof.json。
- 另补回Darwin-arm64本机租约准入和Mac配套preview安装提示，原测试各3项通过。最终八文件38项均exit0/无skip，证据selection-final-eight-082.raw.log；最新build exit0（pi-test-92ff8qj2，295运行文件、面板5项），430本地指纹及编译面板vm exit0（quy7g4f7），包闭包295模块/2入口exit0（5c8wjsv7，VSCE内部8秒预算不变）。只更新六份已审查源的local SHA与平台理由，所有Windows SHA/提交不变，指纹不代表行为通过。
- 关联87文件逐个串行实跑，52文件exit0、35文件失败；上述额外两项修复复验后，仍有33文件失败未关闭，包括macProjectPrepare一次20秒截止124（未盲重试）。完整失败、计数、原始日志见/repos/.079-evidence/dependent-regressions-082.json；涉及其他Mac路径/摘要范围、拆分依赖夹具与旧业务契约，不能因这六文件已绿而省略。prepare实际167项仍未完整通过，不得发布。
- 原冻结目录在当前挂载视图为ENOENT，/repos映射/GitRepo、/workspace映射/GitRepo/MCP/zlk-cluster-orchestrator，9p正常，不能归因为权限问题；没有审计证据归因删除者或迁移时间。利用既存备份及/workspace、extensions/simple-sftp普通文件，只保留与原冻结SHA精确相等的规范LF原始字节，现恢复370/386，仍缺16；没有反向身份合成或Git donor读取。合并校验清单：/repos/.079-evidence/frozen-verified-082-7a328293-3e02-437b-b6f3-585cb7c0d5cd/recovery.json；不等同于完整冻结test/scripts导出。
- 原host_windows是pi-host-windows.ts中向原生Windows Pi注册的工具，依赖Pi modelRegistry的千问审批；当前Codex工具清单与AgentDock动态检索均无此入口。确认的是接入上下文不匹配，未证明原Pi安装被卸载；未新增桥接、配置、工具入口或执行者，也未换通道。取证见/repos/.079-evidence/environment-audit-082.json。Windows专属必验与GitHub发布仍须原入口，现不满足发布条件。

## 2026-10-22 续接验收（081，未发布）

- 当前主会话独立执行；无子代理、真实业务连接、安装、提交或发布。版本仍Exp0.5.315/SF0.2.102，Windows冻结提交不变，原完整目标paused。
- 组G八文件63项全部exit0：恢复POSIX读取/原始Plan身份、归档与项目汇总隔离、Plan/case/claim读取复核；移除接受strip/畸形输入的弱化断言，保留同一次case导出报告核对。相同文件系统时钟刻度内的同大小写入可漏过metadata比较，已加有预算的重新打开与SHA256核对；保留新调度/schema2，不恢复旧队列，不在parse/export中隐式执行claim检查。
- 最新G回归回执：sspdh4j5/i4qzu7kq/k_auwsay/6veb84ub/irnv_nuv/f77wg_di/c2odi6b6/rl0j4ws4（均在/repos/.079-evidence/pi-test-*）。Exp build exit0（v1d1b6os，292模块，含面板5项），SF build exit0（jpqggo5b）；SF结算/恢复/认证/relay等八文件78项及Exp手动适配10项通过。均是局部开发证据，M5未验。
- 闭包旧45秒外层与VSCE冷启动8秒分别超时；9p重复mkdir优化后，清单改用锁定VSCE CLI本身调用的listFiles函数，不加载发布/云认证模块，8秒时限未放宽，实际打包仍用原CLI。清单与真实CLI及快照防篡改8/8通过；一次完整闭包exit0（gz_4bncd，291模块），最新292模块/2入口闭包exit0（2tecchpe）；本地430指纹检查exit0（6wijukab），只证明当前本地字节。
- 更新12条已审核本地源码指纹，旧三条漂移源于079修正后未同步记录；所有Windows SHA/提交保持原值。指纹仅表示本地字节一致，不能覆盖已知行为失败或缺失权威证据。完整审查变更表为/repos/.079-evidence/fingerprint-review-081.json。
- /repos仍正常映射D:/GitRepo；原.mac-align-*目录缺失（ENOENT），不是权限拒绝或挂载失效，现有日志无法归因。仅从当前Mac字节与既存冻结SHA相等的项恢复332/386份源码，剩54份不反向猜造；部分恢复在/repos/.079-evidence/frozen-recovery-081-93c9ea5b-f705-44f7-891a-bb1d3658f8ff/recovery.json。
- host_windows由pi-host-windows.ts注册，仅允许原生Windows Pi；当前Codex及AgentDock动态工具搜索无此入口，未改配置、启动子会话或换通道。Windows专属必验与GitHub发布须等原审批入口接入。
- 继续阻断：macPlanIdentity、macResultCandidates、macPlanResultCandidates、macResultIdentity、metricAliasRebuildWorkflow、test/agent/durablePlanQueue六文件最新exit1，均保留在081-impact-development回执；涉及UI/候选路径原始身份与新旧夹具契约，不能降断言或恢复旧业务换绿。全部必需验收尚未通过，禁止发布。prepare新增transferErrors后实际167项，仍不是完整覆盖保证。
- 组G原9p夹具在20秒上限停止，旧超时回执wxj2do1c保留；Linux隔离输入改放持久原生目录/home/node/.codex/fixture-artifacts，位置回执在release-artifacts/fixture-locations，Windows仍用项目原生卷；无自动清理，Node20秒/Python10秒限制不变。

## 2026-10-22 当前验收（080，未完成交付）

- Exp0.5.315/SF0.2.102仍为未提交候选；原目标paused，当前主会话亲自执行，不启用子代理。冻结Windows30626e78/13ef630a，未修改Windows或操作业务服务器。
- 080恢复ResultLayout的Mac精确POSIX目录身份，修复OpenSSH监听await期间退出/取消、可变配置、延迟清除单飞缓存、额外远程/动态转发及隐藏ProxyJump；认证后重核配套更新门禁，子进程error不再当作退出证明。关闭ControlMaster/ControlPath和后台派生，保留独立认证。
- 最新Exp build exit0（pi-test-3s72da1e，含面板5项）；OpenSSH34/34（pi-test-np_5iwjc）、目录身份3/3、case8/8、手动隧道10/10、无直连5/5、删除替身13/13、SFTP认证桥4/4、发布脚本6/6、计划压缩6/6均为当前局部开发证据，日志在/repos/.079-evidence/pi-test-*。不代表完整最终验收。
- prepare原实际161个唯一测试，079cp交接清单漏63个；现由同一执行入口导出166项并保留全部原测试，build面板不重复。新增durablePlanQueue实际位于test/agent，前轮记录的features路径有误；清单不再依赖该手写路径。
- 项目聚合实跑1/8、exit1（pi-test-n3jemosk）；其余Plan/claim/archive/result-files仍有已知旧接口及POSIX链路阻断，不能以历史局部绿灯、指纹0缺口或不在清单排除。没有打包、提交、推送或发布。
- 构建期计划压缩曾错误保留075、丢弃079未提交记录；已修为选择最后活动授权，压缩前SHA快照保留原文。080恢复事实依据交接及完整日志，未声称被旧脚本丢掉的文字已保存于Git。
- 当前连接缺指定host_windows工具；Windows必验和GitHub操作不可绕用其他入口。M5/OpenSSH/libproc实际体验尚未验；preview发布仍须先通过全部必需门禁并披露真机边界。
- 080收尾新增阻断：交接冻结快照/repos/.mac-align-*现已不可读取，未执行删除或恢复；指纹检查exit1，MacHostAdapter/SFTP extension/transfer-settlement三项仍与表内记录不一致，未盲改。包闭包检查外层45秒退出124、内部未返回exit（pi-test-h0_zbq5t），不算通过、不重试放宽。完整166项实际路径及未执行的Windows义务已导出/repos/.079-evidence/final-gate-manifest-080.json；所有失败日志保留。

## 2026-10-22 当前源码（079）

- 父集中审核发现并修复三处 P0：隧道 `-L` 探测改用 `ssh -G` 单源判定；隧道生命周期身份/nonce/kill/取消只报告已验证事实；同步范围整树冻结与写前复查对齐 Windows 调用链。另修复 macOS 尾空格 Plan 选择回退（恢复 darwin 免 trim 覆盖）与 workflow 工作区严格 POSIX 身份（非 Windows 分支走 `normalizePosixAbsolutePath`，Windows 分支保持冻结字节一致）。
- 版本号按既有授权统一递增：Experiment 0.5.315、SFTP 0.2.102（package/lock/RuntimeManifest/配套最低版本同批）；共同更新租约协议最低要求0.2.102已满足。079的未构建状态是阶段记录，当前构建和剩余验收以上方080为准。
- macOS 真机（M5 设备）未验证任何 079 变更；所有服务器侧动作仍为替身。

## 2026-10-22 源码批次（078）

- 冻结 Windows Experiment 0.5.400 / `30626e78ea2f4b8a3e19e2cb09ae6aefcc6deb39`、SFTP 0.2.104 / `13ef630a12c6ea02ad9277452e75dbf443b9a34b`，稳定交付与精确提交已核实；Windows 源码未修改。
- 本轮写入 82 份 Experiment TS 和 7 份 SFTP JS/Python，同步共同调度/查询/源码范围/索引/UI/API/清理及忙证据；保留前轮 Mac 路径、认证、Termius、preview、更新租约和 Darwin libproc 成果。
- 静态检查：392 TS、23 JS、6 Python 语法、相对引用及 427 文件指纹；没有类型检查、转译、构建、测试、运行探针或任何真实业务。Mac 版本仍 0.5.314 / 0.2.101，无新包、提交或推送。
- **剩余源码 1 项**：同步范围本机直接删除缺完整 Darwin 目录证明，已在执行前显式 HANDLE_CHECK_UNAVAILABLE；不把它混同于已接线的 SFTP/PLAN/缓存清理。7 类验证全部 deferred；目标仍 paused，历史 18/11 不表示当前覆盖率。
- 批次、平台差异、冻结身份和待验证细节见 [078 对齐记录](windows-alignment-2026-10-22.md)。

## 2026-10-16 历史源码（077）

- 本轮以Windows为唯一业务权威：Experiment0.5.341提交33b48126478b9f610f9a434c7541eeb385fd378a；SFTP0.2.90提交23beafc52e4e310001e74a5730f0eae541bbc1bc。Exp远端master255f4a71只追加交付说明；两仓只读fetch核实。077已同步.328至.341的34份TS差异（含7新增模块），SFTP没有后续业务提交。
- 工作区已直接对齐共同Worker、PLAN、调度/主动查询、tmux、产物/清理、面板与配套SFTP源码；平台例外集中在src/platform及现有Mac认证/路径叶子。Hub已退役；下方三拓扑约定只描述历史。
- 当前版本号仍为0.5.314/0.2.101，源码修改未构建、测试、安装、发布或提交推送。新共同更新协议要求未来SFTP版本≥0.2.102，待授权构建时统一递增。
- 原目标保持paused，原18已验证/11剩余为历史计数，不表示新源码验收完成。未操作现有远端任务或真实产物。
- 实际变更、平台边界及待验证项目见[077源码对齐记录](windows-alignment-2026-10-16.md)。新增多选PLAN、实时结果汇总、运行日志异常与复核、独立Worker刷新及手动派发身份修复，Windows布局/默认值/恢复规则保持同源；不改用户资产或远端任务。
- 076追加已补齐Darwin句柄证明源码及SFTP/本机缓存接线：同用户libproc原生只读查询，设备号/inode绑定冻结清单；不另建清理业务规则。权限不足或证据不完整仍阻断。未执行该适配器或任何真实删除；本轮已列明的源码缺口已处理，7类运行/构建/测试验证继续待执行。

## 历史初始化与发布证据（不代表本轮源码验证）

- 本仓库从已提交的 SimpleExperiment 源码 `8934ed8b80fe96981a0f8deb1c0481039e9c1568` 初始化。原项目工作区的未提交 Python 缓存没有复制。
- 配套仓库从 SimpleSFTP 提交 `d2b7d20f0d5649c783f4f9d15bc5d9427bee6b13` 初始化。
- 目标仓库为公开的 `zlinkw/SimpleExperiment-Mac`、`zlinkw/SimpleSFTP-Mac`，分支均为 `master`。Windows 源项目保持独立。
- 本地开发设备为 Windows；支持目标为 Apple Silicon、macOS 26 及以上。用户2026-10-11提供M5、24 GB、macOS 27.0、VS Code 1.141的部分真机报告，验收版本.309/.97；最小启动/更新入口与检查恢复通过，在线安装/三拓扑完整科研仍待验。不能用本地测试替代真机，详见`mac-native-acceptance-2026-10-11.md`。
- 首版仅 preview。两组件与 release.json 放在 SimpleExperiment-Mac 同一个 GitHub Release。无需 GitHub Actions，不接入 zlinkw.shop。
- 三种拓扑及实验 Plan 和业务 API 契约保持兼容。PPT 自动绘图、Dev Containers、Intel Mac 不属于首版验收。
- 完整复制的旧源码和文档仅是迁移基线，旧安装、发布、更新源和 Windows 说明不能作为 Mac 交付指令。正式发布只使用新的 release:prepare / release:publish。

- 首版发布版本为 Experiment 0.5.264、SFTP 0.2.62，沿源版本递增，保持科研项目最低版本契约及已有 Agent 版本方向。初始化时的 0.1.1 从未发布。
- 当前配套公开版为[preview-v0.5.314](https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.314)：Experiment 0.5.314、SFTP 0.2.101，Exp源码`cfc46572020a437096e9aa4ffb8d87d64e69e879`、SF源码`3c58e082adeaafcce923a8f5a4d74ea39d770390`，索引`c6709ea95d3f311f519c34d4060e629026cfe1e9`。Windows新增9次Exp/2次SF提交的功能与Mac边界见`windows-sync-2026-10-13.md`；前轮分叉后17提交映射仍保留。146个目标文件（含build面板标记147），234/28运行模块闭包与面板vm、实际两份VSIX消费者232项、1609/89源码快照、匿名四请求/REST0及大小/SHA/CRC/身份/平台核验通过。正式身份/精确停止、环境预检、失败审核、完成Worker镜像及更新恢复尚待M5；原目标18已验证11剩余，完整目标保持paused。历史失败日志和附件保留，不连接服务器或改动现有远端任务。
