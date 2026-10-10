# 目标模式当前计划：mac 适配，更新发布优先
字符上限 12000，达到 10800 自动压缩。保留目标、验证、风险、下一批边界和真实提交记录；完整历史见 Git。

## 固定边界
- 当前目标：独立 darwin-arm64 preview 扩展、配套更新、本机 Releases 发布及完整 mac 科研业务适配。
- 公开 SimpleExperiment-Mac、SimpleSFTP-Mac，普通提交推送 origin/master；Windows 项目独立。
- 支持 Apple Silicon/macOS 26+；M5/24 GB/macOS 27.0 真机 pending，用户延后并授权持续适配/发布。
- 排除 PPT 绘图、Dev Containers、Intel Mac、Actions、zlinkw.shop、历史附件自动清理、开发机自动安装。
- 保护三拓扑、业务 API、Plan 格式、远端实验、删除直接父目录校验/两次确认及原入口。
- 每批至多 3 个相关问题、8 个源/文档/测试文件；测试单文件串行/20 秒，Python AST 隔离/10 秒；build/包闭包/面板语法门禁。
- README/配置说明按 Mac 用法持续同步，优先于配色。更新入口：底部右侧 Mac preview、命令面板检查 preview 配套更新、设置→插件配套更新→检查更新。

## 当前批次 mac-release-036（passed，0.5.299/0.2.93）
- 范围6文件：两仓package/lock、Experiment runtime/计划。文档Exp `95856c8568e56c8fdf3987ba890d3361b83a1343`/SFTP `97e104e58930a085eda466e7dd8d66c95694955e`均普通推送/fetch相等；两仓干净，事实/计划/版本/门禁重读。
- passed metadata 两仓build/225与26闭包/面板2/vm.Script、runtimeManifest1、package/lock/runtime一致与UTF8/diff；日志 mac-release-036-metadata-d69614cc-66d3-4b18-85c3-6b1a0ecbc861.log。完整prepare/实际VSIX/发布和匿名下载仍待本批后续验证。
- 验证 metadata/build/闭包/面板/runtime一致性，源码同步后完整prepare74目标串行20秒、十五份实际VSIX（新增只读归档8）/快照/草稿完整附件/匿名更新。不得覆盖历史版本，无Actions/自动安装/实际科研/归档删除执行，M5延后。下一代码批仅跨Plan聚合与claim读取来源。

- passed 完整prepare74目标文件/20秒串行、75含面板标记、两仓build/225与26闭包/面板2/vm.Script/真实浅深高对比；日志 prepare-0.5.299.log exit0，无测试超时。辅助日志检查首轮误将命令中的 --test-timeout 匹配为失败，改按真实失败标记与退出码核对，未重跑或放松生产门禁。
- passed 十五份实际VSIX：新增只读归档证据/真实解析→编译表8；既有解析9/读取7/输出契约7/回执8/解析8/读8/映射11/摘要7/YAML7/候选6/结果8/CLI2/启动8/结果链6。实际生成Agent、新ArchiveEvidenceRead/ResultParseInputs/编译表及文档字节对应受检包，报告绑定两来源与hash；隔离AST/POSIX、本机文件和捕获发布，不执行整个Agent、科研、SSH、归档删除或安装。
- passed 源快照/实际包：SFTP82源/25原字节包文件，Exp1522源/414原字节包文件；只有正式VSCE package/README转换及CHANGELOG改名。历史附件保留。
- 已发布 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.299，releaseId408490784，三附件草稿集合/大小/hash核验后公开；来源Exp `cb2e182e03c81614bd4b0f1749be58c1e0f03130`/SFTP `8113c9deea20c38e1b8399b3a6806ef087769749`已普通推送/fetch相等。
- passed 匿名 .298/.92→.299/.93：38公开请求，prerelease/清单/身份/darwin-arm64/VS Code要求/大小/SHA-256/CRC，下载字节等于十五份受检包。新归档模块/生成Agent/两仓README/包内Mac说明对应来源，同版跳过/不降级。M5更新/科研验收仍pending，用户延后；完整归档执行与跨Plan聚合后续继续。

