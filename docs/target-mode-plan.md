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

## 当前批次：mac-005v-results（passed，Mac 结果与监控路径身份）
### 边界

- 本批 7 文件，统一结果 Plan 映射/TS 与 Python key、完成运行/attempt 来源、后台选择/通知/查看路径。保护统计公式、Plan/API、原入口和更新；只编译模块 VM、AST 函数与本机模拟，无真实科研/远端/传输/删除。
- passed build/219 闭包/面板 2、vm.Script、remoteResultInspectionWorkflow 13、resultCsvDirectoryConfig 6、datasetResultCatalog 7，逐文件串行 20 秒，UTF8/diff 检查通过。初次失败为旧夹具缺少依赖/已变更入口及原设置命名空间，按实际源码更新后通过，无超时；无业务生产修复混入此提交。
- passed build/219 闭包/面板脚本 2、vm.Script；macResultIdentity 8、macProjectPrepare 16、macWorkflowBinding 10、projectResultTables 19、manualDistributedResultSync 25、projectResultSyncCompleteness 18、remoteResultInspectionWorkflow 13、resultCsvDirectoryConfig 6、datasetResultCatalog 7、macPlanIdentity 6 逐文件串行 20 秒通过。UTF8/diff 检查通过；VM/AST/local mock 无真实科研/传输。
- Mac Plan 映射、完成运行筛选、attempt/hash 路径、API 选择、失败通知和轻量查看保留大小写/中文/首尾空格；TS/Agent 目录 key 对齐，错误类型/非法路径拒绝。配置非法结果目录须用户修正，不再回退默认值。UI 候选、Agent 结果读取、物理发布/归档及 M5 仍 pending；下一批仅同步 Mac 使用说明和发布门禁，最多 6 文件，再配套发布。

### 验证清单

- passed mac-release-022：npm run release:prepare 完整两仓 build、219/26 闭包、面板脚本 2 与 44 个目标测试文件逐文件串行门禁通过（Experiment feature 29 + core 1，SFTP 14），包括新增启动路径/模式及浅深高对比实际渲染。npm run release:publish 上传三个完整草稿附件，大小/hash 核验后公开；不触发 Actions 或安装扩展。
- passed preview-v0.5.285：实际两包固定 CLI 经真实本机 shell/Node health/实时 RPC，中文 Plan 等待确认 submitted=false 与 seed 覆盖 RPC 前拒绝通过（2 包测试，含 Agent 持久身份 5 场景）；另一个实际 VSIX 的 Agent/scheduler AST 隔离回归 8 场景通过（真实条目、启动参数、依赖期间变化、全文 revision、输出/工作目录、attempt、key、入队）。本机 POSIX 模拟，无真实科研/SSH/启动/停止/删除。
- passed 匿名更新：实际 updater 从 0.5.284/0.2.78 筛出两个新组件，25 次公开请求完成大小/hash/CRC/身份/平台核验；下载字节与已测试 VSIX 一致，编译 Agent/scheduler/业务模块与两仓 README/包内配置说明匹配来源。同版本跳过/禁止降级通过，不实际安装；M5 pending。
- passed mac-doc-017：两仓 README/配置说明按 Mac 用法保持同步，更新按钮入口与 Agent 手动升级步骤保留，启动路径边界/本地与 M5 验证明确，新增 macPlanLaunchPaths 与相邻 mode 回归门禁；发布说明改为当前变化和验证边界。6 文件。
- passed mac-005u-launch：Agent 的 projectDir/Plan/output/config/log/默认结果目录保留真实路径拼写，路径别名冲突与错误类型先拒绝；Plan、已有输出/日志父项按实际目录条目/类型校验并拒绝链接，依赖检查后复核。原 Plan revision 读取全文并复核模式；scheduler 的输出、工作目录、输入/输出、attempt 覆盖与状态 key 保留真实拼写，非法输出在 runtime/入队前拒绝。隔离 AST 编译函数与模拟 POSIX 文件系统，无实际科研/SSH/启动/停止/删除。
- passed 本批：build/219 闭包/面板 2、vm.Script 与 6 个目标测试文件通过；旧模式 fixture 在 Windows 使用默认反斜杠 schedulerPath，改为明确的虚拟 POSIX 路径后通过，非超时。物理检查与启动/写入之间并非原子锁定，scheduler 结果/归档及 M5 仍 pending；说明与配套发布已完成；下一批限定结果/监控路径或归档写入的一组相关问题，保持更新说明同步。
- passed mac-release-016：完整本机 prepare/publish、两仓 build/217 与 26 文件闭包、面板脚本 2、逐文件串行更新/CLI/路径/认证/中转与浅/深/高对比真实渲染通过。三个完整草稿附件核验后发布，无 Actions/开发机安装。
- passed preview-v0.5.279：实际两包固定 CLI 通过真实本地 shell/Node health/实时 RPC，Experiment 实际包以中文 Plan、本机 mock 完成工作区/路线预检与等待确认回执，submitted=false（2 项包测试）。真实匿名 updater 从 0.5.278/0.2.72 筛出两组件，19 次请求完成大小/hash/CRC/身份/平台校验；下载字节与已测试 VSIX 一致，新 CLI 模块、两仓 README/配置说明与来源一致。同版本跳过/禁止降级通过，无实际科研/服务器/M5。
- passed mac-005q：服务端 Mac workflow 绑定当前物理工作区，异步准备/校验/标准 Plan 关键边界复核，晚到回执不写入另一工作区；精确保留 Plan 首尾空格。CLI/API seed override 显式拒绝，正式种子沿用保存的 Plan，离线预览不宣称应用 seed。Mac 提交不执行旧自动停止 fallback，活动运行在创建回执及提交前拦截。8 文件。
- passed 本地：build/218 模块闭包/面板脚本 2、macWorkflowBinding 6、macCliWorkflow 6、macProjectPrepare 16、localApi 标准路线相关 5 逐文件串行通过；测试为编译方法 VM/本机 mock，无真实科研/SSH/停止/删除。初次 VM fixture 缺少编译导入别名，补齐后通过，非超时。
- passed mac-doc-012：两仓 README/配置说明补全当前真实工作区、活动运行与保存 Plan seeds；在线覆盖明确报错、离线不应用、旧手工记录器边界，更新按钮入口保留。新工作区回归纳入发布门禁，发布说明区分本地/M5。UTF8 回读、build/218 闭包/面板脚本 2、配置说明 1、发布门禁 4 通过，6 文件。
- passed mac-release-017：完整本机 prepare/publish、两仓 build/218 与 26 文件闭包、面板脚本 2、逐文件串行更新/工作区/CLI/路径/认证/中转及浅深高对比实际渲染通过；3 个完整草稿附件核验后发布，无 Actions/自动安装。

