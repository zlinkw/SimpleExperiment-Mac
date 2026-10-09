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

## 当前批次：mac-release-014（passed，固定 CLI preview）
### 边界

- Experiment 0.5.277/SFTP 0.2.71，只改版本及计划，最多 8 文件。完整本机 prepare/publish，草稿全附件大小/hash 核验后公开；匿名 updater 验证两包身份/版本/平台/源码/说明，真实 VSIX 中 CLI 使用本地 shell/Node/health mock 启动。
- 不安装插件/修改 PATH/Actions/覆盖历史附件/真实 SSH/研究操作，保留旧入口。CLI 业务契约和完整科研主流程/M5 后续批次。

### 验证清单

- passed mac-release-014：`npm run release:prepare` 完整本机门禁通过，Experiment build/215 模块闭包、SFTP build/25 文件闭包、面板脚本 2、逐文件串行更新/CLI/路径/认证/中转与浅/深/高对比渲染通过。`npm run release:publish` 核验三个草稿附件后发布 preview-v0.5.277；未安装插件或使用 Actions。
- passed preview-v0.5.277：实际 VSIX 解包后，两款固定入口通过真实本地 POSIX shell/Node、中文发现文件与本机 health mock 自检（2 项），LF/源码版本匹配。真实匿名 updater 从 0.5.276/0.2.70 筛出两组件，17 次请求完成清单和包校验；下载字节与已通过 CLI 自检的本地 VSIX 完全一致，两仓源码/README/配置说明匹配。同版本跳过、禁止降级通过；无真实 SSH 或 M5 验收。
- pending 下一批 mac-005n：CLI 实时本机 API 契约、发现文件与业务命令适配，保留旧入口；单批不超过 8 文件。完整科研三拓扑与 M5 验收保持后续边界。

- passed mac-doc-009：两仓 README/配置说明补全 CLI 查看/复制命令、固定路径、Node 20+/PATH、更新重载、自检及未知文件处理边界；双仓 CLI 5/5 测试纳入发布门禁。UTF8 回读、Experiment build/215 模块闭包/面板脚本 2、配置说明 1、发布 4 与双仓 CLI 逐文件串行通过，共 6 文件。下一批 Experiment 0.5.277/SFTP 0.2.71，CLI 业务契约/真实 SSH/M5 后续。

- passed mac-005m：SFTP 固定 Application Support/cli/simple-sftp-mac-api 与独立查看/复制自检命令；规则与 Experiment 一致，LF/Node 20+/完整参数/cwd、包身份/版本/链接/目录身份保护，受支持 Mac 激活刷新且不降级。未知文件拒绝覆盖，CLI 失败不阻塞业务或更新，保留旧 npm 入口。
- passed mac-005m 本地：SFTP build/25 文件闭包，CLI 启动器 5、独立更新/退出证明 3 逐文件串行通过。真实本地 Git POSIX shell/Node、自检 health mock 与 Mac 命令入口覆盖，未安装扩展/修改 PATH/执行实验或服务器操作。5 文件。

- passed mac-005l：Experiment 固定 Application Support/cli/simpleex-mac，LF/POSIX shell、Node 20+ 门禁、完整参数/cwd、命令面板入口及复制自检。支持 Mac 激活刷新，旧实例不降级；未知文件/链接/硬链接/异仓拒绝，CLI 失败不阻塞业务或独立更新。旧入口保留。
- passed mac-005l 本地：build/215 模块闭包/面板脚本 2，CLI 启动器 5、独立更新 3 逐文件串行通过。真实本地 Git POSIX shell/Node、模拟本机 health API 与 Mac 命令入口覆盖；未安装扩展或执行实验/服务器操作。首次 Windows argv 引号被 shell 启动层改写，改用真实 shell stdin 引用；health fixture 补齐 ok 字段后通过，非超时。5 文件。

- passed mac-release-013：完整本机 prepare/publish；两仓 build/24 与 214 模块闭包、面板脚本 2、更新/POSIX/相对文件名/范围协议门禁逐文件串行通过，浅/深/高对比真实渲染通过，package/lock/runtime 一致。3 附件完整草稿大小/SHA-256 核验后发布，不使用 Actions 或自动安装。
- passed preview-v0.5.276 真实匿名 updater：从 0.5.275/0.2.69 选择两个更新，16 次匿名请求取得清单与两包，大小/hash/CRC/平台/身份核验通过；SFTP 范围/路径/tar/传输源码与 LF askpass、Experiment 面板/更新代码、两仓 README/配置说明匹配已同步来源，README 标准 vsce 链接改写已核对。同版本跳过/禁止降级，无真实 SSH/M5。

- passed mac-doc-008：两仓 README/配置说明补全下载范围按钮、目标核对/浏览/保存/预览、过滤、选中链接拒绝与手动根/显式 API 边界；Mac 范围协议 4 进入发布门禁。UTF8 回读、Experiment build/214 模块闭包/面板脚本 2、配置说明 1、发布 4、SFTP 范围 4 逐文件串行通过，共 6 文件。CLI 和 M5/真实 SSH pending。