## 前批 mac-doc-029（passed）
- 范围6文件：两仓README、Mac配置说明、prepare/发布门禁回归及计划。按真实Mac操作重整结果说明，收拢历史技术叙述；保留安装/更新/Termius/认证/CLI入口。
- 起始 Exp `852d7e08c7e91898ce7e0f1eab6fb90318d8a013`/SFTP `2006c5b49bb28c57a124938aff456fcef7d6de98`，两仓master干净，普通推送/fetch相等；事实/当前计划/README/配置/实际入口与发布门禁已重读。
- passed 两仓build/225与26闭包/面板2、Mac配置1/发布门禁4、脚本语法、UTF8/diff；日志 mac-doc-029-90051e8b-e269-43ad-a2b3-0dd6abeb316e.log。结果说明重整为操作步骤/路径示例/旧归档不足处理，保护入口；跨Plan聚合/完整归档执行/原子写入/M5继续后续。
- 先更新使用说明：明确解析步骤、原始路径、旧归档身份不足与失败处理，逐seed/跨Plan聚合/归档写入及M5边界；新增实际只读归档8项纳入串行发布门禁。

## 前批 mac-005ah-archive-read（passed）
- 起始 Exp `86fabf48bcfe00d9dc9e924c90ac812c936ada03`、SFTP `2006c5b49bb28c57a124938aff456fcef7d6de98`，master 与工作区重读，干净。事实/计划/实际归档状态协议、结果行协议及隔离回归已重读。
- 范围至多6文件：独立只读归档证据模块、Agent接线、结果行受支持的 `plan` 别名、实际生成函数隔离 Node/Python 回归及计划。三个关联问题：归档状态/条目的原始 Plan 与 revision；产物键及受检来源；缓存归档标记不能绕过当前证据。旧归档写入和删除执行器不修改、不运行，原入口/API/三拓扑保留。
- 跨 Plan 聚合读取顺延下一代码批。完整原子写入及 M5 仍 pending；先同步 README/配置/发布门禁，再配套发布。
- 新隔离 Python 八场景首轮均通过，Node 7/8 因 fixture 未提供实际拓扑的 Worker 归属而缺少正式表登记；按既有真实请求 ownership 修正 fixture 后 8/8，通过真实编译消费者，生产门禁未降低。
- passed build/225闭包/面板2/vm.Script/LF，新归档证据8、解析9及既有读取7/输出契约7/结果身份8/回执8；20秒串行/Python10秒无超时。新增旧格式当前摘要重新解析，保留只读旧摘要入口；最终门禁日志 mac-005ah-final-cc923a5d-b5a7-440e-8351-24102dffdfd8.log、回归 mac-005ah-regressions-7994644a-de46-45ba-af27-0a92c68fc523.log。最后补空Plan前置拒绝后build/新8/解析9/闭包再次核验。
- 代码已提交推送 `852d7e08c7e91898ce7e0f1eab6fb90318d8a013`，fetch等于origin/master；无活动测试进程。
- 下一批 mac-doc-029：两仓README、Mac配置、prepare/发布门禁及计划，说明旧归档只明确同一原始Plan/revision才进入统计，归档执行/跨Plan聚合/M5仍未验收；随后配套 .299/.93。

## 前批 mac-release-035（passed，0.5.298/0.2.92）
- 范围 6 文件：两仓 package/lock、Experiment runtime/计划。文档批 Exp `765b222667bb6c5d750f3806c81a6395e3970869`/SFTP `79185c7b4c5dae4e571d440a39f9b562369ddc54` 已普通推送/fetch 相等，两仓干净；事实/计划/版本及门禁重读。
- passed metadata 两仓 build/225与26闭包/面板2/vm.Script、runtimeManifest1、package/lock/runtime一致/UTF8/diff；来源同步后完整 prepare73目标文件/串行20秒、十四份实际VSIX（新增实际解析9）与快照对应，再完整三附件草稿核验发布及匿名 .297/.91→.298/.92 下载。不得覆盖历史版本/附件，无 Actions/自动安装/真实科研；M5延后。下一边界限旧归档证据读取与聚合身份，保留完整目标。

