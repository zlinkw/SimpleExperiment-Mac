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

## 当前批次：mac-005k（passed，下载范围和浏览）
### 边界

- 下载范围规范、远端文件浏览和 Python 范围归档三项关联适配，最多 8 文件。Mac 保留中文/空格/大小写，空或坏输入不隐式转为项目根；显式下载 API 禁止整个项目，手动配置保留明确选择根目录的旧入口。
- 保护原入口/Plan/API、认证/租约/更新与删除父目录/双确认。不操作真实服务器；本地生成归档协议和模拟 UI/API，M5 pending。CLI 另批，完成后同步说明/发布门禁并发布。

### 验证清单

- passed mac-005k：下载范围/目录选择保留 POSIX 中文/空格/大小写，空字符串与坏路径拒绝，显式下载禁止根目录别名；保留手动明确选择根入口。范围浏览限制项目内，文件列表用 NUL 文件名/大小对并校验完整性，Python 归档不重写路径并拒绝选中链接。无真实 SSH/删除。
- passed mac-005k 本地：SFTP build/24 文件闭包；新 Mac 范围 4、范围协议 3、范围路径 2、显式下载 1、相对文件名 5、POSIX 5、API 19、跨端/删除 13、工作区 5 逐文件串行通过。初次链接测试 Python 不把 Windows junction 视为 POSIX symlink，新增已核验 fixture 链接适配后协议测试通过，生产判断未放宽。6 文件批次。
- pending mac-doc-008：下载范围按钮与边界说明、发布门禁及配套新版本；CLI 后续独立批，M5/科研三拓扑 pending。

- passed mac-release-012：完整本机 prepare/publish；两仓 build/24 与 214 模块闭包、面板脚本 2、更新/POSIX/相对文件名门禁逐文件串行通过，浅/深/高对比真实渲染通过，package/lock/runtime 一致。3 附件完整草稿大小/SHA-256 核验后发布，不使用 Actions 或自动安装。
- passed preview-v0.5.275 真实匿名 updater：从 0.5.274/0.2.68 选择两个更新，15 次匿名请求取得清单与两包，大小/hash/CRC/平台/身份核验通过；包内 SFTP 路径/tar/传输源码和 LF askpass、Experiment 面板/更新代码、两仓 README 与 Mac 配置说明匹配本地来源，README 标准 vsce 链接改写已核对。同版本跳过/禁止降级，无真实 SSH/M5。
- pending mac-005k：下载范围配置/范围浏览的相对路径与中文/首尾空格规范，不将空输入转换成整个项目，不越界；最多 8 文件，CLI 后续单独批次。

- passed mac-doc-007：两仓 README/配置说明补全相对文件名保留、全清单预检和远端大小写/本机别名边界；新真实 tar/Python 测试纳入 release:prepare。两仓文档 UTF8 回读、Experiment build/214 模块闭包/面板脚本 2、配置说明 1、发布 4、SFTP 品牌 2 和相对文件名 5 逐文件串行通过，共 6 文件。下载范围界面与 CLI 后续分批。

- passed mac-release-011：完整本机 prepare/publish；两仓 build/24 与 214 模块闭包、面板脚本 2、更新与两仓 POSIX 发布门禁逐文件串行通过，浅/深/高对比真实渲染通过，package/lock/runtime 一致。3 附件草稿大小/SHA-256 完整核验后公开发布。版本门禁首次写错 runtime 测试目录，改为真实 test/runtimeManifest 后通过，非超时。


### 相邻回归风险

- 基线仍包含 Windows 专属业务路径；首版仅用于更新链路验收，完整科研功能不得标记通过。
- 真机测试依赖用户 M5 设备，尚无证据。用户明确延后验收，授权继续其余适配及逐批发布；不再等待即时真机回传。

## 本批记录
- mac-005k SimpleSFTP 已验证源码推送 origin/master，实际提交见 Git；本地协议与模拟 UI/API 通过，含 5 个 SFTP 文件及本计划。
- 第十二版 preview-v0.5.275 已发布：Experiment 来源 `70b9beda5bb21be5aeb601f7024e83c7a9deed07`、SFTP 0.2.69 来源 `a0877d725c9bec338d9711bcdcfba0adddcc2ade` 均已同步；上传/映射相对文件名、本地 tar/Python 与匿名下载通过，下载范围界面/CLI/真实 SSH/M5 pending。
- mac-doc-007 SFTP README 已同步 origin/master；源码提交见 Git。下一批配套版本 Experiment 0.5.275/SFTP 0.2.69，发布不安装扩展。
- mac-005j SimpleSFTP `32ff45c1ea99558467ae629bbe9a71fdfb3e0593` 已普通推送并 fetch 核对；6 个 SFTP 文件加本计划共 7 文件，实际本地 tar/Python 协议与 Mac 模拟入口验证通过。
