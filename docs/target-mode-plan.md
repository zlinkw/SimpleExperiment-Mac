# 目标模式当前计划：mac 适配，更新发布优先

字符上限 12000，达到 10800 自动压缩。保留当前目标、验证、风险、下一批边界和真实提交记录；历史详见 Git。

## 固定边界

- 当前目标：交付两款独立 darwin-arm64 preview 扩展及完整配套更新、本机 GitHub Releases 发布链路，再完成 mac 科研业务适配。
- 公开仓库 SimpleExperiment-Mac、SimpleSFTP-Mac，提交并普通推送 origin/master；只复制原项目已提交源码，不改变 Windows 项目。
- 支持 macOS 26 及以上 Apple Silicon；M5/macOS 27.0 用户真机验证尚未执行。
- 首版排除 PPT 自动绘图、Dev Containers、Intel Mac、Actions、zlinkw.shop、历史附件自动清理。
- 保护三拓扑、业务 API、Plan 格式、远端实验、删除直接父目录校验与两次确认；保留原入口至用户批准移除。
- 测试逐文件串行，20 秒限时。构建、包闭包和面板脚本验证是交付门禁。发布不安装开发机扩展。
- 每批最多 3 个关联问题、8 个源/文档/测试文件；初始源快照导入不作为代码改写批次。

## 后续优先级

- pending mac-002：独立身份、命名空间、发现目录及最小启动，按文件组分批迁移。
- pending mac-003：独立更新引擎、preview 筛选/缓存/限流、校验及更新事务、业务门禁。
- pending mac-004：本机 prepare/publish、双仓提交绑定、包闭包与两版 preview 交付。
- pending mac-005：Termius 手动隧道、mac 路径/租约/CLI、认证与本机流式中转。
- pending mac-006：真机更新及科研三拓扑验收，用户回传证据后完成。

## 当前批次：mac-doc-002（passed，苹果电脑配置说明）

### 边界

- 用户追加优先级：面板“配置说明”和两仓 README 先按苹果电脑使用方式更新，随后深色配色，再恢复 Termius/认证主流程；本批最多 8 个文件。
- Mac 配置说明不再触发旧 Xshell onboarding；明确现有操作入口与待适配能力。深色模式混合亮背景问题 pending，不在本批修改。

### 验证清单

- passed mac-doc-002：两仓 build/包闭包/面板脚本通过；配置说明真实编译方法测试 1、SFTP 品牌测试 2 逐文件串行通过；UTF8、文档链接、JSON 示例和实际命令标题核对通过。两仓 README、包内配置说明、设置字段解释共 8 文件；Mac 打开说明不进入旧会话向导。
- 下一批边界：版本递增并发布本批 Mac 说明，随后深色模式；Termius/认证继续保留待适配标记。
- pending 深色模式：用户截图显示亮色页面/卡片与深色输入混用，文字对比不足。后续独立批次复现并验证浅色/深色/高对比。
- 用户截图可证明 0.5.266/0.2.64 面板显示版本与成功检查状态；未证明从首版安装升级、设置保留或科研验收。

- passed mac-005b 两仓 build/包闭包/面板脚本；Mac 宿主/租约路径 2、SFTP Mac 路径 1、SFTP 跨窗口资源租约 9、更新门禁 1 测试逐文件通过；大小写不同的 POSIX 根不共享进程内索引。

- passed mac-release-003 两仓 build/包闭包/面板脚本、发布脚本语法与 3 测试；新增路径与更新卡片测试逐文件串行纳入 prepare。
- passed preview-v0.5.266 prepare/publish、完整附件核验、实际匿名客户端从 0.5.265/0.2.63 识别两个升级包、下载/平台/hash/CRC 与包内新 README 检查；M5 仍 pending。

- passed mac-ui-001 build/面板脚本/212 模块闭包、独立更新 3 测试和实际设置卡片渲染 1 测试；组件版本/安装并重载按钮与检查失败状态一致。

- passed 两仓 README UTF8 回读、真实贡献命令标题匹配及文档链接检查；已说明底部状态栏、命令面板、设置检查按钮、首次安装顺序、失败/补装与待验收范围。

