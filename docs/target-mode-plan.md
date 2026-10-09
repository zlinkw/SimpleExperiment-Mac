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

## 当前批次 mac-release-027（passed，0.5.290/0.2.84）
- 范围 6 文件以内：两仓 package/lock、Experiment runtime/计划；版本验证后普通推送，完整 prepare/publish 绑定同步源码，实际包/匿名更新核验；无 Actions/安装。
- mac-doc-022 Experiment `0145e4fc3e1bb8ee1ccd68058ae88b970ec6a47c`、SFTP `99ae1fc1941642c520112d064f923c07abe58796` 已普通推送/fetch 核对。
- 验证两仓 build/闭包/面板语法/runtimeManifest/元数据 UTF8；完整串行 prepare，实际 VSIX 映射身份及前批能力、匿名新版下载；M5 延后。
- passed 元数据：两仓 build、222/26 闭包/面板 2/vm.Script、runtimeManifest 1、package/lock/runtime 一致、UTF8/diff；元数据已普通推送/fetch 核对。
- passed 完整 release:prepare：两仓 build/222 与 26 闭包/面板 2，64 个单文件串行/20 秒目标门禁（Experiment feature 49/core 1、SFTP 14），含映射 7/pending 指标 39/浅深高对比真实渲染。完整日志 release-artifacts/prepare-0.5.290-attempt3.log；publish 核验完整三附件草稿后公开，无 Actions/安装。
- 初次 prepare 的旧源码抽取测试因工作文件 CRLF 找不到 ;+LF 边界；恢复仓库指定 LF，过滤后 Git blob 与已提交源码完全相同，缓存 6 通过。第二次由 Git 旧工作文件 stat 误报 dirty，重新登记相同 blob 后干净；没有改生产逻辑/覆盖版本。三个日志保留，无超时。
- passed .290 实际 VSIX：映射 7、摘要 7、YAML 候选 7、候选 6、结果/Agent key 8、CLI 2（Agent 持久身份 5）、Agent/scheduler 启动 8，七份包证据 JSON 有效。本机文件分发与模拟 API/磁盘/AST；无真实科研/SSH/远端启动/停止/删除。
- passed .289/.83→.290/.84 实际匿名 updater：30 次公开请求、prerelease/清单/大小/hash/CRC/身份/平台、下载字节等于实际测试包，业务模块/两仓 README/包内说明匹配同步来源；同版本跳过/不降级通过。不实际安装/M5。
- 第二十七版 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.290 已公开：Experiment 来源 `1611211fc2e903df729dc1c62ae3e2f8551dd5f1`、SFTP 来源 `6d55583cd93743583934d0e554481ac2f5be493b` 已普通推送/fetch 核对。历史附件保留，不覆盖。下一批限映射物理复用/发布及相关真实编译回归 fixture 的一组问题，最多 8 文件，使用说明和配套更新持续同步。

### 前批 mac-doc-022（passed）
- 范围 6 文件：两仓 README、配置说明、prepare/门禁测试、本文档。同步映射原始来源、大小/hash/缓存/分块及磁盘别名冲突用法和验证边界；保留更新入口。不扩大业务代码范围。
- mac-005z-mapped `963ee809e8d0449d0eb56d3387a37eaa119023ac` 已普通推送/fetch 核对 origin/master。
- 验证 build/闭包/面板语法、配置说明/发布脚本单文件串行 20 秒、三份文档 UTF8/diff；下一批版本元数据及配套发布，实际包/匿名更新核验。
- passed build/222 闭包/面板 2/vm.Script，macSetupGuide 1/macRelease 4 串行，三份说明 UTF8/更新入口/磁盘别名冲突操作与 diff；prepare 新增映射身份及 pendingResultMetricSync 门禁。探索旧 fixture 失败与后续修复范围在发布说明区分标记。下一批仅补丁元数据、完整配套发布及实际包/匿名更新。

