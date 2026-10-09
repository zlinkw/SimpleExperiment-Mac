# 目标模式当前计划：mac 适配，更新发布优先
字符上限 12000，达到 10800 自动压缩。保留当前目标、验证、风险、下一批边界和真实提交记录；历史详见 Git。

本文档只保留最新活动目标。历史批次、验证和部署记录以 git 提交为准。
打包/清理时会自动压缩本文件，禁止堆积流水账。

## 固定边界
- 当前目标：交付两款独立 darwin-arm64 preview 扩展及完整配套更新、本机 GitHub Releases 发布链路，再完成 mac 科研业务适配。
- 公开仓库 SimpleExperiment-Mac、SimpleSFTP-Mac，提交并普通推送 origin/master；只复制原项目已提交源码，不改变 Windows 项目。
- 支持 macOS 26 及以上 Apple Silicon；M5/macOS 27.0 用户真机验证尚未执行。
- 首版排除 PPT 自动绘图、Dev Containers、Intel Mac、Actions、zlinkw.shop、历史附件自动清理。
- 保护三拓扑、业务 API、Plan 格式、远端实验、删除直接父目录校验与两次确认；保留原入口至用户批准移除。
- 测试逐文件串行，20 秒限时。构建、包闭包和面板脚本验证是交付门禁。发布不安装开发机扩展。
- 每批最多 3 个关联问题、8 个源/文档/测试文件；初始源快照导入不作为代码改写批次。

## 后续优先级
- passed mac-002：独立身份、命名空间、发现目录及最小启动，本地门禁通过。
- passed mac-003：独立更新引擎、preview 筛选/缓存/限流、校验及更新事务、业务门禁，本地测试通过；M5 安装链路仍待验收。
- passed mac-004：本机 prepare/publish、双仓提交绑定、包闭包与多版 preview 交付，实际匿名客户端下载校验通过。
- pending mac-005：Termius 手动隧道、mac 路径/租约/CLI、认证与本机流式中转。
- pending mac-006：真机更新及科研三拓扑验收，用户回传证据后完成。

## 当前批次：mac-release-021（running，配套 preview-v0.5.284）
### 边界

- 两仓 package/lock、Experiment runtime 真值与本计划共 6 文件，升级 0.5.284/0.2.78；关联已同步代码与说明，完整配套发布不安装扩展。
- passed 版本两仓 build/219 与 26 模块闭包/面板脚本 2、runtimeManifest 1 串行 20 秒；完整 prepare/publish、实际包与匿名下载后记录。真实科研/SSH/M5 pending。

### 验证清单