- failed 首次 release:prepare：SFTP API 导出测试使用 200 字符窗口，新增 idle 导出后误报。未生成发布附件或草稿。
- passed SFTP 改用实际加载后的 API 导出断言，API/CLI 19 测试及 build/21 文件闭包通过；失败并非超时。
- passed mac-004d prepare、完整草稿附件 SHA-256 核验后发布、实际匿名客户端下载并验证两包身份/版本/platform/CRC/hash；M5 真机验收仍 pending。
- passed mac-004e 部分更新二次失败门禁 6 测试、两仓 build/闭包与面板脚本；第二版 prepare/publish 待同步后执行。
- passed mac-004e 第二版 preview-v0.5.265 完整草稿附件核验后公开发布，两组件 0.5.265/0.2.63；真机升级待验证。
- passed mac-005a Experiment 路径 7、SFTP 路径 6/工作区集成 5 测试，两仓 build/闭包/面板脚本；中文/空格/字面百分号/大小写、Mac 资源租约与 Containers 拒绝覆盖。SFTP 旧 namespace 错误提示修正后回归通过。

- passed mac-004c 发布脚本语法及 3 测试：完整附件/hash、无安装/Actions/覆盖、已发布版本严格递增。实际 prepare/publish 随后执行。

- passed mac-004b 两仓 build/闭包、面板脚本、源版本方向与 runtime 同步断言；SFTP 品牌/设置 2 测试。

- passed mac-004a 发布脚本语法、完整附件与 hash/禁止覆盖门禁 2 测试、build/面板脚本与 212 模块闭包。实际 prepare/publish 待源码同步后执行。

- passed mac-003e SFTP build、21 文件闭包、bootstrap/门禁 2、品牌/设置 2、API/CLI 19 测试，均逐文件串行。

- passed mac-003d build/面板脚本、212 模块闭包、独立启动/检查失败/一次提醒 3 测试、跨窗口门禁与既有传输退出等待 1 测试。

- passed mac-003c build/面板脚本、更新事务 5 测试：完整预验证、部分安装回执/补装、并发点击、传输等待、同版/新版本跳过及缺失回执恢复。

- passed mac-003b build/面板脚本、preview 6 测试：列表筛选、禁止降级、伪造/不兼容拒绝、并发合并/ETag、403/429 与离线失败、响应上限。

- passed mac-003a build、包闭包、VSIX 3 测试：真实 XML 平台、Windows/universal/身份/engine/hash 拒绝、CRC 损坏及越界 ZIP。

- passed mac-002e build、面板脚本、业务字段兼容断言、包闭包；namespace 替换保留 simpleSftp 业务变量。

- passed mac-002d build、面板生成脚本 2 测试/ vm.Script、195 模块闭包。

- passed mac-002c build/面板脚本、195 模块闭包、namespace/更新源隔离和禁止跨身份读写断言。

- passed mac-002b build、typecheck、195 模块包闭包、身份/namespace/版本/路径断言及面板脚本。runtime 版本同步后再次 typecheck，保证编译版本一致。

- passed 两仓源快照逐字节核对，公开 remote 与 master 核对。
- passed Experiment build、面板 vm.Script、闭包 194 模块、计划压缩 3 测试；SFTP build、18 文件闭包。
- passed 本批编辑 diff 检查。导入快照含原有空白错误，保留原内容，不混入格式改写。
- passed 初始快照提交、普通推送和 fetch 后 HEAD 等于 origin/master。
- passed SFTP 身份/路径断言、build、19 文件闭包、API/CLI 19 测试。首次 API 测试失败来自旧 namespace 与 CLI 环境变量，测试契约迁移后通过。

### 相邻回归风险

- 基线仍包含 Windows 专属业务路径；首版仅用于更新链路验收，完整科研功能不得标记通过。
- 真机测试依赖用户 M5 设备，尚无证据。用户明确延后验收，授权继续其余适配及逐批发布；不再等待即时真机回传。

## 本批记录

