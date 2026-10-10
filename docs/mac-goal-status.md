# Mac 原方案目标状态

计数口径固定为用户原方案的 29 个条目，编号不随代码批次改变。条目中有必需证据未取得，整条计入剩余；局部实现、模拟测试和打包通过不能替代真机验收。首个 M5 更新 403 反馈使条目 15 恢复待验，已验证 14 条，剩余 **15/29** 条。后续每个完成批次报告此数，取得新证据后减少，已报告缺陷允许恢复待验。下面的本地证据表示实现或工具链证据，不表示科研实验成功。

| 编号 | 原始目标 | 状态 | 证据与尚缺内容 |
| --- | --- | --- | --- |
| 01 | 两个公开独立仓库，从已提交源码复制 | 已验证 | `mac-project-facts.md` 记录基线提交；两个 origin/master，独立提交和发布源码快照 |
| 02 | Apple Silicon、macOS 26+，M5/24 GB/27.0 验收 | 剩余 | Bootstrap 平台/版本守卫已实现；收到首个403反馈，尚无完整通过验收记录 |
| 03 | 全部本机构建及用户真机验证，不使用 Actions | 剩余 | 本机 prepare/publish 已验证，仍缺用户真机部分 |
| 04 | 保留三拓扑与完整科研主流程，排除指定范围 | 剩余 | topologyMode、distributedPlan/Project 目标回归；三拓扑完整真机主流程未验收 |
| 05 | 独立扩展身份、依赖、命令/设置/发现与更新源 | 已验证 | 两仓 package、MacPaths/mac-paths、Bootstrap、PreviewRelease；macBootstrap、publicBranding 回归及实际 VSIX |
| 06 | Mac 最小启动，更新不依赖服务器/Termius/面板 | 剩余 | macBootstrap 验证独立激活顺序、错误状态和入口；M5 启动尚待验证 |
| 07 | 两包与清单同一 Release，绑定两提交及首次安装顺序 | 已验证 | .309三附件、release.json、1545/83真实快照与匿名下载核验；README首装顺序 |
| 08 | preview、启动一次、30 分钟、手动、每版提醒一次 | 已验证 | Bootstrap 定时与通知记录；macBootstrap、macUpdatePanel 回归 |
| 09 | 全部下载验证后按 SFTP→Experiment 安装重载，同版跳过/不降级 | 剩余 | UpdateTransaction、macUpdateTransaction 及匿名包验证通过；实际 M5 安装/重载未知 |
| 10 | 部分安装补装、阻止新操作、等待本机传输、保留远端实验 | 剩余 | UpdateTransaction/UpdateGate 的本地模拟回归通过；真实传输与失败补装仍待真机 |
| 11 | 直接 GitHub Releases，首版不接 shop/Actions | 已验证 | PreviewRelease 固定公开 Releases 源，release 脚本无 Actions/install；macRelease 门禁 |
| 12 | release.json 协议/通道/时间及所有组件字段 | 已验证 | prepare 生成、parseManifest 校验、实际公开清单与下载核验 |
| 13 | darwin-arm64、真实身份/版本/平台、损坏与兼容性拒绝 | 已验证 | Vsix、macVsix 与实际两包的 CRC/大小/SHA/版本/平台核验 |
| 14 | 选择有效 preview，不用 latest | 已验证 | 用户2026-10-10授权静态preview.json替代用户端预发布REST查询；.307客户端15回归及实际包公开匿名索引选择通过，保留preview筛选与语义排序 |
| 15 | 匿名公开下载、请求合并/缓存/403429退避、失败正确显示 | 剩余 | .307静态索引已发布，客户端15/按钮4回归及实际包公开匿名4请求通过，REST请求0；清单/两包大小/SHA/身份/平台与缓存跳过核验。首轮清单网络失败保留，原样重试通过；M5首次403实际原因未知，待用户使用反馈 |
| 16 | 本机 prepare/publish、完整草稿核验后发布、不安装/Actions | 已验证 | .309完整公开附件后索引普通提交推送/fetch通过；.307实际Git TLS故障凭同一回执补推同一索引提交成功，无重复发布/覆盖/安装；发布模块6回归与门禁4通过 |
| 17 | 版本不可覆盖、更高版本修复、保留历史附件不清理 | 已验证 | assertNewerPreview/发布附件集合核验，历史 preview 保留，macRelease |
| 18 | 验证批次分别提交普通推送 master，包绑定同步提交 | 已验证 | 历史批次计划、两仓 Git 提交/fetch 记录、清单 sourceCommit 与源码快照 |
| 19 | Mac 数据目录/POSIX/大小写/中文空格/锁/退出/CLI/执行依赖 | 剩余 | MacPaths/PosixPath、共享租约、CLI、Darwin退出证明；活跃平台入口本地核查完成，本机缓存回收已替换固定pwsh.exe，实际包消费者6通过（虚拟文件系统/进程叶子）；真实Mac业务依赖/进程/路径仍待核验 |
| 20 | Termius 手动登录隧道、保存检测端点与 Agent/tmux 指引 | 剩余 | ManualTunnel/macManualTunnel/macProjectPrepare；补齐遗留高级脚本命令的Mac分支，显示动态三拓扑Agent/tmux指引，不执行Windows校验/保存框；真实Termius尚待验收 |
| 21 | SFTP 密钥/agent/密码/口令，会话记忆与可选 SecretStorage | 剩余 | mac-auth、macAuthentication、本机认证替身；真实密钥/密码服务器和用户系统 agent 未验收 |
| 22 | SSH/tar 流、本机跨服务器中转、两端独立认证 | 剩余 | macRelay、tar-writer/relay 实际消费者回归；真实双服务器认证/断连尚未验收 |
| 23 | 一致 Mac 路径/租约、独立 AppSupport 发现、兼容 API/Plan | 剩余 | macHostLeasePaths3包含两插件实际模块共享虚拟POSIX租约目录、双向冲突、释放后接管、大小写与中文%20路径；macLeasePaths/API/Plan回归通过。完整真实插件协作、系统磁盘/进程行为仍待M5验证 |
| 24 | 删除规范化/直接父目录/两确认，保留 Agent 职责边界 | 剩余 | Mac本机删除助手6防护回归：双确认、规范直接父目录、最短子项、身份/SHA、链接/跨文件系统/变化拒绝及结果核验；缓存面板上下文7通过。仅虚拟文件系统，不执行真实删除，macOS完整边界待验 |
| 25 | M5 首装→下一版 GitHub 更新、版本/设置/重载功能 | 剩余 | 用户延后；匿名下载及模拟事务不能替代安装证据 |
| 26 | 不可达/限流/筛选/错平台/哈希/重复点击/部分失败补装 | 已验证 | macPreviewRelease/macVsix/macUpdateTransaction/macBootstrap/macUpdateGate 单文件串行回归 |
| 27 | 本地 build/依赖闭包/面板脚本与串行超时门禁 | 已验证 | .309 prepare86目标文件/87含面板标记，两仓build/闭包/主题/vm、实际包35场景（客户端15/按钮3/指引1/退出7/缓存6/租约3）及1545/83快照绑定通过；旧命令门禁已迁移Mac、纳入prepare，单文件串行20秒 |
| 28 | 真机 Termius/认证/中文路径/断连及三拓扑主流程 | 剩余 | 缺全部 M5 真机证据，暂不要求用户立即提供 |
| 29 | 发布说明区分本地/M5，明确阶段局限并持续同通道交付 | 已验证 | 各版 release-notes、README、计划均标记 M5 pending，并持续 preview 发布 |

