# 目标模式当前计划：mac 适配，更新发布优先
字符上限 12000，达到 10800 自动压缩。保留目标、验证、风险、下一批边界和真实提交记录；完整历史见 Git。

## 固定边界
- 当前目标：独立 darwin-arm64 preview 扩展、配套更新、本机 Releases 发布及完整 mac 科研业务适配。
- 公开 SimpleExperiment-Mac、SimpleSFTP-Mac，普通提交推送 origin/master；Windows 项目独立。
- 支持 Apple Silicon/macOS 26+；M5/24 GB/macOS 27.0 真机 pending，用户延后并授权持续适配/发布。
- 排除 PPT 绘图、Dev Containers、Intel Mac、Actions、zlinkw.shop、历史附件自动清理、开发机自动安装。
- 保护三拓扑、业务 API、Plan 格式、远端实验、删除直接父目录校验/两次确认及原入口。
- 每批至多 3 个相关问题、8 个源/文档/测试文件；测试单文件串行/20 秒，Python AST 隔离/10 秒；build/包闭包/面板语法门禁。
- 最新用户优先级：先完成后完善，缺少真机验证部分延后等待结果；只处理已报告/已证实缺陷，不继续追加推测性完善。
- 用户新增批次汇报要求：每个已完成批次报告剩余原始目标X/29；以docs/mac-goal-status.md为计数依据，未证实的验收条目也计入剩余，不用源码批次数替代目标数。
- 文档节奏按用户最新要求：集中推进功能，累计到阶段完成后统一更新 README/配置说明；实际入口或操作方式改变时，仅同步必要说明。文档仍按 Mac 用法、优先于配色；不再把每轮文档同步作为独立交付重点。汇报以实际功能变化、修复及验证结果为主。更新入口：底部右侧 Mac preview、命令面板检查 preview 配套更新、设置→插件配套更新→检查更新。

## 当前批次 mac-005ao-preview-403（passed，本地修复待真机复验）
- M5首个反馈：第一次检查403，重复检查提示GitHub限流一小时；原始错误找不到，实际HTTP原因未知。先处理更新缺陷。.305已prepare/十九实际包pass但未发布，保留全部产物不覆盖；本批后改用更高.306。
- 范围6文件以内：PreviewRelease/真实客户端和启动消费者回归、prepare说明、目标清单及计划。重读事实/计划、Git状态、实际客户端/Bootstrap及GitHub官方退避规则。确定性同流程复现403与非零remaining/reset一小时，区分真实限流与普通拒绝；仅有证据的限流使用reset，保留真实403429保护和失败语义。
- 不修改认证/镜像/登录要求、业务API/远端实验，不自动安装/删除/Actions。等待真机结果的完善延期。新增实际403反馈尚未解决，原目标15暂恢复待验状态；本地修复也不能宣称M5网络通过。

- 原客户端两个实际check回归先失败，精确第二次错误为GitHub限流1970-01-01T01:00:00.000Z后重试（固定时钟）；仅注入HTTP403/remaining59/reset3600。修复后preview13/实际按钮4/事务6/VSIX/租约1/发布门禁4、本机build/225闭包/面板2/vm/UTF8/diff通过，mac-005ao-final.log，无超时。
- 普通403无假退避；真实primary remaining0遵守reset，次级/429按Retry-After或一分钟指数退避。拒绝响应读取至多16KiB、取消超限，不展示正文，仅公开请求入口。没有证明真机首个403的实际成因，条目15待复验，剩余15/29。
- 下一边界.306/.97：只交付确定修复和既有SF退出核验，使用现有79目标prepare门禁；实际包验证优先当前更新/按钮/恢复消费者与两源码快照。旧19包在.305已验证保留，不为未经报告的科研完善继续扩批。M5相关后续完善延期。

## 保留未发布批次 mac-release-042（metadata passed，0.5.305/0.2.97）
- 起始Exp62a6874d855406074409721f8fdd438360a0e598/SF202ea28b4c13222a8c0ef8ef604b9f1f71d0dd83同步；事实/计划/版本/发布runner重读，范围6文件：两仓package/lock、Exp runtime和计划。仅版本与交付；README/配置按阶段集中。剩余原目标14/29。
- 本机两仓build/闭包/vm、79目标文件串行/20秒、十九既有实际VSIX与新增实际更新/退出消费者、来源快照/完整草稿/匿名两包验证；不安装扩展/Actions/SSH/科研/删除。真实Mac ps和M5仍pending。