- mac-doc-002 SFTP `8d93015bdf4ee6870deb05eee388d37fd0cfc4cb` 已同步；Experiment 同批提交见 Git，发布批次记录真实提交。
- 第三版 preview-v0.5.266 已发布，Experiment 来源 `9e45701bfe615c357ec407442e8a0ef688f63b1e`，SFTP 0.2.64 来源 `6172ae89b6a0da411c2219d6f9a9c0ce6b72ee81`。
- mac-005b 已完成并同步：Experiment `c9649aecbe75364a03f3a21f88253398d32dc45d`、SFTP `e9056979e5eaef4070c0407add8076afc1dfefa0`。Termius 手动端点与独立认证待后续批次。

- mac-ui-001 Experiment `0d7c786513fb1b45a9e758f9b1ef5079bb8b3785` 已同步。

- README 使用说明 Experiment `87091f79d3f62891d7db2604d92cc7a7b9190416`、SFTP `0cb2e5fbde5b02b9f0131ed9fab3e71d95e3aeff` 已同步。

- mac-005a 源码 Experiment `64daf727d93f957786948398b5a319700fc5f72f`、SFTP `75347fae83eb6b5c5fe68acc679f49bb56b69120`，两仓均已同步。

- 第二版 preview-v0.5.265 源码 Experiment `3b65c44085d66e1b0ab30db4e503c5fbc25eaddf`、SFTP `155d6e3605313bd0955b884202eef9a693160454`，两仓均已同步。

- 首版 preview-v0.5.264 已公开发布，Experiment 0.5.264 来源 `bb831e32544c575b3a675e7fde5458c97d03a933`，SFTP 0.2.62 来源 `e755d8d62aae4c6f82fa7a549f9b4627012f1d6b`。完整附件及源码绑定已验证。

- mac-004c Experiment `5ca1a415edf6995e6d9f21649bd9aa108263f618` 已同步；SFTP API 测试修复 `e755d8d62aae4c6f82fa7a549f9b4627012f1d6b` 已同步。

- mac-004b Experiment `bb69ac46d4be45526922a5d5c85c194d6fa9ce1f`、SFTP `a9f39db0f7fc2747803c2052bbfa54226f43fa27` 已同步。

- mac-004a Experiment `e63faaa281861761484c43e382d8c1dab5df4431` 已同步 origin/master。

- mac-003e SFTP `3ef462678671e96768dfe1cbd36101dc46eb5791`、记录 Experiment `59987dc8e3c96bbba7f93c0ae60b722466af8695` 已同步。
- mac-003e2 SFTP `6f547b9e77cf4fef771556ac97055f198c94d58d` 已同步；补齐 idle 导出并测试控制器 dispose 加子进程 close 双证明，build/21 文件闭包/3 测试通过。

- mac-003d Experiment `c1ab176b9130b9eb4522915a1be69eb82e43ecdb` 已同步 origin/master。

- mac-003c Experiment `a54da0b933030a17c1a949a57cfe1d1402762320` 已同步 origin/master。

- mac-003b Experiment `cb8aa45ce6527b8abe1f536631bb10ce707ae9ba` 已同步 origin/master。

- mac-003a Experiment `38ad7c4b06495030e9b1cb227babf37fdd1a70a3` 已同步 origin/master。

- mac-002e Experiment `8d27d316eb2c798653b6fafed04757dbac6973a5` 已同步 origin/master。

- mac-002d Experiment `b9ce16841d0385608660943a0a7c5f74f6b97824` 已同步 origin/master。

- mac-002c Experiment `b70583431aad238d94001cdcf5e1bb20c56f3826` 已同步 origin/master。

- mac-002b Experiment `18142b1211ddb549d43d9359158df52f21b92457` 已同步 origin/master。

- mac-001 Experiment `2f11164d3f33ac979884519b239232c5d553bfe9`、SFTP `80cf31ab1d0a3a39579c9cfbd9bf99966bbc1f4b`，均已同步 origin/master。
- SFTP 首次包列表校验 8 秒超时，独立测量 1218 ms，未改超时阈值，完整 build 再验证通过。
- mac-002a SFTP `d71ff43ce679b8f9bb6fcde8dc0b2c75a5b3e5ce` 已同步，Experiment 记录提交 `d18945312019ae9c92ea538a032d961fd3a98c51`。
- 下一批边界：剩余命名空间和独立最小启动。
