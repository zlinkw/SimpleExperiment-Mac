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

## 当前批次 mac-doc-021（passed，摘要归属使用说明/门禁）
- 本批 6 文件：两仓 README、配置说明、prepare/发布门禁测试与计划；更新摘要归属/匿名来源说明、保留更新入口，新增摘要/缓存门禁。不扩展业务源范围。
- mac-005y-summary `173bd71c476d36b7e6038a394ba4e2f96153da3f` 已普通推送/fetch 核对 origin/master。
- passed build/222 闭包/面板 2/vm.Script、配置说明 1、发布门禁 4 单文件串行，三份 Mac 文档 UTF8/更新入口/归属边界与 diff；下一批版本元数据、prepare/publish、实际包/匿名更新。映射传输去重和物理发布仍待后续批次。

### 前批 mac-005y-summary（passed）
- 本批仅 Mac 摘要/完成结果的原始 Plan 身份、嵌套记录归属及浅查看/同步候选授权，最多 5 源/测试/计划文件；改写修复别名与隐式继承，不运行科研/SSH/传输/删除。回归真实编译函数、结果缓存/查看/完成结果工作流、build/闭包/面板语法。映射传输的去重/本地物理发布、Agent/完整 YAML 后续批次。
- mac-release-025 交付记录 `2ff50131c2204fce96fffc21c78fc6353f55dd40` 已推送/fetch 核对 origin/master。
- passed 4 文件：新 ResultSummaryScope、后台筛选/缓存/候选入口、新 macResultSummaryScope 测试与计划。Mac 顶层/记录/provenance/Worker/数据集/完成 job/claim 的 Plan 别名一致；匿名和混合分析产物不授权，保留明确归属的记录与表，不修写路径/类型；缓存元组避免 | 碰撞。非 Mac 原入口保留。
- passed build/222 闭包/面板 2/vm.Script/UTF8/diff；macResultSummaryScope 7、resultsSummaryWebviewCache 6、macResultIdentity 8、remoteResultInspectionWorkflow 13、projectResultSyncCompleteness 18、manualDistributedResultSync 25，单文件串行 20 秒，无超时。新 VM fixture 补齐实际 FileTransferTypes/WrapperResultBundle 导入后通过。
- 下一批仅两仓说明/发布门禁，再版本递增/配套发布与实际 VSIX/匿名更新；后续映射去重与物理发布分批，不宣称传输/完整科研/M5 验收。

### 前批 mac-release-025（passed，0.5.288/0.2.82）
- 本批 6 文件以内：两仓 package/lock、Experiment runtime/本文档；版本验证后普通推送，prepare/publish 绑定同步源码，实际 VSIX/匿名更新核验后交付，不 Actions/安装。
- passed 版本门禁：两仓 build、221/26 闭包/面板 2/vm.Script、runtimeManifest 1、元数据/diff 一致；最初测试文件目录误写未启动，改为实际 test/runtimeManifest.test.js 后通过。
- passed 完整 npm run release:prepare：两仓 build、221/26 闭包/面板 2，60 个目标文件逐文件串行/20 秒门禁（Experiment feature 45/core 1，SFTP 14），包括新增 YAML 候选与浅深高对比真实渲染。npm run release:publish 核验完整三附件草稿后公开；无 Actions/安装。
- passed .288 实际 VSIX：Plan YAML 候选/实际面板后台联动 7、候选 6、结果/Agent key 8、CLI 2（Agent 持久身份 5）、Agent/scheduler 启动 8。本机模拟/AST，无科研/SSH/启动/停止/删除。YAML 包证据 JSON 回读有效，不需要修写。
- passed .287/.81→.288/.82 实际匿名 updater：28 次公开请求，preview 筛选、清单/大小/hash/CRC/身份/平台、下载字节等于实际测试包，新 ResultCandidateYaml/PlanBuilder 与业务模块、两仓 README/包内说明匹配来源。同版本跳过/不降级通过，不实际安装/M5。
- 第二十五版 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.288 已公开：Experiment 来源 `33fe795f88ac8e50c035dac7b452b2faf652be9f`、SFTP 来源 `1a87364fc251e9dbdcf8267ebdeadf614298e2ab`，已普通推送/fetch 相等；历史包保留不覆盖。下一批限结果汇总授权/映射下载的一组问题，最多 8 文件，README/配置与同一更新通道持续同步。
- mac-doc-020 Experiment `466f9651324ec905ac01a57d210e45e93048b807`、SFTP `a3c763e6f9eaec56c2c3cb213fd089c8dab781e9` 已普通推送/fetch 核对。

### 前批 mac-doc-020（passed）
- 7 文件以内：两仓 README、包内配置说明、prepare/门禁测试/配置说明测试、本文档；同步 Mac 结果路径的 YAML 引号用法与当前验证范围，保留更新入口及 M5 边界。
- mac-005x-yaml `17ba8b376231633cdd062306b287f46b26d68078` 已普通推送并 fetch 核对 origin/master。
- passed build/221 闭包/面板 2/vm.Script、macSetupGuide 1、macRelease 4 串行、三份文档 UTF8/更新入口/验收范围及 diff；新增 macPlanResultCandidates/jsonConfigOnboarding 门禁。下一批版本元数据和本机配套发布，不安装扩展。