- metadata passed 两仓build/26与225闭包/runtimeManifest1/面板2/vm.Script/UTF8/diff，mac-release-042-metadata.log。SF来源2f464eb75e362150de5cbe61e1946504c3497a0a已普通推送/fetch相等；Exp提交以本批Git记录为准。打包与发布验证待执行，原目标剩余14/29。

## 前批 mac-005an-update-settlement（passed，本机功能批次）
- 前轮progress：.304/.96来源21900a074984d1173ab42ff917447efa1ce97413/ca2ddc26a5fe634c0498f01feebfb046503dbe2c和交付30380d7b492ff5ed406334eb69bd4b1992a9935d已同步；78目标/十九实际包/匿名首轮超时原样重试43请求passed。两仓起始干净且fetch后master相等，无活动进程；事实/计划/AGENTS/实际PreviewRelease与SF恢复、相关回归已重读。
- 范围8文件跨两仓：PreviewRelease及回归、SF退出证明与实际恢复回归、prepare/门禁回归、目标状态清单和计划。两相关问题为有效preview查询效率/失败语义、Darwin只读退出证明/恢复；用户新增目标计数记入本批。保护Win分支/旧入口/API/三拓扑/未知退出保护，不读取Termius私有会话，不停止SSH或远端实验，不执行科研/删除/安装。
- README/配置阶段集中，功能本机构建与单文件目标先验证，再.305/.97配套发布。完整目标按原始29条建表，M5缺失证据和已知Mac缺口不假定完成。

- passed 新preview9、Darwin退出/实际恢复7、更新事务6/启动3/更新租约1/发布门禁4及SF结算3/中转9；两仓build、225与26闭包、面板2/vm.Script、UTF8/diff通过，日志mac-005an-final.log。未执行真实Mac ps/SSH/科研/删除/安装。范围8文件，剩余原目标14/29，缺失必需真机证据仍计未完成。
- SF代码202ea28b4c13222a8c0ef8ef604b9f1f71d0dd83已普通推送/fetch相等；Exp代码提交以本批后Git记录为准。下一批仅两仓版本.305/.97、清单来源及配套发布验证，不重复更新README/配置。

## 前批 mac-release-041（passed，0.5.304/0.2.96）
- 代码2f65ed6bb87af8842188f866e6e92c835f121449已普通推送/fetch相等，SFca2ddc26a5fe634c0498f01feebfb046503dbe2c同步干净；重读事实/计划/版本/门禁和实际包runner，起始无活动进程。修正上一记录回执Scope计数为实际8，日志保留。
- 范围4文件：Exp package/lock/runtime/计划，补丁.304，SF源码/版本.96保留；完整78串行目标/十九实际包，扩展既有case8覆盖导出/真实CSV和第四入口，不新增重复测试文件。源快照/完整草稿附件与匿名.303/.96→.304/.96仅Exp更新、SF跳过；不安装开发机扩展，不用Actions或科研/SSH/删除。
- README/配置阶段集中；发布后先执行完整目标证据核验，列明已知功能缺口与M5缺失证据，避免范围漂移。多文件原子性/归档执行/revision内容现存风险不自动当作额外首版需求。

- passed metadata两仓build/runtimeManifest1/225与26闭包/面板2/vm.Script、版本一致/UTF8/diff，mac-release-041-metadata.log；Exp.304、SF.96。下一步完整78目标串行、十九实际VSIX、源快照及匿名更新/同版跳过。

