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

## 当前批次 mac-release-045（published，0.5.308/0.2.97）
- 起始Expf7e477114a526b4f82b3e76d0667e50b4c58e3b4=origin/master、SF2f464eb75e362150de5cbe61e1946504c3497a0a干净；重读事实/计划/Git/元数据/发布门禁。
- 范围4文件：Exp package/lock/runtime/计划；仅递增.308交付已证实的Termius入口修复与门禁补正，SF保留.97。保护业务API/Plan/已有入口/远端实验，M5延期，剩余15/29。
- pending metadata build/runtime/225闭包/vm/UTF8/diff；普通同步后prepare82目标文件、实际VSIX指引/更新消费者、源码快照与公开匿名索引/两包核验。完整附件后发布及索引普通推送，不安装/Actions/删除。
- 已验证修复提交744563d0841c20cd5b90a84409bcadf4b11b439e、门禁补正f7e477114a526b4f82b3e76d0667e50b4c58e3b4，均普通推送/fetch相等；命令门禁原失败保留。下一边界只据具体反馈适配，缺真机部分不追加推测完善。
- metadata passed：package/lock/runtime统一.308，build面板2/runtimeManifest1/225闭包/vm.Script/UTF8/diff通过；即将同步受检源码，完整prepare/真实包与公开网络验证待执行。
- 元数据提交0a06f95818aebca3c5973afe941f46a8f78a28f3已普通同步；runtimeManifest首次命令误写features路径未运行，纠正为test/runtimeManifest.test.js后1/1通过。该验证先后顺序错误以新记录补正，原失败保留；完整打包仍未开始。
- 已交付来源Expab8bda82da5c5fbc3c950c9413ed37e279628d57/SF2f464eb75e362150de5cbe61e1946504c3497a0a：prepare82目标/83含面板标记、两仓build/闭包/主题/vm通过，真实VSIX更新15/按钮3/三拓扑指引1/SF退出7通过，1542/83源码快照逐文件匹配。运行记录在本版release-artifacts，M5未替代。
- https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.308 已公开，releaseId408701623，2026-10-10T05:52:35Z；清单SHA3672bde27e8af87fe2cbdb1b588ea6813d4710f56e2a3420501bb724131e439a。三附件完整核验后索引提交41e1aa347fa79d95cac7d5e280d7be9549864460普通推送/fetch相等，indexStatus=published。
- 实际包客户端4次匿名公开请求全部200、REST请求0；索引/清单/两VSIX字节及身份/版本/平台/CRC/大小/SHA通过，缓存/同版/更高版与SF.97跳过通过。报告anonymous-static-verification-retry.json（本版首次运行），无安装/Actions/服务器或删除操作；剩余15/29，等待具体真机反馈后再完善。

## 前批 mac-005as-command-palette-migration（passed，纠正门禁）
- 起始Exp744563d0841c20cd5b90a84409bcadf4b11b439e=origin/master、SF2f464eb75e362150de5cbe61e1946504c3497a0a干净；重读事实/计划/Git/消费者与发布门禁。
- 上批额外commandPaletteClarity检查失败2/2：旧测试引用Windows命令/设置命名空间与已替换的README；提交时未拦截失败，不能记录该门禁通过。本批以新提交纠正，不改写历史。
- 范围3文件：命令面板测试迁移至现有Mac身份、保留高级handler/默认主入口并核对Termius标题；prepare纳入此门禁；本计划修正证据。pending目标单文件串行、build/闭包/vm/UTF8/diff。
- 下一批仅.308元数据/打包发布及实际包指引验证。M5延期，剩余15/29。
- 修正后commandPaletteClarity2/macManualTunnel10单文件串行20秒、build面板2/225闭包/vm.Script/UTF8/diff通过；prepare将此门禁纳入，失败即停止发布。上批失败原记录保留，源码行为未为旧测试回退。

## 前批 mac-005ar-manual-guide-entry（代码已同步，额外门禁失败）
- 用户继续按计划推进；保留先完成后完善及延后真机的约束。本轮重读事实/计划/两仓Git与入口源码，Exp e1450e49176ffca1454b1ae325e358d7b704bcc5、SF2f464eb75e362150de5cbe61e1946504c3497a0a同步干净。
- 已证实未适配入口：高级命令generateXshellTunnelScript仍直接执行Windows Xshell校验并提供bat/ps1保存框；其他手动隧道入口已转Termius。本批修复此遗留入口，保留命令ID，在Mac显示现有动态端点/Agent/tmux指引，不自动启动隧道或读取Termius私有状态。
- 范围至多7文件：legacy、Mac隧道实际消费者测试、package/CommandFactory命令标题、发布说明模板、本计划/状态清单。保护三拓扑、业务API/Plan/更新、Windows原项目及已有命令。pending真实编译入口复现/回归、build/闭包/vm/UTF8/diff。
- 下一批仅补丁版本与发布，真机相关行为deferred；剩余15/29。不重复修改README/配置说明。
- 回归先在实际编译入口失败：Windows session launch items must not be queried；补齐Mac早返回后macManualTunnel10/macProjectPrepare16、build面板2/225闭包/vm/UTF8/diff通过。额外commandPaletteClarity失败2/2被漏拦；已普通同步744563d0841c20cd5b90a84409bcadf4b11b439e，命令门禁由mac-005as补正。单文件串行20秒，无超时/远端操作。

