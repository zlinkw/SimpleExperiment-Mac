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

## 当前批次 mac-005ag-agent-parse（passed）
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

### 已接入本批边界 mac-005ag-agent-parse
- 限指定 Plan 的 parse_results_action 原始声明/候选/受检读取与报告身份，复用本批只读输入边界；至多 8 文件/3 相关问题，真实生成函数隔离与实际编译消费验证，保留原入口/API/Plan 格式/三拓扑。其他运行/写操作、删除/归档、原子写入、完整 revision 内容/M5 不扩入；README/配置优先同步，再通过同一配套通道发布。

### 前批 mac-doc-027（passed）
- 范围 6 文件：两仓 README、Mac 配置说明、prepare/发布门禁回归与计划。优先同步指定 Plan 输出契约的真实 YAML/原始路径/5 MiB UTF8 快照读取、失败处理与主动 Agent 升级入口，并将新产生端 7 项纳入串行发布门禁。
- 起始 Exp `bb9a5988e81d0c31ab848c4151a1412dcf3760ea`/SFTP `7cce33b150473f46a804611f67a0ae465838aeb3` master 同步、工作区干净；事实/计划/README/配置/门禁重读。代码批已提交推送并 fetch 相等；此前计划编辑首个 shell Python 命令引号失败，未写文件，改用 UTF8 stdin 后通过。
- passed 两仓 build/225 与 26 闭包/面板 2、Mac 配置 1/发布门禁 4 串行、严格 UTF8/更新入口/发布脚本语法/diff；实际 M5、完整 revision 内容、其他动作与原子写入仍 pending。下一批仅配套 metadata/prepare/真实包/匿名下载发布。

### 前批 mac-005af-agent-result（passed）
- 范围至多 7 文件：独立 Agent 输出契约读取模块/原始候选接线、共享真实 NTFS/POSIX 描述符 fixture 桥接及原回归接入、新隔离 Python/实际编译消费回归与计划。三个关联问题：不 trim/修复路径或把坏类型变成字符串；真实 Plan YAML/命令/明确 job 的声明与有界 glob 保留大小写/Unicode/真实空格；同一受检 UTF8 描述符快照交给既有 CSV/JSON/text 解析，读取/解析后核验身份，原入口兼容。
- 首次既有产生端回归 4/7，Windows CRT 文本 fd 读少了 CRLF 字节，且 Python lstat 的 creation time 与 fstat 的 change time 语义不同；真实原生元数据观测证实。仅调整本机 POSIX fixture 的二进制 fd 与真实 NTFS ChangeTime 映射，保持生产原始大小/身份/ctime 断言，不按失败降低门禁；原回归 7/7 与新回归 7/7 均通过。
- 起始 Exp `5075d8595586e90932b81fe545c31378482d7b93`/SFTP `7cce33b150473f46a804611f67a0ae465838aeb3` 干净且 master=origin/master；事实/计划/候选/实际解析/YAML scheduler 依赖与回归重读。前批 progress：.296/.90 实际包、快照、公开下载发布完成，无活跃进程。PyYAML 为既有科研环境依赖，严格读取不回退损坏或不支持 YAML。
- passed build/225 包闭包/面板 2/vm.Script/LF、新实际读取产生端→编译消费 7、既有 Agent 7/回执 8/结果身份 8/Agent Plan 5；单文件串行20秒、隔离 Python10秒，无超时。最后一轮输出因上下文截断不可读，核实进程已退出后保留完整门禁日志 mac-005af-final-gates-4f77fbec26984721baa1f8f32cf097e2.log 重新核验通过；无整个 Agent 执行、真实科研/SSH/传输/安装/删除。其他动作、归档、原子发布/完整 revision 新鲜度/M5 不扩入；下一批先同步两仓 README/配置/门禁，再配套发布。