### 相邻回归风险

- 基线仍包含 Windows 专属业务路径；首版仅用于更新链路验收，完整科研功能不得标记通过。
- 真机测试依赖用户 M5 设备，尚无证据。用户明确延后验收，授权继续其余适配及逐批发布；不再等待即时真机回传。

## 本批记录
- mac-005v-fixtures `5ac6eff31c5e673b75f0a64cd60af475540fbbba` 已普通推送并 fetch 核对 origin/master；三个旧结果夹具恢复有效覆盖，压力目录保留。
- mac-release-022 交付记录 `2b9993d6b44e69c4a17580d1acf520a1a268fa62` 已普通推送并 fetch 核对 origin/master。
- 第二十二版 preview-v0.5.285 已发布：Experiment 来源 `4585fb5c786b9e4ee952eeb8b9ce3e83090348d8`、SFTP 0.2.79 来源 `0d96e4388f7e5b4e51eb63bba0ced62cd2f3224c` 已普通推送并 fetch 核对，实际包启动路径与匿名更新验证通过。
- mac-release-022 SFTP 0.2.79 来源 `0d96e4388f7e5b4e51eb63bba0ced62cd2f3224c` 已普通推送并 fetch 核对 origin/master。
- mac-doc-017 Experiment `bcce84caf80ebe3fef0c763c52878c8afe73dc31`、SFTP `ce291edd7892cd8ae090f3a86c4aaceefdc052c3` 已普通推送并 fetch 核对 origin/master。
- mac-005u-launch 源码 `75cd40e65bd179797a660056e87398afc1778e6a` 已普通推送并 fetch 核对 origin/master。
- mac-release-021 交付记录 `4d9c47df77d420eb350264d84649caa2dce9e5eb` 已普通推送并 fetch 核对 origin/master。
- 第二十一版 preview-v0.5.284 已发布：Experiment 来源 `98edc7016be5a3c184ddef78315418328c2f1f07`、SFTP 0.2.78 来源 `cc948773d51014069826fb628bfe9dd7a10df671` 已普通推送并 fetch 核对。实际包 CLI/Agent 身份与匿名下载通过；完整科研/SSH/M5 pending。
- mac-doc-016 Experiment `5f9050682f1a6572c2168991893581e3daf85c9a`、SFTP `5ef5b48577c0d6053131436a94cb5bb0dc0fe18a` 已普通推送并 fetch 核对 origin/master。