- passed mac-release-016：完整本机 prepare/publish、两仓 build/217 与 26 文件闭包、面板脚本 2、逐文件串行更新/CLI/路径/认证/中转与浅/深/高对比真实渲染通过。三个完整草稿附件核验后发布，无 Actions/开发机安装。
- passed preview-v0.5.279：实际两包固定 CLI 通过真实本地 shell/Node health/实时 RPC，Experiment 实际包以中文 Plan、本机 mock 完成工作区/路线预检与等待确认回执，submitted=false（2 项包测试）。真实匿名 updater 从 0.5.278/0.2.72 筛出两组件，19 次请求完成大小/hash/CRC/身份/平台校验；下载字节与已测试 VSIX 一致，新 CLI 模块、两仓 README/配置说明与来源一致。同版本跳过/禁止降级通过，无实际科研/服务器/M5。
- passed mac-005q：服务端 Mac workflow 绑定当前物理工作区，异步准备/校验/标准 Plan 关键边界复核，晚到回执不写入另一工作区；精确保留 Plan 首尾空格。CLI/API seed override 显式拒绝，正式种子沿用保存的 Plan，离线预览不宣称应用 seed。Mac 提交不执行旧自动停止 fallback，活动运行在创建回执及提交前拦截。8 文件。
- passed 本地：build/218 模块闭包/面板脚本 2、macWorkflowBinding 6、macCliWorkflow 6、macProjectPrepare 16、localApi 标准路线相关 5 逐文件串行通过；测试为编译方法 VM/本机 mock，无真实科研/SSH/停止/删除。初次 VM fixture 缺少编译导入别名，补齐后通过，非超时。
- passed mac-doc-012：两仓 README/配置说明补全当前真实工作区、活动运行与保存 Plan seeds；在线覆盖明确报错、离线不应用、旧手工记录器边界，更新按钮入口保留。新工作区回归纳入发布门禁，发布说明区分本地/M5。UTF8 回读、build/218 闭包/面板脚本 2、配置说明 1、发布门禁 4 通过，6 文件。
- passed mac-release-017：完整本机 prepare/publish、两仓 build/218 与 26 文件闭包、面板脚本 2、逐文件串行更新/工作区/CLI/路径/认证/中转及浅深高对比实际渲染通过；3 个完整草稿附件核验后发布，无 Actions/自动安装。
- passed preview-v0.5.280：实际两包固定 CLI 通过真实本地 shell/Node health/实时 RPC，Experiment 包中文 Plan 工作区/路线预检与等待确认回执、seed 覆盖在 RPC 前拒绝通过（2 包测试）。真实匿名 updater 从 0.5.279/0.2.73 筛出两组件，20 次请求完成大小/hash/CRC/身份/平台核验；字节与已测试 VSIX 相同，工作区/Plan/CLI 模块与两仓 README/配置说明匹配来源。同版本跳过/禁止降级通过；首次 README 比对 fixture 未使用 vsce 的 HEAD 链接，修正匹配规则后通过，无生产修改。
- passed mac-005r：运行证据轮询（含 remote-pending 路线）复核原工作区/目录/操作集合，另一项目活动记录不能冒充成功；人工确认的重试回调在队列加载、修改、确认及精确停止前复核；分布式路线的指纹、排队回调、代码同步、预演、历史产物选择及 enqueue 前后保持同一物理工作区，目录变化后不向另一项目发送状态或派发。原 API/Plan 格式/非 Mac 路线保留。6 文件。
- passed 本地：build/218 闭包/面板脚本 2、macWorkflowBinding 10、planSafeRetry 12、distributedPlanSubmissionRouting 5、duplicatePlanSubmissionGuard 10、planSubmissionVisiblePreflight 19 逐文件串行通过。编译方法 VM/编译重试模块/本机 mock 无真实科研/停止/SSH。初次新 fixture 缺少 outputDir、当前 root 回调/字符串依赖与 revision，旧 fixture 缺少 Mac 分支/运行模式依赖；补齐真实契约后通过，非超时。
- passed mac-doc-013：两仓 README/配置说明补全等待回执、人工重试及多 Worker 项目变化的处理；原更新按钮入口保留，相邻 3 个 Plan 回归加入发布门禁并更新说明。UTF8 回读、build/218 闭包/面板脚本 2、配置说明 1、发布门禁 4 通过，6 文件。
- passed mac-release-018：完整本机 prepare/publish，两仓 build/218 与 26 文件闭包、面板脚本 2、逐文件串行更新/工作区/重试/分布式预检/CLI/路径/认证/中转以及浅深高对比渲染通过。3 个完整草稿附件核验后公开，无 Actions/自动安装。
- passed preview-v0.5.281：实际两包固定 CLI 经真实本地 shell/Node health/实时 RPC，Experiment 实际包中文 Plan 的工作区/路线预检、等待确认回执和 seed 覆盖 RPC 前拒绝通过（2 包测试）。真实匿名 updater 从 0.5.280/0.2.74 筛出两组件，21 次请求完成大小/hash/CRC/身份/平台核验；下载字节与已测试 VSIX 相同，编译重试/工作区/Plan/CLI 模块及两仓 README/配置说明与来源一致。同版本跳过/禁止降级通过，无真实科研/SSH/M5。
- passed mac-005s：Mac 的后台 Plan 选择、保存/回执与身份锁/缓存、分布式队列与自动重试、真实生成面板的下拉选择和身份缓存保留大小写/Unicode/真实空格/字面 %20，不把不同完整路径或绝对/相对后缀合并。非 Mac 路线和 API/Plan 格式保留。6 文件。
- passed 本地：build/218 闭包/面板脚本 2；macPlanIdentity 6、distributedPlanQueue 29、distributedJobAutoRetry 30、planSafeRetry 12、duplicatePlanSubmissionGuard 10、planFileEquivalenceCache 4、planSelectionPreview 5、planSelectorStatus 13、selectedPlanCardOrder 2、visiblePreflight 19、distributedRouting 5、macWorkflowBinding 10，逐文件串行通过，无真实科研/SSH/停止/删除。初次 fixture 使用 JS 文件名解析 TS、误用导出名/默认重试状态，及旧下拉 fixture 缺依赖，补齐真实契约后通过，非超时。
- passed mac-doc-014：两仓 README 与 Mac 配置说明同步补充完整 Plan 路径、大小写/真实空格和错误路径处理，保留更新按钮入口；身份、队列、自动重试回归纳入发布门禁，6 文件。UTF8 回读、build/218 闭包/面板脚本 2、macSetupGuide 1、macRelease 4 通过。
- passed mac-release-019 版本批次：0.5.282/0.2.76 两仓 build/218 与 26 模块闭包、面板脚本 2、runtimeManifest 1 通过，6 文件；完整配套打包/上传/实际包及匿名验证通过，见下条。
- passed mac-release-019：完整本机 prepare/publish，两仓 build/218 与 26 模块闭包、面板脚本 2、逐文件串行更新/Plan 身份/队列/自动重试/工作区/CLI/路径/认证/中转及浅深高对比真实渲染通过，3 个完整草稿附件核验后公开。无 Actions/自动安装。
- passed preview-v0.5.282：两包实际 CLI 经真实本地 shell/Node health/实时 RPC，Experiment 中文 Plan 等待确认回执与 seed 覆盖 RPC 前拒绝通过（2 包测试）；实际包编译队列在 Mac 模拟环境保留精确大小写/空格，包内 Mac 面板脚本语法通过。真实匿名 updater 从 0.5.281/0.2.75 筛出两组件，22 次请求完成大小/hash/CRC/身份/平台核验；下载字节与已测试 VSIX 一致，新编译队列、面板、业务模块及两仓 README/配置说明与来源匹配。同版本跳过/禁止降级通过，无真实科研/SSH/M5。
- passed mac-005t：Mac Plan 目录设置、正式/归档扫描与单文件摘要保留真实大小写、Unicode、字面 %20 和 YAML 名末尾空格。现有父目录/文件逐级校验实际目录条目，拒绝符号链接与错误类型；读取 NOFOLLOW/NONBLOCK，前后复核工作区/文件 inode 与内容时间/长度，变化后不使用结果；完整配置检查拒绝截断 Plan。显式错误 Plan 不退回另一唯一 Plan。分布式合同/本机预演/入队保留相对输出拼写，非法路径先拒绝再写队列，非 Mac 入口保留。7 文件。
- passed 本地：build/219 闭包/面板脚本 2 与 vm.Script；macPlanFiles 9、macPlanIdentity 6、distributedProjectContract 6、macWorkflowBinding 10、visiblePreflight 19、distributedRouting 5、macProjectPrepare 16，逐文件串行通过。编译模块/实际方法配合 POSIX 文件系统模拟，无真实科研/SSH/停止/删除。初次 fixture 的错误提示预期不匹配、归档缺 stringField 和旧编译 fixture 缺新导入，修正后通过，非超时。
- passed mac-005t-full：完整本地配置检查读取全文并沿用 Mac 身份复核，移除上一批未发布的 1 MiB 限制；摘要预算与截断标记保持。4 文件。build/219 闭包/面板脚本 2、macPlanFiles 9（含超摘要预算的完整配置引用）、macWorkflowBinding 10、visiblePreflight 19 串行通过，无真实科研/SSH。
- passed mac-doc-015：两仓 README/配置说明补全 Mac planDir、真实目录条目、读期间变化处理、全文检查与分布式路径规则；更新入口保留，文件/合同回归纳入发布门禁。6 文件。UTF8 回读、build/219 闭包/面板脚本 2、配置说明 1、发布门禁 4 通过。
- passed mac-release-020：完整本机 prepare/publish，两仓 build/219 与 26 模块闭包、面板脚本 2、逐文件串行更新/Plan 文件/合同/身份/队列/重试/工作区/CLI/路径/认证/中转和浅深高对比实际渲染通过；3 个完整草稿附件核验后公开，无 Actions/自动安装。
- passed preview-v0.5.283：两包实际 CLI 经真实本地 shell/Node health/实时 RPC，Experiment 中文 Plan 等待确认回执、seed 覆盖 RPC 前拒绝通过（2 包测试）；实际包编译 Mac 文件/相对路径模块、队列身份与 Mac 面板语法通过。真实匿名 updater 从 0.5.282/0.2.76 筛出两组件，23 次请求完成大小/hash/CRC/身份/平台核验；下载字节与已测试 VSIX 相同，新增 PlanFiles/PosixPath/分布式合同及既有业务模块和两仓 README/配置说明与来源匹配。同版本跳过/禁止降级通过，无真实科研/SSH/M5。
- passed mac-005u-identity：Agent 持久接收、公共回执、旧队列派发和 recall/停止身份保留 Plan/outputDir 的大小写、Unicode、%20 与真实首尾空格；不把非字符串或反斜杠等坏相对路径改写后接收，非法旧 queued 行等待处理，active 行不修改。8 文件。编译函数隔离/本机队列与相邻模式、恢复、取消等回归通过，无真实科研/启动/停止/SSH/删除。
- 本批校验：build/219 闭包/面板脚本 2、macAgentPlanIdentity 5、模式 9/工作区 10/队列 29、旧 durable 1/idle admission 1/server queue 2/lifecycle 7 串行通过。初次路径 fixture 使用带空格文件名作为 commandId，与非路径 ID 的既有 trim 冲突，改为独立 ID。旧 durable 文件一次 Python 子进程触发 10 秒超时，Node 在 20 秒内退出；保留 fixture、加入 3 秒 faulthandler 诊断后通过，原因未复现，不改生产代码或放宽时间限制。
- passed mac-doc-016：两仓 README/配置说明补充配套 Agent 手动上传、Termius 启动/检测和精确队列身份冲突处理；原更新按钮/入口保留，隔离 Agent 路径/模式回归纳入发布门禁，6 文件。UTF8 回读、build/219 闭包/面板脚本 2、配置说明 1、发布门禁 4 通过。
- pending 下一批 mac-005u：远端 Agent 对 Plan/output_dir 的 strip 与 Windows 分隔符改写、结果/监控和归档 sidecar/写入边界继续适配；路径关键边界校验不是物理原子保证。先补说明与发布门禁，配套 preview。真实 SSH/三拓扑/M5 pending。


















