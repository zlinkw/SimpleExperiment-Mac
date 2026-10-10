# 目标模式当前计划：mac 适配，更新发布优先
字符上限 12000，达到 10800 自动压缩。保留目标、验证、风险、下一批边界和真实提交记录；完整历史见 Git。

## 固定边界
- 2026-10-10 用户授权改用公开 preview.json 静态索引发现版本，替代用户端 Release REST 列表查询；发布确认完整公开预发布后更新索引，资产和历史版本保持不可覆盖。旧更新按钮/命令保留，用户无需登录。
- 当前目标：独立 darwin-arm64 preview 扩展、配套更新、本机 Releases 发布及完整 mac 科研业务适配。
- 公开 SimpleExperiment-Mac、SimpleSFTP-Mac，普通提交推送 origin/master；Windows 项目独立。
- 支持 Apple Silicon/macOS 26+；M5/24 GB/macOS 27.0 真机 pending，用户延后并授权持续适配/发布。
- 排除 PPT 绘图、Dev Containers、Intel Mac、Actions、zlinkw.shop、历史附件自动清理、开发机自动安装。
- 保护三拓扑、业务 API、Plan 格式、远端实验、删除直接父目录校验/两次确认及原入口。
- 每批至多 3 个相关问题、8 个源/文档/测试文件；测试单文件串行/20 秒，Python AST 隔离/10 秒；build/包闭包/面板语法门禁。
- 最新用户优先级：先完成后完善，缺少真机验证部分延后等待结果；只处理已报告/已证实缺陷，不继续追加推测性完善。
- 用户新增批次汇报要求：每个已完成批次报告剩余原始目标X/29；以docs/mac-goal-status.md为计数依据，未证实的验收条目也计入剩余，不用源码批次数替代目标数。
- 文档节奏按用户最新要求：集中推进功能，累计到阶段完成后统一更新 README/配置说明；实际入口或操作方式改变时，仅同步必要说明。文档仍按 Mac 用法、优先于配色；不再把每轮文档同步作为独立交付重点。汇报以实际功能变化、修复及验证结果为主。更新入口：底部右侧 Mac preview、命令面板检查 preview 配套更新、设置→插件配套更新→检查更新。

## 当前批次 mac-005ap-static-index（passed，本地实现）
- 起始 Exp8715b399f4c82893f67016301380ebb12c515975/SF2f464eb75e362150de5cbe61e1946504c3497a0a 干净且 origin/master 相等；重读事实、计划、源码/发布脚本及相关测试。
- 本批范围5文件：PreviewRelease、客户端与按钮测试、状态清单及本计划。静态索引 preview 筛选/语义排序、清单大小/SHA 验证、无 API 请求；保护安装事务/平台/传输/科研/现有入口。
- 检查：目标单文件串行20秒、build、包闭包、面板vm、UTF8/diff；发布索引及本机发布恢复属于下一批，不修改真机业务功能。
- passed typecheck；macPreviewRelease15/macBootstrap4/macUpdateTransaction6逐文件串行20秒；npm run build（面板2）、verify:package-runtime225闭包、面板vm.Script、UTF8/diff。无服务器操作/安装/Actions。
- 下一批发布完整公开资产后提交静态索引并普通推送，同步发布恢复和必要操作说明。代码提交由本批普通提交/fetch记录，下一批记录真实SHA；M5 deferred，剩余15/29。

## 前批 mac-release-043（published；匿名列表核验受真实配额阻挡，0.5.306/0.2.97）
- 起始Exp71e72dec321d6e366649db1fd4c7288a898297dd/SF2f464eb75e362150de5cbe61e1946504c3497a0a同步，事实/计划/版本/客户端及发布门禁已重读。范围4文件：Exp package/lock/runtime/计划；SF保留.97来源，包作为配套。
- 两仓build/闭包/vm、79单文件串行/20秒、实际两包Preview13/按钮4/SF退出7与快照/匿名更新验证；不重做未经报告的科研完善、不安装/Actions/SSH/删除。剩余15/29，真机403实际成因及修复效果待验。

- metadata passed 两仓build/runtimeManifest1/26与225闭包/面板2/vm.Script/UTF8/diff，mac-release-043-metadata.log；SF2f464eb75e362150de5cbe61e1946504c3497a0a保留.97，代码71e72dec321d6e366649db1fd4c7288a898297dd已同步。完整prepare/实际两包/匿名待执行；剩余15/29。