- passed完整prepare78目标文件/79含面板标记，两仓build/225与26闭包/面板2/vm.Script/主题、20秒串行，无测试超时。十九实际VSIX含扩展case8：真实CSV序列化/四入口/原始Plan表路径/目标预检→编译回执，保留旧默认导出，捕获写入executor；完整原子发布/M5仍未验收。
- 代码2f65ed6bb87af8842188f866e6e92c835f121449、发布来源Exp21900a074984d1173ab42ff917447efa1ce97413/SFca2ddc26a5fe634c0498f01feebfb046503dbe2c已普通推送/fetch相等；真实快照SF82源/25原字节包、Exp1538源/418原字节包，仅正式VSCE package/README转换及CHANGELOG改名。
- 已发布 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.304，releaseId408630408，三草稿附件大小/hash集合后公开。匿名首轮请求超时、过程exit1；保持源码/附件不变，另存带逐请求日志runner后43请求passed，实际.303/.96→.304/.96仅Exp待更新、SF同版跳过，下载两包等于十九受检VSIX，清单/平台/身份/VS Code/CRC/大小/SHA与source/禁止降级通过。匿名首次失败、retry trace和最终报告保留，不放宽超时。
- 完整目标预核验发现两个具体缺口：PreviewRelease.checkReleases按顺序下载所有历史清单，本次43请求；parseManifest已证明tag等于Exp版本，可按元数据语义排序优先检查有效最新版本。SF localTransferExitProof对非win32直接报LOCAL_PROCESS_PROOF_UNAVAILABLE，extension真实两处恢复调用无Mac替代，阻塞断连核实。
- 下一批mac-005an-update-settlement：优先更新查询预算/有效preview选择及Darwin只读进程退出证明，7文件以内跨两仓，真实源码与恢复消费者回归，不读Termius私有会话、不停止用户SSH/远端实验，不绕过未知退出保护。维持原Windows分支/三拓扑；只有已知Mac缺口进入批次，其他完善先按原目标核验，M5仍待用户。

## 前批 mac-005am-case-export（passed）
- 前轮progress：样本三入口代码f22544521b3a52b645c42f6f272344fba9d29aeb、.303/.96源码acaa9840861ea6082d62b457172ac11bbe72c18f/ca2ddc26a5fe634c0498f01feebfb046503dbe2c与交付48568ac6e091fcf74d0201d3d3bc4dacdc9c1ac1已同步；78串行目标/十九实际包/42匿名请求passed。两仓起始干净，fetch确认master相等，无活动进程；事实/计划/实际导出/子组、CSV写入与回执、隔离回归重读。
- 范围6文件：共享case输入与导出、Agent子组私有不发布计算/导出入口与请求身份、现有真实AST/编译回执Node/Python回归、prepare说明/既有门禁与计划。三问题：原始Plan/revision与表路径；当前受检子组/CSV完整准备后发布；实际导出回执和失效/空样本。保留旧默认入口/统计算法/API/三拓扑，写入executor捕获，不执行整Agent/科研/SSH/删除/安装。
- README/配置阶段集中，入口无新增；代码验证后Exp.304，SF无变化保持.96。完整多文件原子性/归档执行/revision内容/M5仍pending。

- passed实际生成case/泄漏/子组/导出及四请求AST→编译回执8，真实write_atomic_csv序列化捕获、中文/引号/换行、原始Plan/来源和路径、旧默认导出；无超时。build/225闭包/面板2/vm.Script/UTF8/diff、既有发布门禁4及回执Scope8通过，mac-005am-final.log与本轮case目标输出。六文件，完整输入和全部CSV/报告目标先准备再发布，不能视为多文件物理原子或M5验收。
- 下一边界：.304/.96发布后，按完整目标逐项核验本机已实现证据、Mac专属执行依赖和三拓扑链路，区分可继续修复的已知缺口与用户延后的真机证据；不把未要求的额外完善无限追加为首版阻塞项。

### .303/.96 已交付历史
- 来源Expacaa9840861ea6082d62b457172ac11bbe72c18f/SFca2ddc26a5fe634c0498f01feebfb046503dbe2c，交付48568ac6e091fcf74d0201d3d3bc4dacdc9c1ac1；78目标/十九实际包/42匿名请求passed，样本代码f22544521b3a52b645c42f6f272344fba9d29aeb。完整失败/验证/来源保留Git和release-artifacts，M5/原子性/完整执行pending；README/配置阶段集中。

