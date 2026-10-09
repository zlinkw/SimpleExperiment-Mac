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

## 当前批次 mac-005ae-agent-contract（passed，提交推送待记录）
- 恢复 Agent 三文件与计划；工具批 `ed5f6fa57e8fecc8182fff1eff97dd6b72d0fc7e` 已普通推送/fetch 相等。两仓 master 同步，仅已记录 Agent 修改；项目事实/计划/真实源码和回归重读。当前仅完成既定生产端身份范围，其他结果解析/写动作不扩入。

### 前批 mac-tool-002（passed）
- 范围至多 5 文件：发布源快照工具、VSIX 闭包校验器、prepare 与工具回归/计划。固定保留已提交源码和本机构建 dist，使用相同 pinned VSCE/.vscodeignore；快照全部字节/身份与实际来源前后核验，失败保留证据，不清理、不扩大超时。实际打包也用同一受检快照，历史附件不参与扫描。
- mac-005ae-agent-contract 源码/测试暂存为待完成批次，未提交：build/面板、隔离 Agent→后台 7/既有回执 8/结果身份 8/Agent Plan 5 passed，闭包 required pending。首次 fixture 在 Windows 使用 POSIX runtime 的 relpath 语义不符，添加真实 NTFS 的 POSIX 调用桥接后通过，未放松生产校验。
- pinned VSCE collectAllFiles 先 glob 全树（仅排除 node_modules），再应用 .vscodeignore；保留大量 release-artifacts 导致 8 秒 ls 多次 ETIMEDOUT。新工具批先验证相同打包规则/真实 CLI/字节与来源身份门禁并单独提交推送，再恢复 Agent 批校验/提交；不重试超时测试、不运行清理。
- passed 真实 pinned VSCE/快照回归 7（原规则、源和快照变更、额外文件、路径/类型/链接/预算）、225 包闭包、闭包回归 2/发布门禁 4、UTF8/diff；8 秒 CLI 与 10 秒外层预算保持。快照核验完整文件集合和根身份，拒绝混入无来源附件；历史证据原样保留。Agent 三文件未纳入工具提交。

### 待完成 mac-005ae-agent-contract（running）
- 范围至多 4 文件：Agent 输出契约请求/报告回执及关联 Plan 候选、隔离 Python/真实编译后台回归与计划。三项关联问题：请求所有 Plan/revision 别名严格一致且原样；按真实 Plan 读取/筛选关联 jobs，不借匿名 suite 或相似路径；报告路径保留完整 Plan 的 hash key，事件/返回值保留同一身份。
- 起始 Exp `02a425ccb84e7ad1fce5313c792d93596000a759`/SFTP `8cceeee9ee706fc5cf25d3df66c02070f8386950` 干净、master=origin/master。前批 .294 实际包/匿名发布为 progress，无活跃进程。本批保护其他动作、业务 API/三拓扑/远端任务，strict Plan 模式只用于输出契约，不扩入运行/删除/归档。
- pending build/包闭包/面板、隔离实际 Agent→实际编译候选/现有 Mac 回执及结果身份回归，单文件串行/20 秒，Python 每次 10 秒且只提取函数；无真实科研/SSH/安装/删除。原始结果 YAML/其他 Agent 解析、revision 内容及物理原子锁定/M5 留后续。
- passed 恢复后 build/225 闭包/面板 2/vm.Script、Agent 产生端→编译候选/实时 reducer 7、回执 8/结果身份 8/Agent Plan 5、UTF8/LF/diff，串行且无测试超时；报告 key 与 TS 一致。真实 NTFS POSIX 调用桥保留生产物理检查，未启动整个 Agent。下一批仅 README/配置说明/门禁，再配套发布；完整 YAML/结果路径解析、其他写动作、revision 内容证明/原子锁定/M5 pending。

### 前批 mac-release-031（passed，0.5.294/0.2.88）
- 范围 6 文件：两仓 package/lock、Experiment runtime/计划。两仓干净且 master 同步；mac-doc-025 Exp `6307ebdd39d21ac1e22d545a7d3717b1a59c063e`/SFTP `38f582bddcc1a98f65772d8b3a640a896ea86693` 已普通推送/fetch 核对。
- passed 两仓 build/闭包/面板/runtime/UTF8/diff、完整 prepare、实际 VSIX 与匿名 updater；完整三附件草稿核验后公开发布。无 Actions/安装，保留历史附件。

- passed 元数据子批：两仓 build/225 与 26 闭包/面板 2/vm.Script、runtimeManifest 1、package/lock/runtime 一致、UTF8/diff；后续完整 prepare/实际包/匿名发布证据分别记录。