- prepare passed79目标文件/80含面板标记，build/225与26闭包/面板2/vm/主题，日志prepare-0.5.306.log；源码Exp49a7402a740ca7125408596d1a4e9cedb726af0d/SF2f464eb75e362150de5cbe61e1946504c3497a0a同步干净。两真实VSIX消费者preview13/按钮3/SF退出7与全部源码快照通过。包fixture首轮按钮3/4通过，源码静态检查缺src/Bootstrap.ts而失败；改为仅运行3个真正包消费者，原静态门禁在prepare源码套件4/4通过，未修改生产断言/超时，失败/修正runner均保留。
- 已公开 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.306，releaseId408667246，manifestHash9e6e3259d33c990fb7b912f414fc48bc7a28fc76836b0b023ee04ea8bf06da73，发布时间2026-10-10T05:07:15Z；三草稿附件大小/SHA集合验证后发布，没有安装/Actions。
- 匿名完整列表检查未通过：2026-10-10T05:07:38Z实际API403，x-ratelimit-remaining=0、reset=1791611250（2026-10-10T05:47:30Z），retryAfter=null；新代码正确真实退避，trace保留。禁止在重置前重复匿名API请求，不将这次失败写成检查已通过，也不能据此断言M5同因。
- 独立公开下载passed3请求：清单及两包HTTP200，大小/平台/身份/CRC/SHA与受检包、快照一致，anonymous-direct-download-verification.json；不需要用户GitHub登录。Exp大小2594004/SHA d323961c2a64ba6d83cdd8cbd59f463c156e63902048f8c15def683b1dd395d9；SF大小150756/SHA16514d4011152aad727f987fed1f8cb0d6614702c3d268bf2ed5899b2244722c。
- 交付记录本地计数/UTF8/diff验证后普通推送，当前remaining15/29。恢复时间后仅补匿名列表选择/同版跳过/禁止降级；M5已报告403待复验，其他缺真机的完善延后，不新增推测性功能。

## 前批 mac-005ao-preview-403（passed，本地修复待真机复验）
- M5首个反馈：第一次检查403，重复检查提示GitHub限流一小时；原始错误找不到，实际HTTP原因未知。先处理更新缺陷。.305已prepare/十九实际包pass但未发布，保留全部产物不覆盖；本批后改用更高.306。
- 范围6文件以内：PreviewRelease/真实客户端和启动消费者回归、prepare说明、目标清单及计划。重读事实/计划、Git状态、实际客户端/Bootstrap及GitHub官方退避规则。确定性同流程复现403与非零remaining/reset一小时，区分真实限流与普通拒绝；仅有证据的限流使用reset，保留真实403429保护和失败语义。
- 不修改认证/镜像/登录要求、业务API/远端实验，不自动安装/删除/Actions。等待真机结果的完善延期。新增实际403反馈尚未解决，原目标15暂恢复待验状态；本地修复也不能宣称M5网络通过。

- 原客户端两个实际check回归先失败，精确第二次错误为GitHub限流1970-01-01T01:00:00.000Z后重试（固定时钟）；仅注入HTTP403/remaining59/reset3600。修复后preview13/实际按钮4/事务6/VSIX/租约1/发布门禁4、本机build/225闭包/面板2/vm/UTF8/diff通过，mac-005ao-final.log，无超时。
- 普通403无假退避；真实primary remaining0遵守reset，次级/429按Retry-After或一分钟指数退避。拒绝响应读取至多16KiB、取消超限，不展示正文，仅公开请求入口。没有证明真机首个403的实际成因，条目15待复验，剩余15/29。
- 下一边界.306/.97：只交付确定修复和既有SF退出核验，使用现有79目标prepare门禁；实际包验证优先当前更新/按钮/恢复消费者与两源码快照。旧19包在.305已验证保留，不为未经报告的科研完善继续扩批。M5相关后续完善延期。

## 已验证历史与未发布产物
- .305/.97来源fa89c6568d731063f1a5b7be041cfb5d93e1b29a/2f464eb75e362150de5cbe61e1946504c3497a0a：79串行目标/80标记、两仓build/26与225闭包/面板/vm、十九实际VSIX与源快照通过。用户报告403后未发布，产物原样保留，不能覆盖版本。
- 更新查询/SF退出批次62a6874d855406074409721f8fdd438360a0e598/202ea28b4c13222a8c0ef8ef604b9f1f71d0dd83已推送；preview9、退出/实际恢复7、事务6/启动3/租约1/门禁4、SF结算3/中转9、build/闭包/面板/vm通过。实际Mac ps仍待验。
- 已公开最新.304/.96来源21900a074984d1173ab42ff917447efa1ce97413/ca2ddc26a5fe634c0498f01feebfb046503dbe2c，交付30380d7b492ff5ed406334eb69bd4b1992a9935d。78目标/十九实际包，匿名首轮超时后保留失败并原样重试43请求通过；源码/附件/解析与回执证据见Git及release-artifacts。
- .264首版以来两仓独立namespace/更新通道、Mac路径/CLI、Termius手动端点、独立认证与本机中转、主题、Plan/结果路径适配分批实现，源码及交付均普通推送/fetch相等。完整历史、失败与局限保留在Git和产物，无自动安装/Actions/未经授权清理。

## 下一边界
- 先完成后完善：交付已复现更新故障，不把潜在科研增强/原子性等追加为首版阻塞。缺少真机证据的完善延期，收到用户明确验证结果后再处理具体问题。
- M5待验：更新/两插件启动/设置与重载/部分失败补装、Termius、独立认证/中文路径/断连、三拓扑完整科研主流程；不得用本机VM/AST/headless替代。目标清单docs/mac-goal-status.md固定29条，当前15项待验/整体核验。真正匿名API额度耗尽时保留错误和等待时间；若插件内检查不可用，用户可从公开Release手动按SF→Exp安装，再重载并复验。
