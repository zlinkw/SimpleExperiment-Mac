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

## 当前批次：mac-release-010（running，Mac 只读检测 preview 发布）
### 边界

- 本批递增 Experiment 0.5.273/SFTP 0.2.67，本地打包验证两包与清单、发布同一 preview，并以匿名 updater 核对说明和只读检测实现。最多 8 文件，不自动安装、Actions 或真实服务器操作。
- 保护三拓扑、API/Plan、更新事务、认证/租约、远端实验和删除规范。M5 pending。POSIX 全业务路径与科研业务链下一批审查。

### 验证清单

- passed mac-release-010 源码门禁：Experiment 0.5.273 build/213 模块闭包/vm.Script、面板脚本 2、发布 3 测试逐文件串行通过，package/lock/runtime 版本一致；完整 prepare/publish 与匿名下载随后核验。
- passed mac-005g：Mac 版本/哈希检查不自动部署或重启；失败进入 Plan 缺项。bootstrap 未手动启动时记录 blocked/manual_start 与指引/后续预览；启动后可禁用两类上传，通过当前版本/哈希与 Plan 校验才成功。确认 scope 绑定工作区、端点/端口、Python、tmux 前缀与 token，后台确认变化拒绝执行。
- passed mac-005g 本地：build/面板脚本 2、213 模块闭包/vm.Script；准备/bootstrap 16、端点/UI 9、配置说明 1、runtime 范围 4、manifest 1 测试逐文件串行通过。三拓扑均覆盖阻塞、免重复上传复检、坏哈希、Plan 失败、只读无自动部署/重启与配置变更。README/配置说明 UTF8 及真实 API 方法回读通过。真实 SSH/M5 仍 pending，下一批发布 Experiment 0.5.273/SFTP 0.2.67。
- passed mac-release-009：Experiment 0.5.272/SFTP 0.2.67 完整 prepare/publish 通过，两仓 build/213 与 24 文件包闭包、面板脚本、更新目标测试逐文件串行通过；项目准备 10、手动端点/UI 9、配置说明 1、浅/深/高对比真实渲染通过。完整草稿 3 附件大小/SHA-256 核验后公开发布。
- passed preview-v0.5.272 真实匿名 updater：从 0.5.271/0.2.67 筛选到 Experiment 单组件升级，下载两包核验平台/hash/CRC/身份；包内 README/配置说明、实际准备命令标题、准备实现、Mac 面板入口与 LF askpass 核验通过；同版本跳过且禁止降级。没有自动安装、Actions 或真实 SSH，M5 仍 pending。
- pending 下一批 mac-005g：审查 project.bootstrap/科研运行前准备链的 Mac 手动端点与 Agent 检测边界、POSIX 路径一致性；保留既有科研契约，每批最多 8 文件。M5 证据回传前不得标记真实科研验收通过。
- passed preview-v0.5.271 完整 prepare/publish：两包及清单草稿附件大小/SHA-256 完整核验后公开发布。真实匿名 updater 从 0.5.270/0.2.66 筛选两个升级包，下载核验平台/hash/CRC/身份、包内中转代码/close 保护、LF askpass 和 Mac 说明；同版本跳过、禁止降级。无本机安装、Actions 或真实服务器操作，M5 仍 pending。
- passed mac-005f：Mac project.prepare 与“准备 Agent”使用严格端点、SimpleSFTP runtime/项目上传、绑定配置/工作区的确认预览和 Termius/tmux 指引。取消或配置变化不上传；明确检测及 runtime 哈希证据前不标记 Agent 就绪。修复 SFTP readiness 字段别名和显式空环境使用 python3。
- passed mac-005f 本地：build、213 模块包闭包/vm.Script；项目准备 10、端点 7、拓扑 5、runtime 范围 4、SSH 身份 9、manifest 1 测试逐文件串行通过。此前 VM 缺少既有方法/依赖导致失败，补充真实方法与上传回执实现后通过，均非超时。没有真实服务器或 M5 操作。
- passed mac-doc-005：README/配置说明补全准备按钮、确认上传、runtime/项目路径和手动启动边界；命令标题、服务器卡片、运行环境按钮及 Mac readiness 同步，绕过 Xshell 会话门禁。新增项目准备发布门禁。8 文件已核对。
- passed mac-doc-005 本地：build/面板脚本 2、213 模块闭包/vm.Script、端点/UI 9、项目准备 10、配置说明 1、发布 3 测试逐文件串行通过；UTF8 文档及命令标题回读通过。首次验证误用了不存在的测试文件路径，改为已有 test/scripts/macRelease.test.js 后通过，非超时。下一批递增 Experiment 0.5.272，SFTP 保持 0.2.67，发布配套 preview。
- passed mac-release-008：两仓 build/24 与 213 模块闭包、面板脚本 2、发布 3 测试逐文件通过；版本/lock/runtime 一致和 diff 核验通过。完整 prepare/publish 与匿名下载已完成。
- passed mac-005e：两仓 build/24 与 213 模块闭包、面板脚本 2、中转 9、跨服务器 13、认证 8、恢复 25、上传进度 4、压缩协商 9、真实本地 Python 接收/断点协议 5、配置说明 1、发布 3 测试逐文件串行通过。真实完整 Mac 分批流程在模拟 SSH 上覆盖双端清单/跳过相同/哈希复核、中文路径、无嵌套 SSH、背压、8MiB 断点、三压缩模式、双 close、启动/管道失败与未知接收结果门禁。
- passed preview-v0.5.270 完整 prepare/publish：双包与清单草稿附件大小/SHA-256 完整核验后公开发布。真实匿名 updater 从 0.5.269/0.2.65 筛选到两个升级包，下载并核验平台/hash/CRC/身份及包内认证代码、LF askpass、README/配置说明；同版本跳过，禁止降级。未自动安装扩展，M5 和真实 SSH 仍未执行。
- passed mac-release-007：两仓 build/24 与 213 模块闭包、面板脚本 2、发布脚本 3 测试逐文件通过；版本/lock/runtime 一致、askpass LF 和 diff 核验通过。完整 prepare/publish 与匿名下载已完成。
- passed mac-doc-004：两仓 build/24 与 213 文件包闭包、面板脚本、配置说明 1、发布 3、认证 8 测试逐文件串行通过；三文档 UTF8 回读、命令标题、链接及 askpass LF 规则核验通过。配套版本已发布为 Experiment 0.5.270/SFTP 0.2.66。
- passed mac-005d：SFTP build/24 文件闭包、独立认证 8、真实映射下载 26、API 19、跨服务器既有协议 13、上传进度 4、结算恢复 25、工作区 5 测试逐文件串行通过。真实本机 Node askpass IPC、服务器凭据隔离、未勾选不保存/读取、重载 SecretStorage、加密私钥、并发/取消/限次和 child.close 回执覆盖；未连接真实 SSH 服务器。
- failed 旧上传进度 VM 回归：缺少已存在更新门禁的 require 注入，另需注入新的 SSH 包装器；修正测试依赖后 4 测试通过，非超时。为遵守 8 文件上限，README 修订已保存到系统暂存区，随后文档批恢复。

