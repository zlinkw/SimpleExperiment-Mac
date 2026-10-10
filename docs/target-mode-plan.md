# 目标模式当前计划：mac 适配，更新发布优先
字符上限 12000，达到 10800 自动压缩。保留目标、验证、风险、下一批边界和真实提交记录；完整历史见 Git。

## 固定边界
- 当前目标：独立 darwin-arm64 preview 扩展、配套更新、本机 Releases 发布及完整 mac 科研业务适配。
- 公开 SimpleExperiment-Mac、SimpleSFTP-Mac，普通提交推送 origin/master；Windows 项目独立。
- 支持 Apple Silicon/macOS 26+；M5/24 GB/macOS 27.0 真机 pending，用户延后并授权持续适配/发布。
- 排除 PPT 绘图、Dev Containers、Intel Mac、Actions、zlinkw.shop、历史附件自动清理、开发机自动安装。
- 保护三拓扑、业务 API、Plan 格式、远端实验、删除直接父目录校验/两次确认及原入口。
- 每批至多 3 个相关问题、8 个源/文档/测试文件；测试单文件串行/20 秒，Python AST 隔离/10 秒；build/包闭包/面板语法门禁。
- 文档节奏按用户最新要求：集中推进功能，累计到阶段完成后统一更新 README/配置说明；实际入口或操作方式改变时，仅同步必要说明。文档仍按 Mac 用法、优先于配色；不再把每轮文档同步作为独立交付重点。汇报以实际功能变化、修复及验证结果为主。更新入口：底部右侧 Mac preview、命令面板检查 preview 配套更新、设置→插件配套更新→检查更新。

## 当前批次 mac-release-040（passed，0.5.303/0.2.96）
- 源码f22544521b3a52b645c42f6f272344fba9d29aeb已普通提交推送/fetch相等，SFca2ddc26a5fe634c0498f01feebfb046503dbe2c同步干净；重读事实/计划/版本/门禁/包runner，无活动测试过程。
- 范围4文件：Exp package/lock/runtime/计划，仅Exp递增补丁；SF无功能变化保持.96，配套清单仍含两包及真实提交。完整78串行目标、十九实际VSIX、源快照/草稿附件与匿名.302/.96→.303/.96仅Exp待更新、SF同版跳过。保护旧入口/三拓扑/科研/未确认删除，不安装开发机扩展、不触发Actions。
- README/配置按用户要求累计阶段更新；完整导出、原子写入、归档执行/revision证明及M5仍pending。下一边界为样本分析导出原始路径与受检表输入，至多3问题/8文件。

- passed metadata两仓build/runtimeManifest1/225与26闭包/面板2/vm.Script/UTF8/diff，mac-release-040-metadata.log；Exp package/lock/runtime为.303，SF保持.96。下一步完整串行prepare、十九实际包及匿名同版跳过验证。

- passed 完整prepare78目标文件/79含面板标记，20秒单文件串行，两仓build/闭包/面板/vm.Script/主题门禁，无超时，prepare-0.5.303.log。十九实际VSIX含新增case8及三个真实请求AST→编译回执，保留既有十八报告；只捕获发布，无整Agent/科研/SSH/删除或安装。
- 源码批f22544521b3a52b645c42f6f272344fba9d29aeb、发布来源Expacaa9840861ea6082d62b457172ac11bbe72c18f/SFca2ddc26a5fe634c0498f01feebfb046503dbe2c均已普通推送/fetch相等。真实保留快照SF82源/25包原字节、Exp1538源/418包原字节，仅正式VSCE package/README转换和CHANGELOG改名。
- 已发布 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.303，releaseId408595159；草稿三附件集合/大小/hash后公开。passed匿名.302/.96→.303/.96：42公开请求，实际PreviewReleaseClient只列Exp待更新，SF同版跳过，同时下载核验两包字节等于十九受检VSIX；prerelease/清单/身份/平台/VS Code/CRC/大小/SHA-256及源文件对应、同版跳过/禁止降级通过。anonymous-verification.json/十九包报告/快照保留。M5继续pending。
- 下一批mac-005am-case-export：样本分析导出仍normalize Plan与旧slug表路径，受检读取/三入口已局部完成；至多3问题/8文件，保留原始Plan/revision、当前子组表输入和导出回执/路径。保护旧入口/三拓扑，不执行科研/SSH/删除；README/配置集中阶段更新，不再单独插文档批。完整报告原子性、归档/revision内容、其他运行/写操作及M5仍pending。