### 前批 mac-005z-mapped（passed）
- 范围至多 3 文件：后台、真实编译函数测试、计划。Mac 映射来源/目标去重、大小/hash 清单、缓存/分块/发布关联使用原始 POSIX 身份；跨 Plan 合批校验冲突并避免分隔符碰撞。本机已存在条目核对真实名称，拒绝磁盘大小写/Unicode 别名；保留非 Mac 兼容入口。
- 保护三拓扑/API/Plan/远端实验/确认/租约；不执行真实科研、SSH、传输、删除。验证 build/闭包/面板语法、新测试及相邻映射工作流，逐文件串行 20 秒。物理写入原子锁、完整来源回执与 Agent/解析/归档在后续批次，文档/更新继续同步。
- 前版交付记录 `a50acfbe3dc99e043e0e9ba024199ca8f7a653df` 已普通推送/fetch 核对 origin/master。
- passed 3 文件：后台统一 Mac 原始来源/目标键、合批大小/hash 冲突、缓存/清单/分块/发布对应和暂存 key；确认缺失/复用/发布前的已存在磁盘条目核对真实名称，不借用大小写或 Unicode 别名。非 Mac 折叠入口保留。
- passed build/222 闭包/面板 2/vm.Script/UTF8/diff；macMappedResultIdentity 7、pendingResultMetricSync 39、manualDistributedResultSync 25、projectResultSyncCompleteness 18、remoteResultInspectionWorkflow 13，单文件串行/20 秒。本机真实文件分发与模拟 POSIX/不敏感磁盘，无科研/SSH/真实 API 传输。初始新 fixture 的路径构造和 SafeRequestRetry 导入修正后通过，无超时。
- exploratory failed metricsDownloadEndToEnd 4/5；旧源码 `a50acfbe3dc99e043e0e9ba024199ca8f7a653df` 只读 preload 隔离重现相同 4 失败：源码 TS loader 找不到编译 Worker.js，旧锁 fixture 未先核验 Plan 执行模式。不是本批新增回归，不作为本批完成或发布证据；待后续真实编译链 fixture 批次修复，不为测试放松生产门禁。
- 下一批仅两仓说明/配置与发布门禁，最多 8 文件；再版本递增、prepare/publish、实际包/匿名更新。完整物理原子写入、回执/解析/Agent/归档及上述探索 fixture 留后续。

### 前批 mac-release-026（passed，0.5.289/0.2.83）
- 本批 6 文件以内：两仓 package/lock、Experiment runtime/计划；版本验证后普通推送，完整 prepare/publish 绑定同步源码，实际包/匿名更新再验证，无 Actions/安装。
- mac-doc-021 Experiment `134dec12ca34adb9e65c6324b4a64a75db21bce8`、SFTP `72b0ce05b0a11e92cf3f3e4d3c367c2cc3968c2e` 已普通推送/fetch 核对。
- passed 版本门禁：两仓 build、222/26 闭包/面板 2/vm.Script、runtimeManifest 1、package/lock/runtime 一致、UTF8/diff。
- passed 完整 npm run release:prepare：两仓 build/222 与 26 闭包/面板 2、62 个单文件串行/20 秒目标门禁（Experiment feature 47/core 1、SFTP 14），含新摘要/缓存和浅深高对比实际渲染。完整日志保留 release-artifacts/prepare-0.5.289.log；npm run release:publish 核验完整三附件草稿后公开，无 Actions/安装。
- passed .289 实际 VSIX：摘要归属/后台/缓存 7、YAML 候选/实际面板后台联动 7、候选 6、结果/Agent key 8、CLI 2（Agent 持久身份 5）、Agent/scheduler 启动 8，六份包证据 JSON 有效。本机模拟/AST，无科研/SSH/启动/停止/删除。
- passed .288/.82→.289/.83 实际匿名 updater：29 次公开请求完成 prerelease 筛选、清单/大小/hash/CRC/身份/平台、下载字节等于实际测试包，新 ResultSummaryScope 和业务模块、两仓 README/包内说明匹配来源；同版本跳过/不降级通过，不实际安装/M5。
- 第二十六版 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.289 已公开：Experiment 来源 `d31223805cc3a201ce0c37b4772238e236b40e20`、SFTP 来源 `28a85dd829e7e61799066621e3ac096570acd2f0` 已普通推送/fetch 核对。旧附件保留不覆盖；下一批限映射传输去重/原始来源路径的一组问题，最多 8 文件，使用说明/更新持续同步。

