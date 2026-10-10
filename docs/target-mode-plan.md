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

## 当前批次 mac-tool-003（passed，提交推送待记录）
- 范围至多 5 文件：源快照工具/回归、发布说明/prepare 文案与计划。prepare 所有 71 目标文件/72 含面板标记通过，225 闭包通过；打包前因 SFTP 无 .vscodeignore 而使用 package.json files，快照工具错误要求 ignore 存在，失败。保留 prepare-0.5.295.log 与空 .295 目录/来源，不覆盖。仅修正快照保留真实 VSCE 规则的缺省机制，新增真实 CLI files 策略证明/策略变化拒绝，不扩大超时或放松来源字节检查。
- Exp `f9d988dd44642d8a9100478c3ab8760e60f6bee9`/SFTP `0abf9794021d3bd86e8af61478fe8b7e4d0db06c` master 同步且干净；重读事实/计划/源快照/实际 SFTP files 与 pinned VSCE 缺省源码。工具批验证提交后改用更高 .296/.90，不重试任何超时测试。
- passed 快照 8（含无 ignore 的真实 files 机制/策略突现拒绝）、225 闭包、闭包 2/发布门禁 4 串行，实际 SFTP 真实 pinned VSCE 27 文件符合原 files、无脚本/测试/历史证据；源/快照字节检查未改变，UTF8/diff。完整打包仍须新版本 prepare/实际 VSIX，不把 ls 当作包验收。

### 未发布 mac-release-032（failed prepare，0.5.295/0.2.89 保留）
- 范围 6 文件：两仓 package/lock、Experiment runtime/计划。mac-doc-026 Exp `ffee575f5714fdbbfa6c79fbf92f375324d9a8e9`/SFTP `363a13a5a3ada307ff3f2cc49018197614d3ef9a` 已普通推送/fetch 相等，两仓干净；项目事实/计划/版本及发布门禁重读。
- pending 两仓 build/闭包/面板/runtime 一致、完整 prepare、实际 VSIX/匿名更新，三附件完整草稿核验后发布。不得覆盖 .294 历史目录/tag，不触发 Actions/安装；下一边界仍为局部 Agent 结果读取适配，M5 延后。
- passed 元数据子批：两仓 build/225 与 26 闭包/面板 2/vm.Script、runtimeManifest 1、package/lock/runtime 版本、UTF8/diff；来源提交同步后才执行完整 prepare，实际包/匿名下载证据后续记录。

### 前批 mac-doc-026（passed）
- 范围至多 7 文件：两仓 README、Mac 配置说明/发布说明、prepare/发布门禁回归与计划。同步检查输出契约 Agent 产生端的使用/升级/失败处理和本机快照发布步骤，保持更新按钮入口；实际隔离回归与快照测试纳入串行门禁。不得把局部身份检查写成完整解析/M5 通过。
- 起始 Exp `0b27d0e3885bbf2beed0cb938764f8b3c70f98d2`/SFTP `8cceeee9ee706fc5cf25d3df66c02070f8386950` 已普通推送/fetch 相等且干净；项目事实/计划/README/配置说明/真实 prepare/回归重读。下一批仅配套 metadata 与完整发布验证。
- passed 两仓 build/225 与 26 闭包/面板 2、配置说明 1/发布门禁 4 串行、三份文档严格 UTF8/更新入口/使用边界与 diff；保留目标/验证/风险/真实提交压缩旧历史到字符预算以下。新增两项测试列入完整 prepare；本机快照规则写入发布说明，未声明 M5/完整科研通过。

### 前批 mac-005ae-agent-contract（passed）
- 恢复 Agent 三文件与计划；工具批 `ed5f6fa57e8fecc8182fff1eff97dd6b72d0fc7e` 已普通推送/fetch 相等。两仓 master 同步，仅已记录 Agent 修改；项目事实/计划/真实源码和回归重读。当前仅完成既定生产端身份范围，其他结果解析/写动作不扩入。