## 前批 mac-005al-case-read（passed）
- 前轮progress：文档节奏修订47a8736已同步；.302/.96已完成77串行目标、十八实际包和41匿名请求。无活动测试/发布过程，起始Exp47a8736与SFTPca2ddc26a5fe634c0498f01feebfb046503dbe2c干净且fetch确认master相等。新用户AGENTS、事实/计划/实际case路径、读取与入口重读。
- 范围7文件：case受检输入、Agent三入口与请求身份、真实AST/编译消费者Node/Python回归、prepare门禁/发布说明、门禁回归及计划。三问题：原始Plan/revision与发现集合；实际CSV/UTF8/行归属；泄漏/子组使用当前可信样本、不借缓存全局索引。保留旧默认入口/统计实现/API/三拓扑；没有科研/SSH/归档删除或开发机安装。
- 依据最新文档节奏，本批操作入口不变，README/配置累计后集中更新；代码验证后发布.303，SFTP源码与版本不变则保留.96并验证相同版本跳过。科研/M5、完整导出/写入原子性与revision证明仍pending。

- passed build/225闭包/面板2/vm.Script/UTF8/diff，新样本8、发布门禁4、分析8/claim8/聚合8/归档8/解析9/读取7/契约7及四个既有结果界面回归，单文件20秒/Python10秒串行，mac-005al-final.log。首次6/8及随后7/8失败为fixture把末尾空格改为字面%20后缀、glob漏原文件名首空格；修正真实输入后8/8，未放宽生产校验/超时。
- 原始Plan/revision、实际CSV/config/jobs/插件策略及缺失输入、发现集合在发布前受检；全局缓存不再借给指定Plan，空样本泄漏warning/子组empty。实际三请求AST分支和编译回执消费者通过；只捕获发布，完整多文件原子性/导出/revision内容/M5仍pending。范围7文件，文档按阶段集中，下一批仅Exp版本.303，SF.96保持并测试同版跳过。

## 前批 mac-release-039（passed，0.5.302/0.2.96）
- 范围6文件：两仓package/lock、Exp runtime/计划。文档Exp d3840a06518607d942848f9a14bef5ddfcdceb17/SFTP6a7537468b64d363ed04d2cf5cff4bc274262d1b普通推送/fetch相等，起始干净；事实/计划/版本/门禁和实际包runner重读。
- 递增版本保留原格式，metadata验证后普通提交推送；完整77串行目标、十八实际VSIX含新分析8、快照/完整草稿附件与匿名.301/.95→.302/.96。无Actions/自动安装/科研/SSH/归档删除，M5延后。
- 下一边界：其他Agent结果动作仍旧路径/读取，完整报告发布/归档执行/revision内容和物理原子锁定继续分批。

- passed metadata两仓build/runtimeManifest1/225与26闭包/面板2/vm.Script、版本一致/UTF8/diff，mac-release-039-metadata.log。下一步完整prepare77目标串行、十八实际VSIX、快照与匿名更新核验；M5继续pending。