### 相邻回归风险

- 基线仍包含 Windows 专属业务路径；首版仅用于更新链路验收，完整科研功能不得标记通过。
- 真机测试依赖用户 M5 设备，尚无证据。用户明确延后验收，授权继续其余适配及逐批发布；不再等待即时真机回传。

## 本批记录
- mac-doc-016 Experiment `5f9050682f1a6572c2168991893581e3daf85c9a`、SFTP `5ef5b48577c0d6053131436a94cb5bb0dc0fe18a` 已普通推送并 fetch 核对 origin/master。
- mac-005u-identity 已验证源码 `9111947576b5f38d5b7b0368da235969e651ee9a` 已普通推送并 fetch 核对 origin/master。
- mac-release-020 交付记录 `0a174e0cb58c8e2d957ffb9bfb558dc37cbeb275` 已普通推送并 fetch 核对 origin/master。
- 第二十版 preview-v0.5.283 已发布：Experiment 来源 `abd30492c850836db7be79e3eb00c93f58686aa5`、SFTP 0.2.77 来源 `c228688e29701a1ab5e7dbcc4af57ed8e5a2ff4b` 已普通推送并 fetch 核对。实际包 CLI/编译文件模块与匿名下载通过；完整科研/SSH/M5 pending。
- mac-doc-015 Experiment `9c0003371859033aaa8e674b0c5dbd83621f085d`、SFTP `3ae667adea74daa0b12e23ff795cc1275fb3820f` 已普通推送并 fetch 核对 origin/master。
- mac-005t-full 已验证源码 `2326d48fcd56d7b863ace27d827e30d868c94776` 已普通推送并 fetch 核对 origin/master。
- mac-005t 已验证源码 `7fd81e271bcd25e48f93b085133079540f3e3264` 已普通推送并 fetch 核对 origin/master。
- 第十九版 preview-v0.5.282 已发布：Experiment 来源 `c4c2bb163d667af2a582e6ff6d32b25ff7cf94d5`、SFTP 0.2.76 来源 `886c072b3e14452e880bc17a1c673e24031bc777` 已普通推送并 fetch 核对。实际包 CLI/编译身份模块与匿名下载通过；完整科研/SSH/M5 pending。
- mac-doc-014 Experiment `1ae861d3f265777f5e80789c13b0decae42036ad`、SFTP `04a7a3a6d5b1d4b9f67c92179cb2af5827e60865` 已普通推送并 fetch 核对 origin/master。
- mac-005s 已验证源码 `9aea7a1fc0b4260cc612b8248f43b0836f75e691` 已普通推送并 fetch 核对 origin/master。
- 第十八版 preview-v0.5.281 已发布：Experiment 来源 `b5fdcd6e68b8601efc74246e4b84043448e41a20`、SFTP 0.2.75 来源 `9a1b956c4ece2eacef4669112829196eafa63b1c` 已普通推送并 fetch 核对，实际包 CLI、编译异步运行模块及匿名下载通过；完整科研/SSH/M5 pending。
- mac-doc-013 Experiment 说明/门禁 `2c725d52db7e670b46c4885976c51ffb974f8210`、SFTP README `6c35407c32b7d2b91ba69b7e514508cc8da5d581` 已普通推送并 fetch 核对。
- mac-005r 已验证源码 `6f490cf28532598540ba2a059e34e5619dc49d6b` 已普通推送并 fetch 核对 origin/master。
- 第十七版 preview-v0.5.280 已发布：Experiment 来源 `07f147da7535218404ac69d6cd0abb68160a91fd`、SFTP 0.2.74 来源 `7464ac24324b12d1e6a3efdd9d3e0ff427074d0e` 已普通推送并 fetch 核对；实际包 CLI/工作区与 seed 边界及匿名下载通过。完整科研/SSH/M5 pending。
- mac-doc-012 Experiment 说明/门禁 `bff6c01119713147e5ca7c7ce8da023b315c126a`、SFTP README `f772588be895e44d288fbdff986acd44a9b8e177` 均已普通推送并 fetch 核对。
- mac-005q 已验证源码 `6a30a571502b697d70a40435a0c0e363246d0440` 已普通推送并 fetch 核对 origin/master。
- 第十六版 preview-v0.5.279 已发布：Experiment 来源 `0c58484ae8df959ddb9f4ecf162437baf6ef08be`、SFTP 0.2.73 来源 `1ae3c9da45ddb1364f6a3ae1c16955bbf1e5ee55` 均已普通推送并 fetch 核对，真实包 Plan CLI 等待确认与匿名下载通过。完整科研/服务端 workspace/seed/SSH/M5 pending。