## 前批 mac-release-044（published，0.5.307/0.2.97）
- 起始Expf633c5bb6dfb0771238e89498096b898dba02159=origin/master，SF2f464eb75e362150de5cbe61e1946504c3497a0a 干净且来源不变；重读事实/计划/版本/发布门禁。本批4文件：Exp package/lock/runtime/计划，索引作为独立发布元数据提交。
- 静态客户端及发布恢复已本地通过；本批仅交付，不扩科研适配。pending metadata build/runtime/闭包/vm；同步后prepare81目标文件、实际包客户端/按钮/源码快照、publish三附件及索引普通提交/推送、真实匿名静态检查和下载。保护M5待验/Windows/已有入口/远端实验，无安装/Actions/删除。
- 静态索引替代旧匿名列表等待，不再以API reset作为本次用户更新验证入口；M5 deferred，剩余15/29。
- metadata passed：package/lock/runtime统一.307；build面板2、runtimeManifest1、225闭包、vm/UTF8/diff通过。即将普通同步该受检源码，再进行既有prepare门禁和公开发布；发布产物保持不可覆盖。
- 源码Exp0b9b344c00894fb18bfe9c245296a81611ba5d55/SF2f464eb75e362150de5cbe61e1946504c3497a0a；prepare81目标文件/82含面板标记通过，两仓build/闭包/主题/vm。实际包客户端15/按钮3/SF退出7通过；快照逐文件1541/83匹配。证据见本版release-artifacts。
- 已公开 https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.307，releaseId408686018、发布时间2026-10-10T05:33:43Z、清单SHA736863f138a15d1fd0a0d6faa8733e895ee6e30ec1f43f7b11911cd1d09a85a0。三附件完整大小/SHA确认后，preview.json单文件提交2d90061942351b2780671f67e6784116745885d6并普通推送/fetch HEAD=origin/master。
- 首次索引提交后Git TLS EOF失败，原日志/回执保留；同一回执补推同一索引提交成功，无重复发布/提交、无覆盖/重写历史。索引SHA8bd6ddaba7200b54aa3cb10adb9b561e20e6ab2972aa20bace154e8cfc61ac65，indexStatus=published。
- 首次匿名验证索引200后清单fetch网络失败，trace保留；同一实际包客户端重试通过4匿名请求：索引、清单、两包均200，REST请求0。清单/包字节匹配、身份/平台/CRC/大小/SHA，缓存/同版/更高版本跳过和SFTP.97不重复安装通过；未安装，M5pending。报告anonymous-static-verification-retry.json。
- Exp2594936字节/SHA c836120706a9efe2fb2a55d5c50cc75ee3d83e38796da87f72a230c45669cc7e；SF150756字节/SHA2daa900dc9773566a456e71c0bd7fd57a61f6da41991b3f84eee4d1e4205dc12。无安装/Actions/真实科研、SSH或删除。
- 剩余15/29，静态索引完成本地与公开网络验证；只等待M5反馈，不追加未经报告的完善。交付计划/清单只同步必要证据，不重复改README/配置说明。

## 前批 mac-005aq-index-publisher（passed，本地实现）
- 起始Exp119fdb82f700553e0d1b4662e5c17cb7edc1d76b=origin/master，SF2f464eb75e362150de5cbe61e1946504c3497a0a 未改；事实/计划/Git/发布源码与测试已重读。
- 范围7文件以内：静态索引发布模块、publish/prepare、发布模块回归、发布操作说明、目标状态及计划。完整公开附件后单独提交并普通推送preview.json；仅凭回执恢复索引写入/提交/推送，不覆盖资产或历史记录，远端推进/无关改动停止。
- passed macPreviewIndex6/macRelease4逐文件串行20秒、npm run build面板2/225闭包/vm.Script/UTF8/diff；覆盖失败补推、提交后回执故障恢复、历史不可覆盖及无关变更阻断。普通提交f633c5bb6dfb0771238e89498096b898dba02159，push/fetch HEAD=origin/master。
- 下批仅递增Experiment补丁/打包及真实公开静态请求验证，SFTP.97保持来源。M5 deferred，剩余15/29。

## 前批 mac-005ap-static-index（passed，本地实现）
- 起始 Exp8715b399f4c82893f67016301380ebb12c515975/SF2f464eb75e362150de5cbe61e1946504c3497a0a 干净且 origin/master 相等；重读事实、计划、源码/发布脚本及相关测试。
- 本批范围5文件：PreviewRelease、客户端与按钮测试、状态清单及本计划。静态索引 preview 筛选/语义排序、清单大小/SHA 验证、无 API 请求；保护安装事务/平台/传输/科研/现有入口。
- 检查：目标单文件串行20秒、build、包闭包、面板vm、UTF8/diff；发布索引及本机发布恢复属于下一批，不修改真机业务功能。
- passed typecheck；macPreviewRelease15/macBootstrap4/macUpdateTransaction6逐文件串行20秒；npm run build（面板2）、verify:package-runtime225闭包、面板vm.Script、UTF8/diff。无服务器操作/安装/Actions。
- 普通提交119fdb82f700553e0d1b4662e5c17cb7edc1d76b，推送/fetch HEAD=origin/master；M5 deferred，剩余15/29。

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
- 先完成后完善：用户授权继续计划，核查已有mac业务入口并修复可由源码/实际消费者证实的未适配问题；缺少真机证据的完善延期，不追加潜在科研增强。静态索引.307已交付，用户端无REST请求。
- M5待验：更新/两插件启动/设置与重载/部分失败补装、Termius、独立认证/中文路径/断连、三拓扑完整科研主流程；不得用本机VM/AST/headless替代。目标清单固定29条，当前15项待验/整体核验。旧版API受限时可从.307公开Release按SF→Exp手动安装一次并重载；新版本沿静态preview通道更新，按钮不变。