- passed 完整prepare77目标文件/20秒串行，78含面板标记；两仓build/225与26闭包/面板2/vm.Script/浅深高对比，prepare-0.5.302.log exit0，无超时。
- passed 十八实际VSIX：新增实际质量/统计/论文表→编译摘要消费者8；保留claim8/项目8/归档8/解析9/读取7/契约7和既有十一回执/解析/读/映射/摘要/YAML/候选/结果/CLI/启动/结果链报告。全部绑定来源与hash，发布executor捕获，没有整Agent/科研/SSH/归档删除或安装；完整执行/报告原子性仍pending。
- passed 保留源快照与实际包：SFTP82源/25原字节包文件，Exp1534源/417原字节包文件；仅正式VSCE package/README转换与CHANGELOG改名。来源Exp2aa52511813aa944c2cf68af717ad29aab025c19/SFTPca2ddc26a5fe634c0498f01feebfb046503dbe2c已普通推送/fetch相等。
- 已发布 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.302，releaseId408572983，草稿三附件集合/大小/hash核验后公开。passed 匿名.301/.95→.302/.96：41公开请求，prerelease/清单/身份/darwin-arm64/VS Code要求/大小/SHA-256/CRC，下载字节等于十八受检包；README/配置/新分析模块/生成Agent对应来源，同版跳过/禁止降级。anonymous-verification.json及快照/十八包报告保留。
- 下一代码批mac-005al-case-read：样本级发现/解析、泄漏与子组读取仍normalize Plan、errors=replace且借旧全局index。至多3相关问题/8文件，保留原始Plan与来源、受检CSV/index、现有统计计算/API/三拓扑；不执行科研/SSH/归档删除。完整claim生成表关联、分析导出共用输入预算与报告原子发布、归档执行、revision内容证明及M5仍pending。代码后先同步Mac README/配置，再配套发布。

## 前批 mac-doc-032（passed）
- 范围6文件：两仓README、Mac配置、prepare/发布门禁回归和计划。代码来源eb7197917417dfae2d9fa06e48196437a7ce5047已普通推送/fetch相等；SFTP068ec5fe6244f5d8e4b7d7152764773631a84d96同步干净，事实/计划/实际入口与门禁重读。
- 补结果区质量门禁→统计→论文表步骤、当前来源/配置/归档与失败重解析、近似统计复核和写入限制；安装/更新/Termius/认证/CLI/三拓扑入口保留。新分析8加入77串行目标，不宣称M5/科研/原子发布已验收。

- passed 两仓build/225与26闭包/面板2/vm.Script、Mac配置1/发布门禁4、脚本语法/UTF8/diff，mac-doc-032.log。文档编辑器首次变量重复语法错误未执行任何修改，另存修正脚本后完成；未改变门禁或超时。下一批 .302/.96 配套发布，科研/M5/原子发布仍pending。

## 前批 mac-005ak-analysis-read（passed）
- 起始Exp a0d00c9bec05a620aa7ec9d0e2e665cedcca320f/SFTP068ec5fe6244f5d8e4b7d7152764773631a84d96干净，master=origin/master已fetch确认；重读事实/计划/实际质量、统计、论文表、claim/归档输入与隔离回归。
- 范围6文件：共享真实记录只读模块、claim共享调用、Agent三个分析入口、实际隔离Node/Python回归与计划。三问题为原始Plan/revision/报告路径、当前CSV/配置/归档重计算、报告输入发布前受检；沿用统计计算，不把fixture视为科研证据。
- 保护旧入口/API/三拓扑/Plan格式；不执行整Agent/科研/SSH/归档删除/安装。摘要缺失/旧协议仍由既有解析迁移；多文件原子发布、完整revision与M5 pending。代码验证后同步Mac README/配置与配套发布。

- 首轮新实际回归7/8，旧默认入口fixture缺真实旧格式归档，仅补实际归档文件后8/8；未放松生产断言、没有超时。随后补当前归档来源新增行必须重解析，build/新8/claim8再次passed。
- passed build/225闭包/面板2/vm.Script/LF/UTF8，新分析8/claim8/项目8/归档8/解析9/读取7/契约7及4个面板证据回归，20秒串行/Python10秒；日志mac-005ak-final-66eb8875-c662-4228-b09a-5f3c92906565.log与followup-c23af941-77d0-42a0-b7d1-308d002bac46.log。仅真实AST和编译消费者、本机文件及捕获发布，无科研/SSH/归档删除/安装。
- 下一批mac-doc-032同步两仓README/配置、真实分析门禁和发布说明，再配套.302/.96；完整报告原子性/revision/归档执行/M5仍pending。

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