### 前批 mac-tool-002（passed）
- 范围至多 5 文件：发布源快照工具、VSIX 闭包校验器、prepare 与工具回归/计划。固定保留已提交源码和本机构建 dist，使用相同 pinned VSCE/.vscodeignore；快照全部字节/身份与实际来源前后核验，失败保留证据，不清理、不扩大超时。实际打包也用同一受检快照，历史附件不参与扫描。
- mac-005ae-agent-contract 源码/测试暂存为待完成批次，未提交：build/面板、隔离 Agent→后台 7/既有回执 8/结果身份 8/Agent Plan 5 passed，闭包 required pending。首次 fixture 在 Windows 使用 POSIX runtime 的 relpath 语义不符，添加真实 NTFS 的 POSIX 调用桥接后通过，未放松生产校验。
- pinned VSCE collectAllFiles 先 glob 全树（仅排除 node_modules），再应用 .vscodeignore；保留大量 release-artifacts 导致 8 秒 ls 多次 ETIMEDOUT。新工具批先验证相同打包规则/真实 CLI/字节与来源身份门禁并单独提交推送，再恢复 Agent 批校验/提交；不重试超时测试、不运行清理。
- passed 真实 pinned VSCE/快照回归 7（原规则、源和快照变更、额外文件、路径/类型/链接/预算）、225 包闭包、闭包回归 2/发布门禁 4、UTF8/diff；8 秒 CLI 与 10 秒外层预算保持。快照核验完整文件集合和根身份，拒绝混入无来源附件；历史证据原样保留。Agent 三文件未纳入工具提交。

### mac-005ae-agent-contract 验证记录（passed）
- 范围至多 4 文件：Agent 输出契约请求/报告回执及关联 Plan 候选、隔离 Python/真实编译后台回归与计划。三项关联问题：请求所有 Plan/revision 别名严格一致且原样；按真实 Plan 读取/筛选关联 jobs，不借匿名 suite 或相似路径；报告路径保留完整 Plan 的 hash key，事件/返回值保留同一身份。
- 起始 Exp `02a425ccb84e7ad1fce5313c792d93596000a759`/SFTP `8cceeee9ee706fc5cf25d3df66c02070f8386950` 干净、master=origin/master。前批 .294 实际包/匿名发布为 progress，无活跃进程。本批保护其他动作、业务 API/三拓扑/远端任务，strict Plan 模式只用于输出契约，不扩入运行/删除/归档。
- pending build/包闭包/面板、隔离实际 Agent→实际编译候选/现有 Mac 回执及结果身份回归，单文件串行/20 秒，Python 每次 10 秒且只提取函数；无真实科研/SSH/安装/删除。原始结果 YAML/其他 Agent 解析、revision 内容及物理原子锁定/M5 留后续。
- passed 恢复后 build/225 闭包/面板 2/vm.Script、Agent 产生端→编译候选/实时 reducer 7、回执 8/结果身份 8/Agent Plan 5、UTF8/LF/diff，串行且无测试超时；报告 key 与 TS 一致。真实 NTFS POSIX 调用桥保留生产物理检查，未启动整个 Agent。下一批仅 README/配置说明/门禁，再配套发布；完整 YAML/结果路径解析、其他写动作、revision 内容证明/原子锁定/M5 pending。