### 前批 mac-release-033（passed，0.5.296/0.2.90）
- 范围 6 文件：两仓 package/lock、Experiment runtime/计划。mac-tool-003 `4f0f295707f0f142e852184e162e92c81b7a3547` 与 SFTP `0abf9794021d3bd86e8af61478fe8b7e4d0db06c` 已普通推送/fetch 相等，工作区干净；重读事实/计划/来源/版本。失败 .295/.89 未发布、证据保留，改用更高版本和新目录。
- pending metadata build/闭包/面板/runtime，再完整 prepare/实际包十二份（新增 Agent 产生端 7）/匿名 .294/.88→.296/.90；核验完整三附件草稿后发布。无 Actions/安装/真实科研，M5 延后；原 Plan 结果读取与其他回执/写动作下一批。
- passed 新 metadata：两仓 build/225 与 26 闭包/面板 2/vm.Script、runtimeManifest 1、package/lock/runtime 一致、UTF8/diff；提交来源后完整 prepare 待执行。
- passed 完整 prepare：两仓 build/225 与 26 闭包/面板 2/vm.Script、71 目标文件串行/20 秒，72 含面板标记；新增 Agent 7/快照 8、真实浅深高对比通过，无超时。日志 release-artifacts/prepare-0.5.296.log exit0；真实 pinned VSCE 保持 Experiment ignore/SFTP files，全部字节/集合/来源前后校验后打包。
- passed 实际 VSIX 十二份：Agent 产生端→编译候选/reducer 7、回执 8/解析 8/读取 8/映射 11/摘要 7/YAML 7/候选 6/结果 8/CLI 2/启动 8/结果链 6，所有报告绑定两来源/包 hash；本机/模拟/隔离 AST，无真实科研/SSH/远端启动/停止/删除/安装。额外快照与包对应检查：SFTP 82 源文件/25 原字节包文件，Experiment 1509 源/411 原字节包文件；仅 VSCE package/README 正式转换，CHANGELOG 官方改名但字节一致。附加验证初次误计 SFTP 数量及 CHANGELOG 名称，按真实 CLI 规则核验后通过，无生产或测试门禁放松。
- passed .294/.88→.296/.90 匿名 updater：35 公开请求，清单/有效 prerelease/大小/hash/CRC/身份/darwin-arm64/VS Code 要求；下载字节等于十二份实际测试包，全部业务模块、两仓 README/包内 Mac 配置及发布说明匹配同步来源，同版本跳过/不降级。包源快照证明与匿名下载互相绑定；未实际安装/M5。
- 已发布 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.296，完整三附件草稿核验后公开，releaseId 408439949；来源 Exp `5d6c21b74c44cda98e7a570caaf0831dc68ea80c`/SFTP `7cce33b150473f46a804611f67a0ae465838aeb3` 均已普通推送/fetch 相等。历史 .295 失败证据及所有旧附件保留；无 Actions/自动安装。

### 已完成近期批次（详细失败与证据见 Git 和保留的 release-artifacts）
- mac-tool-002 `ed5f6fa57e8fecc8182fff1eff97dd6b72d0fc7e`：真实 pinned VSCE 源快照/字节/身份/集合验证，解决旧 collectAllFiles 扫描保留附件的 8 秒超时，不扩大预算/不清理。
- mac-005ae-agent-contract `0b27d0e3885bbf2beed0cb938764f8b3c70f98d2`：完整 Plan/revision 请求、报告、事件与明确 jobs 归属；隔离 Agent→编译消费 7/回执 8/结果身份 8/Agent Plan 5、本地 build/225/面板通过。
- mac-doc-026 Exp `ffee575f5714fdbbfa6c79fbf92f375324d9a8e9`/SFTP `363a13a5a3ada307ff3f2cc49018197614d3ef9a`：README/配置/门禁同步，通过本地构建与文档验证。
- 未发布 .295/.89：Exp `f9d988dd44642d8a9100478c3ab8760e60f6bee9`/SFTP `0abf9794021d3bd86e8af61478fe8b7e4d0db06c`；71 串行测试通过，但打包源快照错误强制 SFTP .vscodeignore，prepare 失败，日志与空目录保留。
- mac-tool-003 `4f0f295707f0f142e852184e162e92c81b7a3547`：保留 SFTP 原 package.json.files 缺省规则，真实 CLI/快照 8/225 闭包与发布门禁通过，不放松生产校验；后续 .296 实际打包通过。以上均普通推送/fetch 等于 origin/master。

### 已交付 .294/.88 与压缩历史（passed，完整证据见 Git）
- .294 来源 Exp `1dd2e0a80adc8a29b7ae5310c03d197d5214459e`/SFTP `8cceeee9ee706fc5cf25d3df66c02070f8386950`；交付 `02a425ccb84e7ad1fce5313c792d93596000a759` 已推送/fetch 相等。69 文件串行 prepare/build/225 与 26 闭包/面板/浅深高对比；十一份实际 VSIX（回执 8/解析 8/读 8/映射 11/摘要 7/YAML 7/候选 6/结果 8/CLI 2/启动 8/结果链 6）、34 公开匿名请求 passed。仅本机/模拟/AST，M5 pending。
- .287 至 .293 来源/交付已普通推送，完整测试/失败修复与证据见对应 Git 版本及保留的 release-artifacts。一次旧 E2E 基线重现，后续实际编译替代；包测试上下文与报告聚合断言修正，无生产放松。保留更新、路径、Plan/启动/结果身份、摘要/候选/受检读写与解析、手动端点/认证/双 SSH 本机中转、README/主题交付；旧入口/三拓扑/删除确认边界受保护。
- 历史分批实际提交、原失败与验证命令已随对应版本保存于 Git；最新来源与交付提交在本计划明确记录，未改写历史。

## 未完成与下一边界
- pending mac-005：其他运行/写操作回执来源授权、映射原子下载发布、Webview 行字段序列化、其他 Agent 结果动作的路径/YAML/读取、完整 Mac 本机解析与来源、归档、其余 Windows 专属业务依赖，逐批适配。输出契约 Plan 产生端局部完成不代表这些链路已验收。
- 物理检查与启动/写入间尚非原子锁定，其他 Agent 动作的 YAML 与 suite/config 等其他 scalar 不在本批证据内。
- pending mac-006：真实 M5 首装→更新/设置保留/重载/部分失败补装；Termius、独立密钥/密码传输/中文路径/断连；单 Worker、多 Worker、Hub/Worker科研主流程。
- 本地更新链路、VM/AST 与 headless 通过不能宣称完整科研或 M5 验收。用户延后真机验收，不阻塞可继续的本地适配。