- passed mac-doc-003：build/面板脚本、213 模块闭包/vm.Script，配置说明入口 1、端点 7、发布 3 测试逐文件串行通过；UTF8、真实命令标题、文档链接、JSON 严格端点转换及版本/lock/runtime 一致核验通过。全文说明用户设置/工作区设置差异和不自动部署的指引边界。

### 相邻回归风险

- 基线仍包含 Windows 专属业务路径；首版仅用于更新链路验收，完整科研功能不得标记通过。
- 真机测试依赖用户 M5 设备，尚无证据。用户明确延后验收，授权继续其余适配及逐批发布；不再等待即时真机回传。

## 本批记录
- mac-005g Experiment `70d2bc70fb3a443e084f69870a452397c09b705d` 已普通推送并 fetch 核对；三拓扑手动 bootstrap、免上传复检、只读版本/哈希检查与确认边界本地模拟通过。
- 第九版 preview-v0.5.272 已发布：Experiment 0.5.272 来源 `9779b1ec2a30afd2c8092a557d1f0dc118a71bbb`，SFTP 0.2.67 来源 `9d40d42c95015faa6c60548ac4caba7f7bc5edac`；两仓源码已同步。Mac 说明优先、准备上传/手动启动入口与匿名包下载本地通过，真实 SSH、M5 与科研主流程仍 pending。
- mac-doc-005 Experiment `a22f8777f9292b2e815224144fb1790e1b6ea78a` 已普通推送并 fetch 核对；Mac 说明、准备按钮与 readiness 本地通过。
- mac-005f Experiment `4578eb60cff4102653070fee9bbfce382b0449cb` 已普通推送并 fetch 核对；Mac 项目/runtime 准备本地模拟通过，真实 SSH/M5 仍 pending。
- 第八版 preview-v0.5.271 已发布：Experiment 0.5.271 来源 `ca03b1a7007e94db74f0784fc634caea56f1695f`，SFTP 0.2.67 来源 `9d40d42c95015faa6c60548ac4caba7f7bc5edac`。两仓源码已同步；普通 tar 与断点分块的本机中转、失败结算及实际匿名包下载通过本地验证；真实 SSH、M5 与科研主流程仍 pending。
- mac-release-008 SimpleSFTP 0.2.67 来源 `9d40d42c95015faa6c60548ac4caba7f7bc5edac` 已普通推送并 fetch 核对。
- mac-005e Experiment `6730d1131937df8844430699f65e5e26461a2dd6` 已普通推送并 fetch 核对。
- mac-005e SimpleSFTP `b756465b4300f8de320eb9a4b21fdbbfaa9c3caf` 已普通推送并 fetch 核对；Experiment 同批说明和发布门禁提交见 Git。
- 第七版 preview-v0.5.270 已发布：Experiment 0.5.270 来源 `d1e8831e37dd938b3abf5d3ec09a54fec9931330`，SFTP 0.2.66 来源 `f3fb8b6bfdbcdc010153470fbfebcea857ce68e6`。两仓源码已同步；本地独立认证与匿名更新下载通过，真实 SSH、M5 在线安装和科研主流程仍 pending。
- mac-release-007 SimpleSFTP 0.2.66 来源 `f3fb8b6bfdbcdc010153470fbfebcea857ce68e6` 已普通推送并 fetch 核对。
- mac-doc-004 Experiment `687be53d9ff5445b35de76ae10c0c8d63b262af1` 已普通推送并 fetch 核对。
- mac-doc-004 SimpleSFTP `d74b1ea818b387e294e0c1b5840c4df249849211` 已普通推送并 fetch 核对；Experiment 同批提交见 Git。