### 已交付 .294/.88 与压缩历史（passed，完整证据见 Git）
- .294 来源 Exp `1dd2e0a80adc8a29b7ae5310c03d197d5214459e`/SFTP `8cceeee9ee706fc5cf25d3df66c02070f8386950`；交付 `02a425ccb84e7ad1fce5313c792d93596000a759` 已推送/fetch 相等。69 文件串行 prepare/build/225 与 26 闭包/面板/浅深高对比；十一份实际 VSIX（回执 8/解析 8/读 8/映射 11/摘要 7/YAML 7/候选 6/结果 8/CLI 2/启动 8/结果链 6）、34 公开匿名请求 passed。仅本机/模拟/AST，M5 pending。
- .287 至 .293 来源/交付已普通推送，完整测试/失败修复与证据见对应 Git 版本及保留的 release-artifacts。一次旧 E2E 基线重现，后续实际编译替代；包测试上下文与报告聚合断言修正，无生产放松。保留更新、路径、Plan/启动/结果身份、摘要/候选/受检读写与解析、手动端点/认证/双 SSH 本机中转、README/主题交付；旧入口/三拓扑/删除确认边界受保护。
- 历史实际提交（完整分批状态见 Git）：`6307ebdd39d21ac1e22d545a7d3717b1a59c063e`、`38f582bddcc1a98f65772d8b3a640a896ea86693`、`1dd2e0a80adc8a29b7ae5310c03d197d5214459e`、`8cceeee9ee706fc5cf25d3df66c02070f8386950`、`289f1537970550cfef59eb258ac1b34b77f64e64`、`5e5cab27c1f4a05e67f83e0c5881794d906aac23`、`e9affcea0cc296588e537f26e51c0c8ecc28459f`、`c4b50b61106f17933c053e2befaf25cdd84db51e`、`ee9d1850ee36e33a02587769af41fb9f48083735`、`c9d079c761e2b02fae150df843266df2ca2a0bd5`、`8e2dc489b8dd60ef03eed1b8bcbd1766c85b9120`、`4fe3c9cb4c10f84203fed4037123a87700fca926`、`8d7a7ddec754ad0219fff4829a5a1758782124b3`、`b60b98a6decd583149bfbb5894824b15e1683836`、`1f36111a37072df960a6ef8d404b883ebc409953`、`364aae7125a32815afad6bf4e22b0d9f916baf1d`、`5b43362749404eec5c68750d082278bbfbc646e6`、`be6fb9478d467f9dd1e721f9d856e46c70ab1e36`、`e9e4a6c8e20505fbc10d3cce767e7db47971c4c0`、`21b43698021ed95314cdbf7059ec87d47f9610c0`、`b75ce34e24e7fb4a7fb5a0d8b157a9a1300fa906`、`1fd09da53283b579a72552e06e48195cf845e674`、`1611211fc2e903df729dc1c62ae3e2f8551dd5f1`、`6d55583cd93743583934d0e554481ac2f5be493b`、`faf3c228d6b543d8ba3bf02a075a723a27f65ce6`、`0145e4fc3e1bb8ee1ccd68058ae88b970ec6a47c`、`99ae1fc1941642c520112d064f923c07abe58796`、`963ee809e8d0449d0eb56d3387a37eaa119023ac`、`a50acfbe3dc99e043e0e9ba024199ca8f7a653df`、`173bd71c476d36b7e6038a394ba4e2f96153da3f`、`134dec12ca34adb9e65c6324b4a64a75db21bce8`、`72b0ce05b0a11e92cf3f3e4d3c367c2cc3968c2e`、`d31223805cc3a201ce0c37b4772238e236b40e20`、`28a85dd829e7e61799066621e3ac096570acd2f0`、`17ba8b376231633cdd062306b287f46b26d68078`、`466f9651324ec905ac01a57d210e45e93048b807`、`a3c763e6f9eaec56c2c3cb213fd089c8dab781e9`、`33fe795f88ac8e50c035dac7b452b2faf652be9f`、`1a87364fc251e9dbdcf8267ebdeadf614298e2ab`、`2ff50131c2204fce96fffc21c78fc6353f55dd40`、`f59da55da05270aa346eddd65c03b12b1de7558d`、`2bcb6c752c0a5ef251482b008a087567d8e0bebe`、`a3c6bfdef7240035ba93e523932c2891fd9a802d`、`d504d052cc8b668cacdaeb22e56083e171fc516b`、`bc9e2bc9e525fcd65399485b0944d8fccea6d58e`、`fcff4d065efaa0450455c27aeb5b998cdd4e00f9`。

## 未完成与下一边界
- pending mac-005：其他运行/写操作回执来源授权、映射原子下载发布、Webview 行字段序列化、完整 Agent 结果路径/YAML/读取、完整 Mac 本机解析与来源、归档、其余 Windows 专属业务依赖，逐批适配。输出契约 Plan 产生端局部完成不代表这些链路已验收。
- 物理检查与启动/写入间尚非原子锁定，完整 YAML 特性及 suite/config 等其他 scalar 不在本批证据内。
- pending mac-006：真实 M5 首装→更新/设置保留/重载/部分失败补装；Termius、独立密钥/密码传输/中文路径/断连；单 Worker、多 Worker、Hub/Worker科研主流程。
- 本地更新链路、VM/AST 与 headless 通过不能宣称完整科研或 M5 验收。用户延后真机验收，不阻塞可继续的本地适配。