用户追加要求单列，不改变原方案分母：Mac README 与配置说明、更新按钮入口已经集中整理并通过 macSetupGuide；主题已通过 macPanelTheme 的浅色/深色/高对比本地检查，M5 实际显示仍未验收。后续文档按功能里程碑集中更新。每批报告剩余目标的要求从本文件生效。

最新执行顺序：先完成后完善。有效 preview 查询和 Darwin 退出证明已有本地实现；优先交付已报告的 403 故障修复。缺少真机证据的部分延后等待验证结果，之后只根据具体反馈修正，不继续追加推测性完善。

2026-10-10 用户要求先完成本地事项再暂停：已核查活跃平台入口、Windows执行依赖、两插件路径/发现/ABI/租约协作、手动准备及远端职责和删除确认边界；修复缓存回收Windows依赖、Mac配套安装提示及计划压缩丢目标问题。.309/.97已发布，本地86目标文件、实际包35场景、1545/83源码快照和匿名4请求200/REST0通过；未执行真实科研、服务器通信或删除。所列本地工作交付完毕，收尾提交同步后按用户要求暂停目标模式。剩余15条保留等待完整/M5验收，不标记原目标complete；未经用户恢复不继续自动批次。

本次交付：[preview-v0.5.309](https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.309)，Exp源码880b653a8a08024b81446b45b327d2153fe707ff、SF源码2f464eb75e362150de5cbe61e1946504c3497a0a；索引提交76e2b03b4b39d2a526b581e5d57e6c6cfd37a8a3。证据保留于release-artifacts/preview-v0.5.309/publish-receipt.json、source-projection-verification.json、packaged-update-settlement-verification.json、anonymous-static-verification-retry.json及请求trace，M5Validation仍为pending。
