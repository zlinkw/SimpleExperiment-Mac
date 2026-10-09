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

## 当前批次：mac-003d（passed）

### 边界

- 独立最小启动、30 分钟检查/手动入口/一次提醒、更新落盘/恢复、跨窗口共享租约及业务门禁，6 文件。
- 保护入口，阻断 Mac 自动导入 Windows 扩展数据库；下批处理 UI/其余业务 namespace。

### 验证清单

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

- 基线仍包含 Windows 专属路径和旧更新逻辑，尚不适合作为 Mac 安装包发布。
- 真机测试依赖用户 M5 设备，尚无证据。

## 本批记录

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