### 前批 mac-005x-yaml（passed）
- 4 文件：PlanBuilder.legacy.ts、mac/ResultCandidateYaml.ts、新 macPlanResultCandidates.test.js、本文档。
- 结果 single-line YAML scalar 单次解码：单双引号/转义、hash/逗号/实际空格；块/flow 列表与对象路径、命令目标保持真实 POSIX 拼写。Mac 候选完整路径去重，保留占位符，不借用另一目录同名文件；错误路径不修复。非 Mac 原契约折叠保留。
- passed npm run build：221 模块清单、面板脚本 2；npm run verify:package-runtime：221 闭包；vm.Script 与 git diff --check。
- passed 串行 node --test --test-force-exit --test-timeout 20000：macPlanResultCandidates 7、macResultCandidates 6、outputCandidateDedupRegression 3、planOutputEvidenceSignals 1、backendOutputDerivationCaches 4、projectResultLocationClarity 6、planScopedResultCandidateCache 10、planSelectionPreviewAndWorkerEmptyState 5、jsonConfigOnboarding 1。
- 编译真实 PlanBuilder 在 Mac/Windows 平台 VM 隔离、生成实际面板/后台匹配联动；不运行科研/SSH/启动/停止/删除。YAML 单行标量参考官方 1.2.2；不是完整 YAML loader，锚点/多行等未新增验收。
- 下一批：两仓 README/配置说明更新本批范围并新增发布门禁，最多 8 文件；再补丁递增和配套 prepare/publish/实际 VSIX/匿名更新。后续仅结果汇总授权/映射下载一组相关问题。

## 已交付与证据
- passed mac-002/003/004：独立身份/命名空间/AppSupport 发现文件，独立启动更新入口；preview 列表、缓存/限流、完整包验证、SFTP→Experiment、回执补装/不降级、本地业务门禁。双仓提交绑定，本机发布完整三附件，不用 Actions/安装。
- passed mac-005 局部：Termius 用户配置端点/手动登录启动；认证密钥/agent/密码/口令及可选 SecretStorage；双端认证本机 SSH/tar 流式中转；POSIX/租约/CLI/当前物理工作区与 Plan 身份/启动路径。M5 和完整科研仍 pending。
- passed mac-doc：两仓 Mac README、包内配置说明、更新按钮与 Agent 手动升级用法；实际浅/深/高对比 headless 渲染及代表文本对比通过。
- passed mac-005v-results：ResultLayout/ProjectResultTables/PlanRunFreshness、后台选择/结果设置/浅文件来源保留真实 Plan/path；TS/Python fullpath hash key、完成/部分运行来源、不借用别 Plan 通过。
- passed mac-005w-candidates：共享候选校验、实际面板/后台精确匹配/缓存；大小写/空格/Unicode/%20/目录、glob/占位符一致；源码 f59da55da05270aa346eddd65c03b12b1de7558d 已推送并 fetch 核对。
- passed mac-doc-019：Experiment 2bcb6c752c0a5ef251482b008a087567d8e0bebe、SFTP a3c6bfdef7240035ba93e523932c2891fd9a802d，候选说明及门禁。
- passed mac-release-024 preview-v0.5.287 / SFTP 0.2.81：Experiment d504d052cc8b668cacdaeb22e56083e171fc516b、SFTP bc9e2bc9e525fcd65399485b0944d8fccea6d58e 已推送/fetch 相等。完整 prepare 两仓 build/220 与 26 闭包/面板 2、58 文件串行门禁（Experiment feature 43/core 1、SFTP 14），完整草稿核验后 publish。
- passed .287 实际 VSIX：候选 6、结果/Agent key 8、CLI 2（Agent 持久身份 5）、Agent/scheduler 启动 8；本机模拟/AST，无真实科研/SSH/启动/停止/删除。
- passed .286/.80→.287/.81 实际匿名 updater：27 公开请求，prerelease 筛选、清单/大小/hash/CRC/身份/平台、包字节等于测试包、业务模块/两仓 README/配置说明匹配同步源码，同版本跳过/不降级，不实际安装。
- .287 交付记录 fcff4d065efaa0450455c27aeb5b998cdd4e00f9 已推送/fetch 相等；旧版本/附件保留，不覆盖。

## 未完成与下一边界
- pending mac-005：汇总授权/映射下载、Agent 结果读取、实际解析、物理发布/归档、其余 Windows 专属业务依赖，逐批适配。
- 物理检查与启动/写入间尚非原子锁定，完整 YAML 特性及 suite/config 等其他 scalar 不在本批证据内。
- pending mac-006：真实 M5 首装→更新/设置保留/重载/部分失败补装；Termius、独立密钥/密码传输/中文路径/断连；单 Worker、多 Worker、Hub/Worker科研主流程。
- 本地更新链路、VM/AST 与 headless 通过不能宣称完整科研或 M5 验收。用户延后真机验收，不阻塞可继续的本地适配。