- passed 完整 prepare：两仓 build/225与26闭包/面板2/vm.Script、73目标文件串行20秒/74含面板标记；新解析9、既有Agent输出契约7/读取7/快照8，真实浅深高对比通过。日志 prepare-0.5.298.log exit0，无测试超时。
- passed 十四份实际 VSIX：新解析/三动作实际 handler 分支/摘要读回→编译表9、读取产生端7/契约产生端7、回执8/解析8/读取8/映射11/摘要7/YAML7/候选6/结果8/CLI2/启动8/结果链6。实际生成 Agent、ResultParseInputs/编译表/文档字节对应当前受检包，报告绑定两来源/包hash；Python AST隔离、本机真实NTFS/POSIX与捕获发布，无整个Agent执行/真实科研/SSH/远端启停删除/安装。完整归档和跨Plan聚合仍pending，不把受控fixture聚合当作科学验收。
- passed 源快照/实际包对应：SFTP82源/25原字节包文件，Exp1518源/413原字节包文件；只有VSCE正式package/README转换与CHANGELOG改名，历史附件保留。
- 已发布 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.298，releaseId408474609；完整三附件草稿集合/大小/hash核验后公开。来源 Exp `7d29548990cab73ca8e5cd0dff48caaabbf4fb85`/SFTP `2006c5b49bb28c57a124938aff456fcef7d6de98` 均已普通推送/fetch相等，无Actions/自动安装。
- passed 匿名 .297/.91→.298/.92：37公开请求，有效prerelease/清单/大小/SHA-256/CRC/身份/darwin-arm64/VS Code要求；下载字节等于十四份受检VSIX，新解析模块/生成Agent/两仓README/包内Mac配置与发布说明匹配同步来源，同版跳过/不降级。M5真实更新/科研验收仍pending，用户延后。

### 后续代码批 mac-005ai-project-read（pending）
- 至多8文件/3相关问题，仅跨Plan聚合/claim读取来源与明确原始Plan/产物身份。归档只读证据与结果行受支持 plan 别名已局部适配；保留旧/新入口及三拓扑，不改删除/归档执行，不执行实际科研/传输/远端命令。完整原子写入、其他运行/写回执及M5继续后续；README/配置同步优先，再配套发布。

### 前批 mac-doc-028（passed）
- 范围 6 文件：两仓 README、Mac 配置说明、prepare/发布门禁回归与计划。同步结果区解析/刷新指定 Plan 的真实选择、空选择不扩大范围、原始结果行归属与受检摘要读回，明确 Agent 手动升级/失败处理及逐 seed 表验收边界；新隔离实际 9 项纳入发布串行门禁。
- 起始 Exp `13cfff57f77b834a8d25bcd92372f894041f1164`/SFTP `35731fa41a8d9f1d8aa8e342b95ad3d7c5feede5` master 已同步且干净；事实/计划/README/配置/实际面板标签/门禁重读。前批仅局部产生端/受检读取与摘要 key 完成，归档/完整聚合/M5 不宣称通过。
- passed 两仓 build/225 与26闭包/面板2/vm.Script、Mac配置1/发布门禁4、文档严格UTF8/更新入口/新使用边界与发布脚本语法/diff；下一批配套版本 .298/.92 与完整 prepare/实际VSIX/匿名更新发布。

