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

## 当前批次：mac-release-018（passed，配套 preview-v0.5.281）
### 边界

- 两仓版本与 RuntimeManifest 对齐，发布 Experiment 0.5.281 / SFTP 0.2.75 同一 preview Release，绑定已同步来源；6 文件，生成产物不计。保护业务/旧入口/历史附件。
- 检查：两仓 build/包闭包/面板脚本、runtime manifest、完整 prepare 串行门禁、实际 VSIX CLI 与匿名 updater，核验草稿附件后公开。无 Actions/自动安装/真实科研/SSH/停止/删除；M5 待验收。

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
- pending 下一批 mac-005s：Plan 标识的 Mac 大小写与真实空格规则。现存 DistributedPlanQueue.samePlanFile/automatic retry latest 和 legacy normalizePlanSelectionKey/planFileEquivalenceKeys 仍沿 Windows 折叠规则；核验实际选择、重试与队列身份并保留 API/Plan/旧入口。结果/监控/Windows 依赖和队列/同步写入边界后续继续；关键边界检查不是完整远端预演或物理原子保证，真实 SSH/三拓扑/M5 待验收。


















### 相邻回归风险

- 基线仍包含 Windows 专属业务路径；首版仅用于更新链路验收，完整科研功能不得标记通过。
- 真机测试依赖用户 M5 设备，尚无证据。用户明确延后验收，授权继续其余适配及逐批发布；不再等待即时真机回传。

## 本批记录
- 第十八版 preview-v0.5.281 已发布：Experiment 来源 `b5fdcd6e68b8601efc74246e4b84043448e41a20`、SFTP 0.2.75 来源 `9a1b956c4ece2eacef4669112829196eafa63b1c` 已普通推送并 fetch 核对，实际包 CLI、编译异步运行模块及匿名下载通过；完整科研/SSH/M5 pending。
- mac-doc-013 Experiment 说明/门禁 `2c725d52db7e670b46c4885976c51ffb974f8210`、SFTP README `6c35407c32b7d2b91ba69b7e514508cc8da5d581` 已普通推送并 fetch 核对。
- mac-005r 已验证源码 `6f490cf28532598540ba2a059e34e5619dc49d6b` 已普通推送并 fetch 核对 origin/master。
- 第十七版 preview-v0.5.280 已发布：Experiment 来源 `07f147da7535218404ac69d6cd0abb68160a91fd`、SFTP 0.2.74 来源 `7464ac24324b12d1e6a3efdd9d3e0ff427074d0e` 已普通推送并 fetch 核对；实际包 CLI/工作区与 seed 边界及匿名下载通过。完整科研/SSH/M5 pending。
- mac-doc-012 Experiment 说明/门禁 `bff6c01119713147e5ca7c7ce8da023b315c126a`、SFTP README `f772588be895e44d288fbdff986acd44a9b8e177` 均已普通推送并 fetch 核对。
- mac-005q 已验证源码 `6a30a571502b697d70a40435a0c0e363246d0440` 已普通推送并 fetch 核对 origin/master。
- 第十六版 preview-v0.5.279 已发布：Experiment 来源 `0c58484ae8df959ddb9f4ecf162437baf6ef08be`、SFTP 0.2.73 来源 `1ae3c9da45ddb1364f6a3ae1c16955bbf1e5ee55` 均已普通推送并 fetch 核对，真实包 Plan CLI 等待确认与匿名下载通过。完整科研/服务端 workspace/seed/SSH/M5 pending。
