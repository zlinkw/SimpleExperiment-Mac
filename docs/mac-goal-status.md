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
| 07 | 两包与清单同一 Release，绑定两提交及首次安装顺序 | 已验证 | .304 三附件、release.json、真实快照与匿名下载核验；README 首装顺序 |
| 08 | preview、启动一次、30 分钟、手动、每版提醒一次 | 已验证 | Bootstrap 定时与通知记录；macBootstrap、macUpdatePanel 回归 |
| 09 | 全部下载验证后按 SFTP→Experiment 安装重载，同版跳过/不降级 | 剩余 | UpdateTransaction、macUpdateTransaction 及匿名包验证通过；实际 M5 安装/重载未知 |
| 10 | 部分安装补装、阻止新操作、等待本机传输、保留远端实验 | 剩余 | UpdateTransaction/UpdateGate 的本地模拟回归通过；真实传输与失败补装仍待真机 |
| 11 | 直接 GitHub Releases，首版不接 shop/Actions | 已验证 | PreviewRelease 固定公开 Releases 源，release 脚本无 Actions/install；macRelease 门禁 |
| 12 | release.json 协议/通道/时间及所有组件字段 | 已验证 | prepare 生成、parseManifest 校验、实际公开清单与下载核验 |
| 13 | darwin-arm64、真实身份/版本/平台、损坏与兼容性拒绝 | 已验证 | Vsix、macVsix 与实际两包的 CRC/大小/SHA/版本/平台核验 |
| 14 | 选择有效 preview，不用 latest | 已验证 | 用户2026-10-10授权由静态 preview.json 索引替代用户端预发布REST查询；保留 preview 筛选与语义排序，当前迁移本地验证中 |
| 15 | 匿名公开下载、请求合并/缓存/403429退避、失败正确显示 | 剩余 | 用户授权改用静态preview索引；本地客户端15/按钮4回归通过，用户检查不调用REST API，索引清单大小/SHA核验。发布及真实匿名静态请求待完成；.306公开清单/两包下载通过，M5首个403修复效果仍待复验 |
| 16 | 本机 prepare/publish、完整草稿核验后发布、不安装/Actions | 已验证 | mac-release-prepare/publish/common、macRelease；历史本机发布记录 |
| 17 | 版本不可覆盖、更高版本修复、保留历史附件不清理 | 已验证 | assertNewerPreview/发布附件集合核验，历史 preview 保留，macRelease |
| 18 | 验证批次分别提交普通推送 master，包绑定同步提交 | 已验证 | 历史批次计划、两仓 Git 提交/fetch 记录、清单 sourceCommit 与源码快照 |
| 19 | Mac 数据目录/POSIX/大小写/中文空格/锁/退出/CLI/执行依赖 | 剩余 | MacPaths/PosixPath、共享租约、CLI、Darwin 退出证明已有局部回归；完整业务依赖和真实进程/路径行为仍待核验 |
| 20 | Termius 手动登录隧道、保存检测端点与 Agent/tmux 指引 | 剩余 | ManualTunnel/macManualTunnel/macProjectPrepare 与 Mac 使用说明；真实 Termius 尚待验收 |
| 21 | SFTP 密钥/agent/密码/口令，会话记忆与可选 SecretStorage | 剩余 | mac-auth、macAuthentication、本机认证替身；真实密钥/密码服务器和用户系统 agent 未验收 |
| 22 | SSH/tar 流、本机跨服务器中转、两端独立认证 | 剩余 | macRelay、tar-writer/relay 实际消费者回归；真实双服务器认证/断连尚未验收 |
| 23 | 一致 Mac 路径/租约、独立 AppSupport 发现、兼容 API/Plan | 剩余 | macHostLeasePaths/macLeasePaths/API/Plan 回归通过；完整真实插件协作仍待验证 |
| 24 | 删除规范化/直接父目录/两确认，保留 Agent 职责边界 | 剩余 | 现有防护和只读回归保留；真实完整业务边界与 macOS 文件行为未整体验收，无真实删除验证 |
| 25 | M5 首装→下一版 GitHub 更新、版本/设置/重载功能 | 剩余 | 用户延后；匿名下载及模拟事务不能替代安装证据 |
| 26 | 不可达/限流/筛选/错平台/哈希/重复点击/部分失败补装 | 已验证 | macPreviewRelease/macVsix/macUpdateTransaction/macBootstrap/macUpdateGate 单文件串行回归 |
| 27 | 本地 build/依赖闭包/面板脚本与串行超时门禁 | 已验证 | .306 prepare 79目标文件/80含面板标记、两仓build/闭包/面板/vm通过；实际两包客户端/按钮/退出消费者及源码快照通过 |
| 28 | 真机 Termius/认证/中文路径/断连及三拓扑主流程 | 剩余 | 缺全部 M5 真机证据，暂不要求用户立即提供 |
| 29 | 发布说明区分本地/M5，明确阶段局限并持续同通道交付 | 已验证 | 各版 release-notes、README、计划均标记 M5 pending，并持续 preview 发布 |

用户追加要求单列，不改变原方案分母：Mac README 与配置说明、更新按钮入口已经集中整理并通过 macSetupGuide；主题已通过 macPanelTheme 的浅色/深色/高对比本地检查，M5 实际显示仍未验收。后续文档按功能里程碑集中更新。每批报告剩余目标的要求从本文件生效。

最新执行顺序：先完成后完善。有效 preview 查询和 Darwin 退出证明已有本地实现；优先交付已报告的 403 故障修复。缺少真机证据的部分延后等待验证结果，之后只根据具体反馈修正，不继续追加推测性完善。