### 前批 mac-doc-021（passed）
- 本批 6 文件：两仓 README、配置说明、prepare/发布门禁测试与计划；更新摘要归属/匿名来源说明、保留更新入口，新增摘要/缓存门禁。不扩展业务源范围。
- mac-005y-summary `173bd71c476d36b7e6038a394ba4e2f96153da3f` 已普通推送/fetch 核对 origin/master。
- passed build/222 闭包/面板 2/vm.Script、配置说明 1、发布门禁 4 单文件串行，三份 Mac 文档 UTF8/更新入口/归属边界与 diff；下一批版本元数据、prepare/publish、实际包/匿名更新。映射传输去重和物理发布仍待后续批次。

### 前批 mac-005y-summary（passed）
- 本批仅 Mac 摘要/完成结果的原始 Plan 身份、嵌套记录归属及浅查看/同步候选授权，最多 5 源/测试/计划文件；改写修复别名与隐式继承，不运行科研/SSH/传输/删除。回归真实编译函数、结果缓存/查看/完成结果工作流、build/闭包/面板语法。映射传输的去重/本地物理发布、Agent/完整 YAML 后续批次。
- mac-release-025 交付记录 `2ff50131c2204fce96fffc21c78fc6353f55dd40` 已推送/fetch 核对 origin/master。
- passed 4 文件：新 ResultSummaryScope、后台筛选/缓存/候选入口、新 macResultSummaryScope 测试与计划。Mac 顶层/记录/provenance/Worker/数据集/完成 job/claim 的 Plan 别名一致；匿名和混合分析产物不授权，保留明确归属的记录与表，不修写路径/类型；缓存元组避免 | 碰撞。非 Mac 原入口保留。
- passed build/222 闭包/面板 2/vm.Script/UTF8/diff；macResultSummaryScope 7、resultsSummaryWebviewCache 6、macResultIdentity 8、remoteResultInspectionWorkflow 13、projectResultSyncCompleteness 18、manualDistributedResultSync 25，单文件串行 20 秒，无超时。新 VM fixture 补齐实际 FileTransferTypes/WrapperResultBundle 导入后通过。
- 下一批仅两仓说明/发布门禁，再版本递增/配套发布与实际 VSIX/匿名更新；后续映射去重与物理发布分批，不宣称传输/完整科研/M5 验收。

### 压缩历史（完整证据见 Git）
- mac-005x-yaml `17ba8b376231633cdd062306b287f46b26d68078` 已推送：单行结果 YAML 引号/转义仅解码一次，原始 POSIX 候选与实际面板/后台联动 7、相邻 8 文件串行通过；build/221 闭包/面板 2/vm.Script。不是完整 YAML loader，锚点/多行/其他字段 pending。
- mac-doc-020 Experiment `466f9651324ec905ac01a57d210e45e93048b807`/SFTP `a3c763e6f9eaec56c2c3cb213fd089c8dab781e9`；.288/.82 来源 `33fe795f88ac8e50c035dac7b452b2faf652be9f`/`1a87364fc251e9dbdcf8267ebdeadf614298e2ab`，交付 `2ff50131c2204fce96fffc21c78fc6353f55dd40`，均普通推送/fetch 相等。完整 prepare 60 文件/build/221 与 26 闭包；实际包 YAML 7/候选 6/结果 8/CLI 2/启动 8、匿名 28 请求通过，不安装/M5。

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
- pending mac-005：命令回执来源授权、映射物理复用/原子下载发布、Webview 行字段序列化、Agent 结果读取、实际解析、归档、其余 Windows 专属业务依赖，逐批适配。新摘要范围门禁不代表这些链路已验收。
- 物理检查与启动/写入间尚非原子锁定，完整 YAML 特性及 suite/config 等其他 scalar 不在本批证据内。
- pending mac-006：真实 M5 首装→更新/设置保留/重载/部分失败补装；Termius、独立密钥/密码传输/中文路径/断连；单 Worker、多 Worker、Hub/Worker科研主流程。
- 本地更新链路、VM/AST 与 headless 通过不能宣称完整科研或 M5 验收。用户延后真机验收，不阻塞可继续的本地适配。