- passed 完整 release:prepare：build/225 与 26 闭包/面板 2/vm.Script、69 个目标测试文件单文件串行/20 秒（Exp feature 54/core 1、SFTP 14），回执候选 8/本机解析 8/读取 8/映射 11/wrapper 22/pending 39/实际编译链 6/浅深高对比真实 headless；日志 release-artifacts/prepare-0.5.294.log，70 个含 build 面板标记，无超时。
- passed .294 实际 VSIX 十一份证据：新增回执候选 8（完整 typed Plan/别名/revision、祖先/兄弟范围、归属时间/最新空报告、Windows 兼容），本机解析 8/读取 8/映射 11/摘要 7/YAML 7/候选 6/结果 8/CLI 2/启动 8/编译结果链 6；所有 report 绑定包来源/hash。本机文件/模拟 API/POSIX/隔离 AST，无真实科研/SSH/远端启动/停止/删除/安装/M5。报告聚合检查初次把启动 scenarios 数组当数字，按原报告数组长度核对通过，未改报告或生产。
- passed .293/.87→.294/.88 匿名 updater：34 次公开请求，预发布/清单/大小/hash/CRC/身份/平台验证，下载字节等于实际测试包；新回执模块、前版能力、两仓 README/包内说明匹配同步来源，同版本跳过/不降级。
- 第三十一版 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.294 已公开；来源 Exp `1dd2e0a80adc8a29b7ae5310c03d197d5214459e`/SFTP `8cceeee9ee706fc5cf25d3df66c02070f8386950` 已普通推送/fetch 相等。下一批限 Agent 检查输出契约回执产生端的原始 Plan/selectedPlanId 别名与关联只读候选，最多 8 文件；其他写操作/原子发布/归档/M5 保留后续。

### 前批 mac-doc-025（passed）
- 范围 6 文件：两仓 README、Mac 配置说明、prepare/对应门禁测试与计划。同步轻量结果查看回执来源隔离和失败处理、继续保留 Mac 更新入口，明确其他回执及 Agent 输出仍待适配。
- mac-005ad-receipt `289f1537970550cfef59eb258ac1b34b77f64e64` 已普通推送/fetch 相等；两仓干净。passed 两仓 build/225 与 26 闭包/面板 2/vm.Script、配置说明 1/发布门禁 4 单文件串行、三份文档 UTF8/更新入口/diff。下一批仅配套元数据/完整 prepare/实际包/匿名发布。

### 前批 mac-005ad-receipt（passed）
- 范围至多 4 文件：Mac 结果命令回执范围模块、后台轻量结果查看候选、真实编译回归与计划。核对完整 Plan/所有别名与 revision，仅显式归属祖先可授权结构子记录；子 Plan 不授权匿名祖先/兄弟的路径或新鲜度。冲突/错误类型拒绝，保留最新空报告抑制旧候选、原入口与 Windows 行为。
- 起始 Exp `5e5cab27c1f4a05e67f83e0c5881794d906aac23`/SFTP `e9affcea0cc296588e537f26e51c0c8ecc28459f` 干净、master=origin/master；项目事实/计划/真实 Agent 回执形状与相关源码测试已读。保护 API/三拓扑/远端任务，无真实 SSH/科研/删除/安装。
- passed build/225 闭包/面板 2/vm.Script、实际编译回执候选 8、原结果查看 13/候选 6/摘要 7/结果身份 8，单文件串行/20 秒无测试超时；UTF8/LF/diff。初始新模块 copy 类型错误显式 Row 修复；第一次 vsce ls 的 8 秒子进程预算超时，后续源码验证完整 build 后闭包通过，未放松预算。
- 下一批同步 README/配置/门禁与配套发布。其他运行/写操作回执、Webview 序列化、Agent 输出（action_payload_text/selectedPlanId 仍有 trim）与完整原子发布保留后续，不宣称真实 Agent/M5 通过。

### 前批 .293/.87（passed，完整证据见 Git）
- mac-005ac-parse `c4b50b61106f17933c053e2befaf25cdd84db51e`：描述符快照/mtime、4 MiB/严格 UTF8、完整 Plan/原始路径/hash/大小、实际解析而非缓存 rows、wrapper 尾空格/二进制/空文件；build/224 闭包/面板、解析 8/读取 8/摘要 7/映射 11/结果链 6/wrapper 22/pending 39 passed。初始两项 fixture 无差异/断言修正，无生产放松。
- mac-doc-024 Exp `ee9d1850ee36e33a02587769af41fb9f48083735`/SFTP `c9d079c761e2b02fae150df843266df2ca2a0bd5`；两仓 README/配置/门禁/UTF8 passed。
- 来源 Exp `8e2dc489b8dd60ef03eed1b8bcbd1766c85b9120`/SFTP `e9affcea0cc296588e537f26e51c0c8ecc28459f`，交付 `5e5cab27c1f4a05e67f83e0c5881794d906aac23`；68 文件串行 prepare/十份实际包/33 匿名请求 passed，均已普通推送/fetch 相等；日志 release-artifacts/prepare-0.5.293.log，历史附件保留，M5 pending。