### 前批 mac-005ag-agent-parse（passed）
- 范围至多 7 文件：共享 POSIX fixture 的实际目录创建桥接、独立严格结果解析输入模块、Agent 接线、完整 YAML 内部文档返回、隔离实际 Python/编译消费者回归和计划。三个关联问题：parse/refresh/rescan 请求及明确选择/job 原始身份；指定 Plan 真实声明/策略与受检读取/行归属；解析摘要、事件和 Plan 独立输出命名空间不借修复路径。
- 起始 Exp `8c2c387ae08339a72830650202c1ecaa275a4191`/SFTP `35731fa41a8d9f1d8aa8e342b95ad3d7c5feede5` master 同步、两仓干净；事实/计划/实际源码/现有回归重读。前批 progress：.297/.91 实际包/匿名公开下载/发布完成，无活跃过程。保护其他动作与原入口/API/三拓扑，不执行整个 Agent/真实科研/SSH/传输/删除/安装。
- 初轮隔离 Python 8 个场景均退出成功，Node 总体 2/8，原因是回归误写 TS key 导出名；按真实 planDirectoryKey 修正，不改生产身份断言。后续 Node 4/8、7/8 暴露回归错误假定 JSON/空结果可直接登记逐 seed 表，按实际编译表消费者明确拒绝的契约修正断言，生产没有放松。共享 helper 的 makedirs 现在映射真实 fixture 根，避免在虚拟 /fixture 创建目录；早期证据保留，不执行清理。
- passed build/225 闭包/面板 2/vm.Script/LF，新实际解析/三动作真实 handler 分支/摘要读回→编译表消费 9、既有 Agent 读取 7/输出契约 7/结果身份 8/回执 8，单文件串行20秒/隔离 Python10秒无超时；日志 mac-005ag-final-gates-4e58335ef5ca4256b8e0b4a37361115a.log。追加旧摘要同一受检描述符与精确 Plan 兼容读回后 build/225/新 9 再次通过。完整聚合/归档读写、revision 内容与原子写入/M5 后续继续，不以局部快照代表全科研。下一批 README/配置/门禁同步后配套发布。

### 前批 mac-release-034（passed，0.5.297/0.2.91）
- 范围 6 文件：两仓 package/lock、Experiment runtime/计划。文档批 Exp `0924896882fe97031337c9400c3a4afcf2d4e82e`/SFTP `735f16fa99567ac0d30b79198cc7cf2d601295c4` 已普通推送/fetch 相等，工作区干净；事实/计划/版本及门禁重读。
- passed metadata 两仓 build/225 与 26 闭包/面板 2/vm.Script、runtimeManifest 1、package/lock/runtime 一致/UTF8/diff；初次误用不存在的 runtimeManifestConsistency 文件，未启动测试，定位真实 test/runtimeManifest.test.js 后通过。来源提交同步后完整 prepare 72 文件串行20秒、实际 VSIX 十三份（新增读取产生端 7）及快照对应验证，完整三附件草稿核验后发布并匿名 .296/.90→.297/.91 下载。不得覆盖旧版本/附件，不触发 Actions/自动安装/真实科研；下一边界限其他 Agent 结果动作，M5 延后。

- passed 完整 prepare：两仓 build/225 与 26 闭包/面板 2/vm.Script、72 目标文件串行20秒/73 含面板标记，新增 Agent 读取 7/既有 Agent 7/快照 8；真实浅深高对比通过，日志 prepare-0.5.297.log exit0，无测试超时。
- passed 实际 VSIX 十三份：读取产生端→编译消费 7、请求/报告/事件产生端 7、回执 8/解析 8/读取 8/映射 11/摘要 7/YAML 7/候选 6/结果 8/CLI 2/启动 8/结果链 6。所有报告绑定同步来源/包 hash，包内实际生成 Agent 与 compiled 模块及文档字节匹配；共享真实 NTFS/POSIX helper 一并用于隔离测试。无整个 Agent 执行/真实科研/SSH/远端启动停止删除/安装。快照对应验证：SFTP 82 源/25 原字节包文件，Exp 1514 源/412 原字节包文件，只有 VSCE 正式 package/README 转换与 CHANGELOG 改名。
- 已发布 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.297；releaseId 408458524，完整三附件草稿大小/hash/集合核验后公开。来源 Exp `406d87a63d9aa2dbfd706189d311de5e5bbe0b3a`/SFTP `35731fa41a8d9f1d8aa8e342b95ad3d7c5feede5` 均已普通推送/fetch 相等；历史资产保留，无 Actions/自动安装。
- passed 匿名 .296/.90→.297/.91：36 公开请求，prerelease/清单/大小/SHA-256/CRC/身份/darwin-arm64/VS Code 要求，下载字节等于十三份受检 VSIX，新读取模块/生成 Agent/两仓 README/包内 Mac 配置与发布说明匹配同步来源；同版跳过/不降级。M5 更新/科研验收仍 pending，用户延后。

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