- passed mac-005k：下载范围/目录选择保留 POSIX 中文/空格/大小写，空字符串与坏路径拒绝，显式下载禁止根目录别名；保留手动明确选择根入口。范围浏览限制项目内，文件列表用 NUL 文件名/大小对并校验完整性，Python 归档不重写路径并拒绝选中链接。无真实 SSH/删除。
- passed mac-005k 本地：SFTP build/24 文件闭包；新 Mac 范围 4、范围协议 3、范围路径 2、显式下载 1、相对文件名 5、POSIX 5、API 19、跨端/删除 13、工作区 5 逐文件串行通过。初次链接测试 Python 不把 Windows junction 视为 POSIX symlink，新增已核验 fixture 链接适配后协议测试通过，生产判断未放宽。6 文件批次。

- passed mac-release-012：完整本机 prepare/publish；两仓 build/24 与 214 模块闭包、面板脚本 2、更新/POSIX/相对文件名门禁逐文件串行通过，浅/深/高对比真实渲染通过，package/lock/runtime 一致。3 附件完整草稿大小/SHA-256 核验后发布，不使用 Actions 或自动安装。
- passed preview-v0.5.275 真实匿名 updater：从 0.5.274/0.2.68 选择两个更新，15 次匿名请求取得清单与两包，大小/hash/CRC/平台/身份核验通过；包内 SFTP 路径/tar/传输源码和 LF askpass、Experiment 面板/更新代码、两仓 README 与 Mac 配置说明匹配本地来源，README 标准 vsce 链接改写已核对。同版本跳过/禁止降级，无真实 SSH/M5。

- passed mac-doc-007：两仓 README/配置说明补全相对文件名保留、全清单预检和远端大小写/本机别名边界；新真实 tar/Python 测试纳入 release:prepare。两仓文档 UTF8 回读、Experiment build/214 模块闭包/面板脚本 2、配置说明 1、发布 4、SFTP 品牌 2 和相对文件名 5 逐文件串行通过，共 6 文件。下载范围界面与 CLI 后续分批。

- passed mac-release-011：完整本机 prepare/publish；两仓 build/24 与 214 模块闭包、面板脚本 2、更新与两仓 POSIX 发布门禁逐文件串行通过，浅/深/高对比真实渲染通过，package/lock/runtime 一致。3 附件草稿大小/SHA-256 完整核验后公开发布。版本门禁首次写错 runtime 测试目录，改为真实 test/runtimeManifest 后通过，非超时。


### 相邻回归风险

- 基线仍包含 Windows 专属业务路径；首版仅用于更新链路验收，完整科研功能不得标记通过。
- 真机测试依赖用户 M5 设备，尚无证据。用户明确延后验收，授权继续其余适配及逐批发布；不再等待即时真机回传。

## 本批记录
- 第十四版 preview-v0.5.277 已发布：Experiment 0.5.277 来源 `103dd1be66789e7dedc2efe33d43bc0cef8c5bc8`、SFTP 0.2.71 来源 `03520bb94c599a47d4a433254f497cd2d860026e` 均已普通推送并 fetch 核对。固定 CLI、两仓说明、真实包自检与匿名下载通过，实时 API 业务契约/完整科研/真实 SSH/M5 pending。
- mac-doc-009 SFTP README 已普通推送并 fetch 核对；真实提交见 Git。
- mac-005m SFTP 来源 `a6bf99c379c1c355032ce07488fde2205106fd66` 已普通推送并 fetch 核对，固定 CLI 本地验证通过。
- mac-005m SimpleSFTP 稳定 CLI 源码已普通推送并 fetch 核对，真实提交见 Git；4 个 SFTP 文件与本计划共 5 文件。
- mac-005l Experiment 来源 `6e656f2b1b962910147ea7796f4a1758ee05c415` 已普通推送并 fetch 核对，稳定 CLI 本地验证通过。
- mac-005l Experiment 稳定 CLI 已完成本地验证，提交来源见 Git；SFTP 接入与配套发布后续批次。
- 第十三版 preview-v0.5.276 已发布：Experiment 来源 `43ef53f3fe02b6f14f8d392486197a15c0470350`、SFTP 0.2.70 来源 `16e6ce87e98b2c61aef23cc93270734e000bc67b` 均已同步；Mac 下载范围/文件浏览、本地归档协议与真实匿名下载通过。CLI/完整科研主流程/真实 SSH/M5 pending。
- mac-005k SimpleSFTP 源码 `ce60c041385374dabf9723b6aed0659049735832` 已普通推送并 fetch 核对；说明提交 `08595adc69ca73021e561663cce6644b085f3a81`。
- mac-doc-008 SimpleSFTP README 已推送 origin/master；真实提交见 Git。配套下一版 Experiment 0.5.276/SFTP 0.2.70，不自动安装。
- mac-005k SimpleSFTP 已验证源码推送 origin/master，实际提交见 Git；本地协议与模拟 UI/API 通过，含 5 个 SFTP 文件及本计划。
- 第十二版 preview-v0.5.275 已发布：Experiment 来源 `70b9beda5bb21be5aeb601f7024e83c7a9deed07`、SFTP 0.2.69 来源 `a0877d725c9bec338d9711bcdcfba0adddcc2ade` 均已同步；上传/映射相对文件名、本地 tar/Python 与匿名下载通过，下载范围界面/CLI/真实 SSH/M5 pending。
- mac-doc-007 SFTP README 已同步 origin/master；源码提交见 Git。下一批配套版本 Experiment 0.5.275/SFTP 0.2.69，发布不安装扩展。
- mac-005j SimpleSFTP `32ff45c1ea99558467ae629bbe9a71fdfb3e0593` 已普通推送并 fetch 核对；6 个 SFTP 文件加本计划共 7 文件，实际本地 tar/Python 协议与 Mac 模拟入口验证通过。
