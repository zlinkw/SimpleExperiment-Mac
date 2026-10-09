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

## 当前批次 mac-005ab-compiled（passed）
- 范围至多 7 文件：真实编译 metricsDownloadEndToEnd fixture、发布门禁/对应测试、两仓 README/Mac 配置说明与计划。修复 TS 源码加载 Worker.js 和缺少执行模式的 fixture 前置条件，保留实际编译 Worker/解析/注册表/CSV/Markdown 与提交世代门禁；不放松生产判断。
- 当前两仓干净且 master 同步：Experiment `e9e4a6c8e20505fbc10d3cce767e7db47971c4c0`，SFTP `be6fb9478d467f9dd1e721f9d856e46c70ab1e36`。保护原入口、API/Plan/三拓扑；不运行真实科研/SSH/远端操作/安装/删除。
- passed 两仓 build/223 与 26 闭包/面板 2/vm.Script；实际 dist 结果 fixture 6（模拟 API、真实本机文件/编译 Worker）、pending 指标 39、执行模式 9、配置说明 1、发布门禁 4，单文件串行/20 秒无超时。拒绝四类错误响应并逐字节保留旧注册表和 CSV/Markdown；迟到锁测试确认实际进入锁回调后未发送。三份文档 UTF8/更新入口/diff passed；无生产门禁放松。缺失来源/本地解析路径、完整原子写入与 M5 后续处理。
- 下一批仅两仓补丁元数据/完整 prepare/publish、实际 VSIX 结果链 fixture 与前版能力/匿名下载；最多 6 文件，无安装/Actions。

### 前批与最近发布（passed；完整记录见 Git）
- mac-release-028 0.5.291/0.2.85 已公开 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.291 。来源 Experiment `5b43362749404eec5c68750d082278bbfbc646e6`、SFTP `be6fb9478d467f9dd1e721f9d856e46c70ab1e36`；交付 `e9e4a6c8e20505fbc10d3cce767e7db47971c4c0`，普通推送/fetch 相等。完整 prepare 两仓 build/223 与 26 闭包/面板 2、66 文件串行；实际包读取 7/映射 11/摘要 7/YAML 7/候选 6/结果 8/CLI 2/启动 8，匿名 .290/.84→.291/.85 的 31 公开请求/字节/身份/hash/CRC/源码/说明通过，不安装/M5。日志和八份包证据保留 release-artifacts/preview-v0.5.291。
- mac-doc-023 Exp `21b43698021ed95314cdbf7059ec87d47f9610c0`、SFTP `b75ce34e24e7fb4a7fb5a0d8b157a9a1300fa906`；使用说明/配置/读取门禁、build/UTF8/对应测试 passed，已推送。
- mac-005aa-read `1fd09da53283b579a72552e06e48195cf845e674`：ResultFiles 描述符及全目录 inode 链读取、wrapper 复用/磁盘补读/hash/复制、暂存不提前截断/硬链接校验/短写循环/失败保留旧最终结果。build/223 闭包/面板 2，读取 7/映射 11/wrapper 22/pending 指标 39/同步 18/浅查看 13 串行 passed。仅本机真实文件/模拟 POSIX 与 API，完整原子发布未验收。
- mac-release-027 .290/.84 来源 Exp `1611211fc2e903df729dc1c62ae3e2f8551dd5f1`、SFTP `6d55583cd93743583934d0e554481ac2f5be493b`，交付 `faf3c228d6b543d8ba3bf02a075a723a27f65ce6`；64 文件/build/222 与 26 闭包、七份实际包证据/30 匿名请求 passed，已推送。prepare 两次前置失败分别为旧源码抽取边界 CRLF 和 Git stat 误报，恢复指定 LF/同 blob 后通过，无生产改写或超时；日志保留。
- mac-doc-022 Exp `0145e4fc3e1bb8ee1ccd68058ae88b970ec6a47c`、SFTP `99ae1fc1941642c520112d064f923c07abe58796` passed/已推送。
- mac-005z-mapped `963ee809e8d0449d0eb56d3387a37eaa119023ac`：原始路径/Plan/大小/hash 合批、缓存/清单/分块关联和真实名称核验；build/222 闭包，映射 7/pending 39/分布式 25/同步 18/浅查看 13 passed。探索 metricsDownloadEndToEnd 4/5 failed，与旧源码 `a50acfbe3dc99e043e0e9ba024199ca8f7a653df` 隔离重现相同失败；未记为发布证据，当前批仅修 fixture。
- mac-005y-summary `173bd71c476d36b7e6038a394ba4e2f96153da3f`：完整 Plan 别名/provenance/Worker/job/claim 授权、隐藏匿名/混合摘要、缓存元组；摘要 7/缓存 6/结果 8/浅查看 13/同步 18/分布式 25/build passed，已推送。mac-doc-021 Exp `134dec12ca34adb9e65c6324b4a64a75db21bce8`、SFTP `72b0ce05b0a11e92cf3f3e4d3c367c2cc3968c2e`；.289/.83 来源 `d31223805cc3a201ce0c37b4772238e236b40e20`/`28a85dd829e7e61799066621e3ac096570acd2f0`，交付 `a50acfbe3dc99e043e0e9ba024199ca8f7a653df`；62 文件/六份实际包/29 匿名请求 passed，已推送。
- mac-005x-yaml `17ba8b376231633cdd062306b287f46b26d68078`：单行 YAML 解码一次、候选和实际面板/后台 7/相邻 8 文件 passed；完整 YAML pending。mac-doc-020 Exp `466f9651324ec905ac01a57d210e45e93048b807`/SFTP `a3c763e6f9eaec56c2c3cb213fd089c8dab781e9`；.288/.82 来源 `33fe795f88ac8e50c035dac7b452b2faf652be9f`/`1a87364fc251e9dbdcf8267ebdeadf614298e2ab`，交付 `2ff50131c2204fce96fffc21c78fc6353f55dd40`；60 文件/实际包/28 匿名请求 passed，已推送。

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