## 前批 mac-005al-case-read（passed）
- 前轮progress：文档节奏修订47a8736已同步；.302/.96已完成77串行目标、十八实际包和41匿名请求。无活动测试/发布过程，起始Exp47a8736与SFTPca2ddc26a5fe634c0498f01feebfb046503dbe2c干净且fetch确认master相等。新用户AGENTS、事实/计划/实际case路径、读取与入口重读。
- 范围7文件：case受检输入、Agent三入口与请求身份、真实AST/编译消费者Node/Python回归、prepare门禁/发布说明、门禁回归及计划。三问题：原始Plan/revision与发现集合；实际CSV/UTF8/行归属；泄漏/子组使用当前可信样本、不借缓存全局索引。保留旧默认入口/统计实现/API/三拓扑；没有科研/SSH/归档删除或开发机安装。
- 依据最新文档节奏，本批操作入口不变，README/配置累计后集中更新；代码验证后发布.303，SFTP源码与版本不变则保留.96并验证相同版本跳过。科研/M5、完整导出/写入原子性与revision证明仍pending。

- passed build/225闭包/面板2/vm.Script/UTF8/diff，新样本8、发布门禁4、分析8/claim8/聚合8/归档8/解析9/读取7/契约7及四个既有结果界面回归，单文件20秒/Python10秒串行，mac-005al-final.log。首次6/8及随后7/8失败为fixture把末尾空格改为字面%20后缀、glob漏原文件名首空格；修正真实输入后8/8，未放宽生产校验/超时。
- 原始Plan/revision、实际CSV/config/jobs/插件策略及缺失输入、发现集合在发布前受检；全局缓存不再借给指定Plan，空样本泄漏warning/子组empty。实际三请求AST分支和编译回执消费者通过；只捕获发布，完整多文件原子性/导出/revision内容/M5仍pending。范围7文件，文档按阶段集中，下一批仅Exp版本.303，SF.96保持并测试同版跳过。

### .302/.96 已交付历史
- 来源Exp2aa52511813aa944c2cf68af717ad29aab025c19/SFca2ddc26a5fe634c0498f01feebfb046503dbe2c，交付5994f2090c82aa534ee843d827109041a8eaf61d；77串行目标/十八实际VSIX/41匿名请求passed。分析代码eb7197917417dfae2d9fa06e48196437a7ce5047、文档d3840a06518607d942848f9a14bef5ddfcdceb17/6a7537468b64d363ed04d2cf5cff4bc274262d1b均普通推送/fetch相等；失败、原子性/完整执行/M5 pending和证据保留Git/release-artifacts。文档节奏47a8736cdc8d8ac5ead08dcaccb30676dbee0447按用户要求改为阶段集中更新。

### 旧文档集中批次
- d3840a06518607d942848f9a14bef5ddfcdceb17/6a7537468b64d363ed04d2cf5cff4bc274262d1b集中Mac文档已交付；完整验证见Git，后续按里程碑集中。

### 旧分析读取批次
- 代码eb7197917417dfae2d9fa06e48196437a7ce5047、.302/.96已普通推送；完整失败/验证/局限见Git与保留产物。

### .301/.95 已交付历史
- 来源Exp738f9e271bd908c8341cc80a704f383e8a755499/SFTP068ec5fe6244f5d8e4b7d7152764773631a84d96，交付a0d00c9bec05a620aa7ec9d0e2e665cedcca320f；76串行目标/十七实际VSIX/40匿名请求。claim代码dda0b5ccc3a26f6fedfc3fd9539453169ec596a7、文档ef649df249df511af258f0a3f6f5c075b0063b9e/fdac594ac94c411a895a1e5009599d1799dbd3d9均普通推送/fetch相等。String.raw反引号、严格runs候选与registry fixture修复后真实8等passed，完整失败、来源与证据保留Git/release-artifacts，M5 pending。

### .299/.93—.300/.94 已交付历史
- .300/.94 来源Exp59ecb3f5c68bd3085f43f91ec30ed238107a7afe/SFTP12d726fbddbe033aa203bb1725149c0411905beb；交付d569ef1c825f492b7f66374e5a4aebb81ee4693c。聚合代码d88402159c600afd550e8f593608768b2d8997e9、文档398f8797aafc5c50dcc97dd81f7d16a02c018391/78f6f8e1b827dc497119c623ddfb94aaa801d368；75串行目标/十六实际VSIX/39匿名请求passed，全部普通推送/fetch相等。
- .299/.93 来源cb2e182e03c81614bd4b0f1749be58c1e0f03130/8113c9deea20c38e1b8399b3a6806ef087769749，交付c341b259b2102335ea6dd0cd6a6d3f9d0a6a4aa8；74目标/十五包/38请求。真实归档8/聚合8与最初fixture失败修复/完整记录在Git及保留产物，M5 pending。