### 前批 .292/.86（passed，完整证据见 Git）
- mac-005ab-compiled Exp `4fe3c9cb4c10f84203fed4037123a87700fca926`/SFTP `8d7a7ddec754ad0219fff4829a5a1758782124b3`，真实编译 Worker/结果链 6/迟到锁/错误响应保留旧结果 passed；不放松生产门禁。
- 来源 Exp `b60b98a6decd583149bfbb5894824b15e1683836`/SFTP `1f36111a37072df960a6ef8d404b883ebc409953`，交付 `364aae7125a32815afad6bf4e22b0d9f916baf1d`；两仓 build/闭包/67 文件串行 prepare/九份实际包/32 匿名请求 passed，均已普通推送/fetch 相等。实际包子测试上下文导致空输出，清除 NODE_TEST_CONTEXT/显式 TAP 后真实 6 项通过，失败证据保留，无生产修改。

### 压缩前批（完整状态、日志及提交见 Git）
- mac-release-028 .291/.85：来源 Exp `5b43362749404eec5c68750d082278bbfbc646e6`/SFTP `be6fb9478d467f9dd1e721f9d856e46c70ab1e36`，交付 `e9e4a6c8e20505fbc10d3cce767e7db47971c4c0`；66 文件/build/八份实际包/31 匿名请求 passed，已推送。mac-doc-023 Exp `21b43698021ed95314cdbf7059ec87d47f9610c0`/SFTP `b75ce34e24e7fb4a7fb5a0d8b157a9a1300fa906`；mac-005aa-read `1fd09da53283b579a72552e06e48195cf845e674`：描述符/目录身份、hash/复制、暂存不提前截断/短写/失败保留旧结果；对应回归 passed。
- mac-release-027 .290/.84 来源 `1611211fc2e903df729dc1c62ae3e2f8551dd5f1`/`6d55583cd93743583934d0e554481ac2f5be493b`，交付 `faf3c228d6b543d8ba3bf02a075a723a27f65ce6`；64 文件/build/七份实际包/30 匿名请求 passed。prepare CRLF 和 Git stat 前置失败经相同 blob 恢复后通过，日志保留。mac-doc-022 `0145e4fc3e1bb8ee1ccd68058ae88b970ec6a47c`/`99ae1fc1941642c520112d064f923c07abe58796` 已推送；mac-005z-mapped `963ee809e8d0449d0eb56d3387a37eaa119023ac` 原始映射/合批/清单/分块身份 passed，旧 E2E 4/5 失败与 `a50acfbe3dc99e043e0e9ba024199ca8f7a653df` 重现，.292 改实际编译 fixture 后通过。
- mac-005y-summary `173bd71c476d36b7e6038a394ba4e2f96153da3f` 摘要完整 Plan/provenance/Worker/job 来源隔离 passed；mac-doc-021 `134dec12ca34adb9e65c6324b4a64a75db21bce8`/`72b0ce05b0a11e92cf3f3e4d3c367c2cc3968c2e`；.289/.83 来源 `d31223805cc3a201ce0c37b4772238e236b40e20`/`28a85dd829e7e61799066621e3ac096570acd2f0`，交付 `a50acfbe3dc99e043e0e9ba024199ca8f7a653df`；62 文件/实际包/29 匿名请求 passed，已推送。
- mac-005x-yaml `17ba8b376231633cdd062306b287f46b26d68078` 单行 YAML 解码一次/实际候选 passed，完整 YAML pending；mac-doc-020 `466f9651324ec905ac01a57d210e45e93048b807`/`a3c763e6f9eaec56c2c3cb213fd089c8dab781e9`；.288/.82 来源 `33fe795f88ac8e50c035dac7b452b2faf652be9f`/`1a87364fc251e9dbdcf8267ebdeadf614298e2ab`，交付 `2ff50131c2204fce96fffc21c78fc6353f55dd40`；60 文件/实际包/28 匿名请求 passed，已推送。

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
- pending mac-005：Agent 结果命令回执产生端与其他运行/写操作回执来源授权、映射原子下载发布、Webview 行字段序列化、Agent 结果读取、完整 Mac 本机解析与来源、归档、其余 Windows 专属业务依赖，逐批适配。新摘要范围门禁不代表这些链路已验收。
- 物理检查与启动/写入间尚非原子锁定，完整 YAML 特性及 suite/config 等其他 scalar 不在本批证据内。
- pending mac-006：真实 M5 首装→更新/设置保留/重载/部分失败补装；Termius、独立密钥/密码传输/中文路径/断连；单 Worker、多 Worker、Hub/Worker科研主流程。
- 本地更新链路、VM/AST 与 headless 通过不能宣称完整科研或 M5 验收。用户延后真机验收，不阻塞可继续的本地适配。