### .298/.92 已交付历史
- 来源Exp `7d29548990cab73ca8e5cd0dff48caaabbf4fb85`/SFTP `2006c5b49bb28c57a124938aff456fcef7d6de98`，交付 `86fabf48bcfe00d9dc9e924c90ac812c936ada03`普通推送/fetch相等；73串行目标/十四实际VSIX/37匿名请求passed。真实解析9/读取7/契约7、文档和门禁同步；完整失败/证据见Git与保留产物，M5 pending。

### .297/.91 已交付历史
- 来源 Exp `406d87a63d9aa2dbfd706189d311de5e5bbe0b3a`/SFTP `35731fa41a8d9f1d8aa8e342b95ad3d7c5feede5`，交付 `8c2c387ae08339a72830650202c1ecaa275a4191` 普通推送/fetch相等；72串行目标/十三实际VSIX/36匿名请求 passed。完整证据见Git与保留产物，M5 pending。

### 已完成局部边界 mac-005ag-agent-parse
- 限指定 Plan 的 parse_results_action 原始声明/候选/受检读取与报告身份，复用本批只读输入边界；至多 8 文件/3 相关问题，真实生成函数隔离与实际编译消费验证，保留原入口/API/Plan 格式/三拓扑。其他运行/写操作、删除/归档、原子写入、完整 revision 内容/M5 不扩入；README/配置优先同步，再通过同一配套通道发布。

### 已交付历史（完整失败、验证与来源见 Git 和保留的 release-artifacts）
- .296/.90 来源 Exp `5d6c21b74c44cda98e7a570caaf0831dc68ea80c`/SFTP `7cce33b150473f46a804611f67a0ae465838aeb3`，交付 `5075d8595586e90932b81fe545c31378482d7b93`，普通推送/fetch相等。71串行目标/十二份实际VSIX/35匿名请求通过，M5 pending。
- .294/.88 来源 Exp `1dd2e0a80adc8a29b7ae5310c03d197d5214459e`/SFTP `8cceeee9ee706fc5cf25d3df66c02070f8386950`，交付 `02a425ccb84e7ad1fce5313c792d93596000a759`，普通推送/fetch相等。69串行目标/十一份实际VSIX/34匿名请求通过，M5 pending。
- mac-tool-002 `ed5f6fa57e8fecc8182fff1eff97dd6b72d0fc7e`、tool-003 `4f0f295707f0f142e852184e162e92c81b7a3547`：真实 pinned VSCE 源快照，解决旧遍历附件超时、保留SFTP缺省 files 策略，不扩测试时间、不清理。未发布 .295/.89 失败证据保留。
- mac-005af `bb9a5988e81d0c31ab848c4151a1412dcf3760ea`、doc-027 Exp `0924896882fe97031337c9400c3a4afcf2d4e82e`/SFTP `735f16fa99567ac0d30b79198cc7cf2d601295c4`：受检输出声明及UTF8描述符输入，真实NTFS/POSIX fixture 保持实际大小/ctime/二进制读取，文档及门禁同步。旧候选/回执/结果身份、CLI/更新、主题及Termius三拓扑入口保留。
- .287 至 .293 分批源码与交付均普通提交推送，完整验证、失败修复及局部适配证据在对应 Git 与保留产物。未改写历史，无自动安装、Actions、真实科研或未经授权的清理。

## 未完成与下一边界
- pending mac-005：其他运行/写操作回执来源授权、映射原子下载发布、Webview 行字段序列化、其他 Agent 结果动作的路径/YAML/读取、完整 Mac 本机解析与来源、归档、其余 Windows 专属业务依赖，逐批适配。输出契约 Plan 产生端局部完成不代表这些链路已验收。
- 物理检查与启动/写入间尚非原子锁定，其他 Agent 动作的 YAML 与 suite/config 等其他 scalar 不在本批证据内。
- pending mac-006：真实 M5 首装→更新/设置保留/重载/部分失败补装；Termius、独立密钥/密码传输/中文路径/断连；单 Worker、多 Worker、Hub/Worker科研主流程。
- 本地更新链路、VM/AST 与 headless 通过不能宣称完整科研或 M5 验收。用户延后真机验收，不阻塞可继续的本地适配。
