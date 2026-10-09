# SimpleExperiment 全插件稳定性与性能改进计划

> 保存日期：2026-10-03（Asia/Shanghai）。
> 本文为用户确认的完整合并版：全插件源码对照计划 + 长期灰屏专项 + Luna 执行交接。
> 文档最初仅保存计划；2026-10-03 用户授权开始执行。本轮继续推进代码实现。
> 当前执行状态（2026-10-05）：批次 0–8、5A/5B 的计划内实现已完成，SimpleSFTP 压缩收益采样及分块恢复已补齐；当前交付为 SimpleExperiment 0.5.218 / SimpleSFTP 0.2.48。最新源码、短时测试和交付证据以第 7.8 节为准。用户明确将长时间及人工现场验收留后；这不等价于长期灰屏根因已解决或真实链路已提速。第 7.2/7.6/7.7 节保留历史快照，其 running/partial/pending 不再表示本轮仍缺实现。

> 0.5.218 现场同步回归的后续修正见第 7.9 节：嵌套 attempt 哈希查询必须使用精确 scope 的递归扫描；本轮目标版本 0.5.219，配套仍为 0.2.48。

> 0.5.219 的本机队列 EPERM 后续修正见第 7.10 节，目标版本 0.5.220 / 配套 0.2.48。完整远端同步及长期验收仍未重放。

**补充结论：目前不能确认长期灰屏已经解决。审查时 0.5.215 的通信和渲染 ACK 正常，但 ACK 不能证明最终画面已经正确显示。**

## 1. 审查结论与范围

上一轮完成了 `src` 下 271 个源码文件、约 10.76 万行的结构扫描，并深入追踪运行调度、传输、结果发布、Panel、隧道、持久化、清理、通知和更新链路；同时检查了配套 SimpleSFTP 的关键实现，并与 GitHub 项目源码对照。结构扫描不等于逐行语义验证或全部运行测试通过。

**优先问题是取消完成判定、清理归属、持久化一致性和实际请求限流。** 这些边界不收紧，继续增加重试、缓存或恢复逻辑容易引入新的并发问题。

审查时源码基线为 `0.5.215 / cef3e436`。审查没有修改文件、执行远端操作或安装插件；既有未提交修改和两个 dirty `.pyc` 均保留。此前安全重试批次仍有一个测试超时，不能视为已交付。本文中的版本、行数、性能和 Git 状态都是审查快照，执行时必须重新核实。

审查区分三类证据：源码已证实的行为、已复现的功能错误、需要压力测试确认的风险。以下计划不宣称已经完成长期运行验收。

已有机制继续保留：显式渲染 ACK、单份未渲染状态背压、section projection/revision、局部 DOM 更新、队列磁盘签名与稳定显示快照、最新完成 run 权威、跨 Plan 打包、自动退避重连及最新完整产物保留策略。

## 2. 修改清单与源码对照

### P0：取消、重试与停止必须有真实完成证据

**已证实：** SimpleSFTP 的失败路径可以先从 `activeTransfers` 移除控制器，再终止进程、等待 `close`。当前安全重试通过“传输列表中消失”确认停止，因此仍存在旧传输尚未退出、新传输已经开始的窗口。

修改方案：

- 在现有安全重试机制上补齐 `cancelling → settled` 回执，分别记录取消请求、子进程退出、写入流关闭和远端状态。
- 只有 `settled` 才释放同目标互斥并启动替代请求；列表缺失、断线、取消 ACK 都不能单独证明退出。
- UI、CLI、API 共用请求身份和替换规则，避免只有三个界面同步入口受到保护。
- 失败历史保留为记录，不参与资源占用；已确认仍运行的 Plan 继续采用用户批准的“确认停止后重跑”。
- 跨窗口或重载后，通过持久化回执重新核实；无法确定时返回明确的 `outcomeUnknown`，禁止并发重发。

对照 [BullMQ `Worker.close()`](https://github.com/taskforcesh/bullmq/blob/b2aa09331e60ca92cefcf78cca7cf0b706dc7eb4/src/classes/worker.ts#L1271) 的等待完成语义，以及 [p-queue 的 `onEmpty/onIdle`](https://github.com/sindresorhus/p-queue/blob/180ab9e25cd10b6f548767d7176076b50d25e188/source/index.ts#L601)。采用其完成判定原则，不引入 Redis 或替换现有调度器。

### P0：清理必须绑定所有者，停止必须绑定运行身份

**已证实：**

- `cleanupSchedulerTmpForOp()` 通过文件名包含 operation/Plan 字符串寻找删除对象。
- Agent 状态清理以文件年龄和总体积为主要依据，缺少完整的活动任务归属判断。
- 遗留管理接口仍包含按进程名、tmux 前缀批量停止的实现；需要先验证路由可达条件。
- Git backup hook 的删除异常被忽略，仍可能返回“已删除”。

修改方案：

- 文件记录必须携带项目、operation、run、attempt、用途和规范路径；禁止通过字符串包含关系推断归属。
- 活跃任务、未确认停止任务、未发布事务和可恢复传输的文件始终受保护。
- 停止接口只接受可验证的项目、commandId、PID 启动身份或精确 tmux 身份；空参数不得扩大停止范围。
- 停止调度后 Worker task 还必须匹配目标 run 的 `workflowId/runId`；同 Plan 的其他 run 保留，缺少 run 身份的活动 task 作为未核实证据返回。孤儿 scheduler tmux 回收限定为本次已验证的 session，不再按整个 `-sch-` 前缀扫描。
- 清理失败如实报告，不能返回成功。
- 完整文件/目录清理统一经过现有路径安全门禁和确认流程；历史文件先预览，永久删除仍需完整路径两次确认。

### P0：结果发布和关键状态写入形成可恢复事务

**已证实：** 当前结果表逐文件写临时文件、逐文件 rename，存在中途失败后不同表属于不同世代的窗口；部分其他状态仍直接写目标文件。

修改方案：

- 统一关键状态存储边界：读取版本、独立工作副本、校验、提交、冲突处理。
- 结果先写完整 generation，校验 runId、seed 覆盖和 hash 后，原子切换当前 generation。
- 插件读取当前 generation；兼容的固定路径 CSV 在发布锁内更新，并用事务记录支持失败恢复。
- 发布未完成时继续展示上一份可信版本；禁止混读新旧表。
- 保留现有最新 run 权威和旧 raw 可追溯语义，不重新引入 revision-only 或共享 CSV 存在即有效的判断。
- Host 关键队列写入补持久化保障；不退回非原子直接覆盖来绕过 rename 错误。

参考 [write-file-atomic 的同路径串行写入、fsync 和 rename](https://github.com/npm/write-file-atomic/blob/23e111d95367e1d987c1b4d7823791eaaf6b21df/lib/index.js)。多文件事务由项目自己的发布协议完成。

### P1：让请求预算真正限制负载

**已证实：** `RequestBudget` 当前主要处理暂停、隐藏、离线状态；并发参数没有形成实际并发上限，部分 Worker action slot 只计数。

修改方案：

- 分成紧急控制、普通控制和大文件传输三类队列。
- 初始默认：每 Worker 普通请求最多 4 个、全局最多 8 个；每 Worker 大传输 1 个、全局 2 个；停止与恢复核实保留独立控制容量。
- 相同只读请求合并；无订阅者的过期读取取消；不同项目和服务器保持独立推进。
- 同一操作只由一个层级负责重试，复用现有退避与 jitter，避免 Host、隧道和传输层叠加重试。
- 保留 500ms 队列 tick，通过缓存和请求合并降低请求量。
- 将排队时间、在途数、合并数和重试数加入 bounded diagnostics。

参考 [VS Code `ThrottlerByKey/SequencerByKey`](https://github.com/microsoft/vscode/blob/06a1c70075c89ce81acd39767b024e904c6d3066/src/vs/base/common/async.ts#L282) 和 [Google SRE 过载处理原则](https://sre.google/sre-book/handling-overload/)。上述数字是可配置的初始限制，性能收益以实测为准。

### P1：补齐流式通信背压与取消传播

**已证实：** 本地 API SSE 忽略 `response.write()` 返回值；现有事件数量限制不能限制慢消费者的字节积压。RPC 也缺少贯通的请求取消上下文。

修改方案：

- SSE 遇到写入背压暂停发送，等待 `drain`；限制每个订阅者待发送字节数和总连接数。
- 初始上限为每客户端 1MiB 待发送数据、每 API 实例 8 个订阅；溢出发送缺口标识并要求重新读取快照。
- 事件历史同时按条数和字节限制。
- 客户端断开取消只读计算；写操作继续以 operation 回执查询结果，不能因 HTTP 断开就假定失败。
- Agent HTTP/SSE 增加对应的连接、线程和输出队列压力测试，按连接类型分配容量。

依据 [Node.js 流背压机制](https://nodejs.org/learn/modules/backpressuring-in-streams)，避免将慢消费者转化为内存增长。

### P1：进一步削减 Panel Host 计算，而非重复重做前端架构

**已证实：**

- `buildState()` 仍调用日志保护更新，可能引起压缩、合并和状态比较。
- 状态合并会重建对象，而 section revision 部分依赖对象引用变化。
- Plan 摘要重复聚合；结果 catalog 缓存入口仍包含同步文件检查，缓存失效时执行同步读取。

修改方案：

- `buildState()` 改为纯快照投影；日志保护和缓存更新由对应数据事件触发。
- domain revision 在真实数据变更入口递增；未变化的容器保留引用。
- Plan 摘要按完整证据版本缓存，保持 projection 前聚合。
- catalog 在后台异步更新；状态明确标注加载中或旧快照，不能伪装成空结果。
- 使用 IntersectionObserver 缓存可见性，保留现有 offscreen dirty、强制导航和 pinned inspector 规则。
- 不增加通用虚拟 DOM，不放宽 heartbeat/stall 阈值。

参考 [GitLens Webview 的 session、取消及可见性管理](https://github.com/gitkraken/vscode-gitlens/blob/a3ab1179ac86a0d83cb35c63a0af9114a6003f99/src/webviews/webviewController.ts)。这里只借鉴生命周期边界，保留现有 Panel 协议。

### P1：传输采用有界压缩批次和可恢复发布

**已证实：** 跨 Plan 合并传输已经存在；当前 SimpleSFTP 的 `auto` 压缩主要等价 gzip，分组主要依据文件数量，流式解包会逐步改变目的目录。

修改方案：

- 保留按源/目标 Worker 合并多个 Plan 的能力。
- 打包同时限制文件数和字节数；默认每批最多 128MiB 未压缩数据，超大文件走独立分块。
- 压缩选择结合有限样本、CPU 时间和链路吞吐；文本优先压缩，低收益二进制允许原样传输。
- 保留 gzip 兼容；仅在双方能力协商成功时使用 zstd。
- 传输 manifest 记录文件 hash、已验证块和目标 generation；重试只补缺失或不匹配内容。
- 在暂存位置校验后发布，避免半成品被结果扫描器当作当前产物。
- 取消、重载和断线都复用同一传输回执，不新增另一套恢复状态机。

参考 [rclone 的有界分块并发](https://github.com/rclone/rclone/blob/9e27583e8045bfffd9016e231fa8bfcc215ef006/fs/operations/multithread.go) 与 [Syncthing 的 `finalClose/SyncClose`](https://github.com/syncthing/syncthing/blob/05b6704ef5080b8013c690b83b831d0dbedca5a0/lib/model/sharedpullerstate.go#L292)。不安装额外同步守护进程。

### P1：从源头减少临时文件和长期状态积累

**已证实：** 部分写入使用随机临时名；每窗口资源锁文件会持续留下；更新目录使用时间戳；PPT 请求审计文件逐请求生成。不能将这些全部视为可随意删除的垃圾。

修改方案：

- 将数据明确分为临时传输、恢复检查点、运行历史、审计记录和正式产物。
- 临时元数据优先驻内存；需要落盘的使用有所有权的固定槽位，成功 rename 消耗暂存文件。
- 资源锁注册表复用已验证闲置槽位；损坏记录按归属隔离，不能一个旧坏文件阻塞全部项目，也不能忽略未知活动锁。
- 日志和遥测采用有界环形记录；审计保留小摘要，完整导出由用户显式触发。
- 继续使用现有 `latest-complete`：新版本完整校验发布后，旧完整产物才成为清理候选；正在构建的新版本不覆盖唯一可用版本。
- 旧文件清理由安全预览统一处理，不新增周期性全目录删除器。

### P1：通知与操作状态解耦

**已证实：** `withUiCommandStatus()` 在发送最终状态之前等待失败模态框关闭；用户取消/被新请求替代的区分还依赖部分文案；Plan 失败去重集合没有完整的内存上限。

修改方案：

- 操作结束立即发送终态并解除按钮 loading，再独立调度通知。
- 使用结构化错误类别：失败、用户取消、被替代、配置错误、冲突、远端结果未知。
- 用户主动请求失败必须明确通知一次；后台批量失败合并通知。
- 父同步任务汇总子任务失败，避免逐 Plan 连续弹窗。
- 去重键包含项目、请求世代和错误码，并设置容量上限。
- 完成、失败、恢复均不自动跳转或滚动；只有用户点击“查看详情”才导航。

遵循 [VS Code 通知规范](https://code.visualstudio.com/api/ux-guidelines/notifications)，同时保留用户要求的主动失败提示。

### P1：生命周期、附属窗口与更新流程统一收口

**已证实：**

- 部分 activation 定时器没有统一托管。
- 同步 `try/catch` 包住异步调用，不能处理之后的 Promise rejection。
- deactivate 没有等待异步释放。
- TensorBoard proxy 关闭可能等待活动连接；PPT 响应累积没有明确字节上限。

修改方案：

- 项目、Panel document、代理窗口各有独立 cancellation/disposable scope。
- 定时器、监听器、请求和临时代理统一注册；释放后返回的资源立即关闭。
- 停用流程有界等待插件自有资源退出，保留远端正式训练。
- 图表关闭或失去订阅时取消读取；PPT JSON 响应增加大小与总时长边界。
- 初始化失败明确进入诊断状态，禁止空服务替身伪装初始化成功。

### P1：修复已复现的版本比较与更新资产选择错误

上一轮内存执行源码得到：

- `0.5.215-rc.1` 被判断高于 `0.5.215`。
- 未找到匹配插件的 VSIX 时，会退回选择其他名称的 VSIX。

修改方案：

- 使用标准 SemVer 比较，明确稳定版和预发布通道。
- VSIX 必须匹配 extension ID、版本和目标平台；缺失时停止自动安装。
- 下载采用有界流、超时和 hash 校验，验证包内 manifest 后才安装。
- 仅安装确实有更新的组件；同版本跳过。
- 更新文件使用可复用的受控暂存位置，避免每次创建新的永久目录。
- 配套更新部分成功时明确显示版本组合及重载要求。

比较语义参考 [node-semver `comparePre()` 源码](https://github.com/npm/node-semver/blob/main/classes/semver.js#L142)；将小型 SemVer 依赖显式纳入打包，不依赖环境中的隐式安装。

### P2：降低项目接入要求，逐步收拢架构

**已证实：** 通用契约仍默认包含 checkpoint、特定结果文件及四态指标路径；部分 service 类为空壳，核心逻辑仍集中在四个大文件中，约占源码行数的 63%。

修改方案：

- 提供三层能力：通用命令运行、可选指标采集、可选训练/checkpoint 能力。
- 最小接入只声明命令、工作目录、输入和输出；指标支持 CSV/JSON 字段映射。
- MultiModal 现有约定保留为兼容 preset，不要求其他项目采用四态指标或改训练内部代码。
- UI、CLI、API 使用同一 schema 和验证结果；接入检查区分必需项与可选项。
- 单 Worker 即可使用；复用现有服务器配置和动态隧道端点。
- 随上述批次逐步抽出请求协调、状态存储、结果发布和通知模块；旧入口作为薄适配保留。
- 修正文档与空 service 的不一致，不做一次性全仓迁移。

参考 [DVC Stage 的 command/dependencies/outputs](https://github.com/iterative/dvc/blob/56e59829512ff134aa269099a2099587b810b4dd/dvc/stage/__init__.py) 和 [MLflow ArtifactRepository 的存储接口](https://github.com/mlflow/mlflow/blob/0b1e3700e9ecdc88890791c2a9a549e4eea51053/mlflow/store/artifact/artifact_repo.py)。采用接口划分，不增加 DVC/MLflow 运行依赖。

## 3. 必须统一的接口与兼容规则

| 接口 | 确定行为 |
|---|---|
| 请求上下文 | 统一 project、requestId、目标资源、generation、取消信号；旧响应不能结束新请求 |
| 停止回执 | 明确 `cancelling/settled/unknown`；只有 settled 允许替代同目标执行 |
| 传输 manifest | 绑定源/目标、文件 hash、分块进度和发布世代；支持按已验证内容恢复 |
| 状态存储 | 工作副本与显示快照隔离；基于磁盘版本提交；冲突保留可信快照 |
| 结果发布 | 以 authoritative run 为世代，完整验证后切换；固定路径导出受事务保护 |
| 错误模型 | 稳定错误码、可重试性、结果确定性、所属父操作；文案不承担控制逻辑 |
| 能力协商 | 新协议通过 discovery 暴露；旧 Agent/SFTP 缺少退出证明时安全降级，不推断成功 |
| 项目契约 | 版本化最小 schema，加可选能力；现有项目不强制迁移 |

外部项目只提供实现依据。复制代码前核对许可证与署名要求；默认在现有模块内实现必要机制，控制新增依赖。

## 4. 实施顺序

每批处理 2–3 个相关问题，控制修改面；先补可复现用例，再改实现。

| 批次 | 内容 | 完成门槛 |
|---|---|---|
| 0 | 收口现有安全重试未提交批次，定位 `planStopClear` 超时 | 明确未释放等待点；不原样盲重跑，不延长超时掩盖 |
| 1 | SFTP 真实退出回执、统一请求替代 | 旧执行未退出时新请求绝不启动 |
| 2 | 清理所有权、精确停止、状态原子写入 | 不跨项目、不误删活动数据、失败不报成功 |
| 3 | 结果事务发布、最新完整版本及缓存切换 | 故障注入下无混合世代表 |
| 4 | 请求限流、SSE 背压、取消传播 | 并发与内存边界可验证，停止请求不被传输堵住 |
| 5 | Panel 纯投影、缓存与生命周期 | 未变化 section 不重算，关闭后资源回收 |
| 6 | 压缩分批、恢复传输、暂存文件控制 | 重试只补缺失内容，半成品不成为当前结果 |
| 7 | 通知、更新、附属窗口 | 无自动跳转、终态及时、错误资产不能安装 |
| 8 | 通用接入、模块边界、测试与文档 | 普通命令项目低成本接入，兼容现有 MultiModal |
| 9 | 全插件故障测试与长时间运行验收 | 提交真实指标及剩余问题，完成统一交付 |

通过验证的批次按项目规则独立提交、普通推送并核对 `origin/master`。最终交付再统一递增补丁版本、打包和安装一次，重载后进行现场验收。当前未通过验证的批次不得作为成功版本发布。

新增灰屏专项以 **5A、5B** 插入批次 5 后，详见第 6 节；原批次内容不删除。

## 5. 测试与验收

### 测试基础设施

- 修正测试入口可能并行执行、缺少硬超时的问题；逐文件串行，20 秒上限。
- 逐步将源码字符串切片 fixture 改为真实模块接口和可控时钟，优先覆盖此次修改链路。
- 保留 build、Webview `vm.Script`、实际内联脚本解析、runtime closure、UTF-8 和动态端点门禁。
- 建立 Windows 与 Linux 的对应单元测试；Python 只提取被测函数，避免完整运行 Agent/Scheduler。

### 必须通过的行为场景

- 同请求连续重试、取消 ACK 早到但进程晚退出、断线未知结果、重载后恢复、多窗口争用。
- 不同 Plan 可并发；同 Plan 真正 active 严格阻止；旧失败记录不阻塞新请求。
- run A/B 同 revision：只发布 B；BUS/PAD seed 完整；中途断电、磁盘满、rename 失败均不混读。
- 活跃文件超过 TTL 仍受保护；路径越界、符号链接、父目录核验失败都不能清理。
- 5Hz 状态更新仍最多一份未渲染 full state；不可见 section 不执行 model/DOM render；进入后只渲染最新状态。
- 至少 1,000 次取消/重试循环后，监听器、timer、队列、锁记录和临时状态不随次数线性增长。
- 慢 SSE 客户端、超大响应、断线重连、旧 generation 回执、压缩失败和分块恢复。
- 稳定版/预发布比较、错误 VSIX、损坏 hash、同版本安装及配套更新部分失败。
- 用户失败通知一次、取消不报错、按钮终态不等待弹窗关闭、任何后台事件不自动跳转。
- 普通命令、CSV 指标项目及现有 MultiModal 三类接入均通过。

### 真实性能验收

在相同工作区、相同历史规模和相同网络条件下记录修改前后数据：

- Extension Host/Webview 内存、CPU、事件循环延迟。
- payload 字节、字段归因、IPC 字节/分钟、ACK 延迟、section 渲染耗时。
- 每 Worker 请求数、最大并发、排队时间和恢复时间。
- 同步有效吞吐、压缩耗时、压缩率、重试重复传输字节。
- 临时文件数量/体积、锁记录数量、后台连接与监听器数量。
- 至少一次 8 小时真实运行，覆盖隐藏/恢复 Panel、项目切换、断线和重复操作。

性能改进以这些数据判断，不预先承诺百分比。最终报告必须分别列出代码验证、故障测试、MultiModal 现场验收和仍未验证的项目；未完成现场测试时不能宣称黑屏、同步或长期稳定性问题已经全部解决。

## 6. 新增：长期使用后整页灰屏专项

### 6.1 本次查到的真实情况

2026-10-03 约 03:20–03:21（Asia/Shanghai），通过本机 `panel.diagnostics` 取得两次只读采样：

| 项目 | 实际结果 |
|---|---|
| VS Code | 1.140.0 |
| SimpleExperiment 运行/安装版本 | 均为 0.5.215，构建身份一致 |
| Panel lifecycle | `ready` |
| 第一次 posted/delivered/rendered | `16040 / 16040 / 16040` |
| 第二次 posted/delivered/rendered | `16184 / 16184 / 16184` |
| 未渲染 outstanding | 两次均无 |
| 当前会话 lastFailure | `null` |
| 最近 ACK 延迟 | 两次分别 21ms、17ms |
| 单份 payload | 约 474–475KB |
| 最近一分钟 full-state | 211–215 份，约 100–102MB 序列化数据 |

这里的每分钟字节是 **Host→Webview 状态发送统计**，不能解释为服务器隧道流量。它表明背压有效，但前端仍持续接收较多重复数据；最大字段是 `distributedPlans`、`operations`、`diagnostics`。需要继续优化，不能把“没有积压”当成“资源开销已经很低”。

历史诊断中仍有 **0.5.207 的 `heartbeatTimeout`，约 10 秒后出现 `panelReadyWatchdogTimeout`**。这证明当时自动重建文档后仍未完成握手，但没有记录足够证据区分脚本阻塞、Webview 容器故障或 renderer 崩溃。

本次可读取的 VS Code 日志没有找到与公开案例相同的 titlebar 异常或明确 OOM 记录；这些日志也不足以覆盖原故障时刻。因此：

- 当前采样没有复现通信失活。
- 旧版本失败不能计为当前版本失败。
- **长期灰屏的根因尚未锁定，也不能宣布已解决。**

### 6.2 网络上确有相似案例，但必须按证据匹配

| 类别 | 公开证据 | 对本插件的处理 |
|---|---|---|
| Windows Webview 运行一段时间后变灰 | VS Code 1.137.0 有运行约 5–30 分钟后灰屏的报告，涉及 guest window 的 titlebar overlay 异常；修复 PR 已合并。[问题](https://github.com/microsoft/vscode/issues/335931)、[修复源码](https://github.com/microsoft/vscode/pull/336604/files) | 审查时机器为 1.140.0，且未找到同类异常，不能直接认定同因。外链继续通过 Host `openExternal`，不引入 Webview `window.open()` 弹出窗口 |
| 视图布局变化使 WebviewView 空白 | 打开 Terminal 后多个 WebviewView 变空白的上游问题已被确认。[案例](https://github.com/microsoft/vscode/issues/277136) | 将侧栏隐藏、移动、终端展开和窗口布局变化纳入真实 VS Code 验收 |
| 更新后的资源缓存失效 | 有报告指出原地更新后资源仍解析到旧扩展目录，出现 `ERR_FAILED` 和空白页。[案例](https://github.com/microsoft/vscode/issues/325767) | 本插件主界面目前以内联脚本为主，不能照搬该结论；继续校验构建身份，并补资源失败归因 |
| 资源耗尽、renderer OOM | 有高并发资源加载失败及 renderer 内存耗尽报告。[资源加载案例](https://github.com/microsoft/vscode/issues/326500)、[OOM 案例](https://github.com/microsoft/vscode/issues/323819) | 分开测 Extension Host 与 renderer；前者内存正常不能排除后者故障 |

上游案例提供排查路径，不作为本机根因证明。尤其不能默认通过清空 VS Code 缓存、禁用 GPU 或扩大堆上限处理所有灰屏。

### 6.3 本地代码存在的可观测性与恢复缺口

本次源码检查确认：

- `webviewStateRendered` 在 `render()` 返回后发送，能证明应用执行了渲染流程，**不能证明 Chromium 最终完成了像素合成**。
- 全局 `error/unhandledrejection` 统一发送 `webviewBootstrapError`，且整份文档只记录第一次；运行较久后的不同错误可能丢失。
- 错误监听与主程序位于同一大段脚本内，无法可靠捕获该段脚本自身的解析失败。
- `showPanelRecovery()` 仍向同一个 Webview 写恢复页；如果容器或 renderer 已失效，恢复页也可能无法显示。
- `retainContextWhenHidden: true` 保留整个隐藏页面；官方明确说明该选项有较高内存开销。[官方说明](https://code.visualstudio.com/api/extension-guides/webview#retaincontextwhenhidden)
- 全页 MutationObserver 会在 DOM 变化后重新扫描标题元素；界面还包含大面积模糊、透明合成效果。这些是需要削减和测量的工作量，尚不是灰屏根因证据。

### 6.4 新增预防和诊断机制

#### A. 分层故障记录，记录恢复之前的状态

复用 `panel.diagnostics`，增加轻量 `incident` 摘要：

- 会话、VS Code 版本、插件构建、view/document generation。
- 最后一次状态接收、DOM 渲染完成、动画帧探针、heartbeat ACK 的时间。
- Host 事件循环延迟、页面可见性、最近窗口布局变化。
- 错误阶段：bootstrap、runtime、DOM/layout、消息通道、资源加载、宿主进程证据。
- 原始触发原因、自动恢复结果、无法判断的项目。

运行时采用最多 64 条事件的内存环；故障时保存到两个固定、限额的诊断槽位。只保存摘要和脱敏堆栈，不保存完整 state、日志正文或 token。详细记录按需读取，不随每份 full state 发送，不因性能遥测触发 `postState()`。

#### B. 独立的小型启动保护层

在主脚本之前运行独立 bootstrap，记录 `scriptStarted → bridgeReady → firstStateReceived → firstRenderCompleted`。

bootstrap 独占 `acquireVsCodeApi()`，通过明确接口供主程序使用；提前安装错误和 CSP/resource failure 捕获。静态 HTML 保留基本加载文字，即使主脚本无法解析也不只剩背景色。运行期错误按签名去重并有界保留，不再一律归为首次启动错误。

#### C. 区分通信、DOM 和绘制健康

保留现有 ACK、背压与 stall 判断，增加轻量主容器几何尺寸、可见样式和帧探针证据。正常布局隐藏、零尺寸停靠区域和后台页面不得误判。

保持真正 heartbeat ACK 超时判断严格；不提高现有时间阈值。性能慢只记遥测。

诊断明确显示“通信正常、DOM 已提交、像素状态不可直接确认”等状态。Electron 的 `render-process-gone` 属于宿主层能力，普通 VS Code 扩展不能假装直接订阅该私有对象；相关证据从可用的宿主日志或隔离验收实例获得。[Electron 接口说明](https://www.electronjs.org/docs/latest/api/web-contents#event-render-process-gone)

#### D. 恢复入口必须在 Webview 之外仍可用

新增原生命令面板入口“复制 Panel 诊断”“恢复 Panel”，复用现有诊断和恢复实现。

保留现有一次自动重建限制；若重建后仍无握手：

- 停止递归重建。
- 通过 VS Code 原生通知说明具体失败阶段。
- 提供复制诊断、重新加载面板、用户主动重载窗口的入口。
- 不自动跳转、不停止训练、不重复提交任务、不清理项目结果。

如果整个 VS Code renderer 都已崩溃，在线通知也可能不可用；下次激活应展示上次异常退出摘要，而不是承诺任何情况下都能弹窗。

#### E. 降低长期驻留与合成负担

- 将全页标题扫描改为处理 MutationObserver 的实际变化子树，合并重复节点并限制单次工作量。
- 图表、观察器和定时器归属于 document/section，隐藏时解除非必要订阅。
- 恢复模式使用简单背景和低合成开销样式，取消大面积 blur、复杂阴影和过渡动画。
- 完整补齐草稿、筛选、滚动位置和当前区域恢复测试后，将默认隐藏行为改为可卸载上下文；每次重建分配新的 document generation。
- 保留显式兼容选项供必须常驻的场景使用，禁止保存完整 full state 到 `vscode.setState()`。

隐藏再显示只恢复界面和获取最新状态，不重放业务命令。

#### F. 用本次真实负载验证原计划的优化

以本次约 100–102MB/分钟的状态发送量作为一个已测基线，记录对应页面与工作区快照。重点追踪：

- 为什么大量 section 已判定 `signature-unchanged`，仍持续发送 full state。
- `diagnostics` 约 52.7KB 的哪些内容无需常驻传输。
- execution 历史是否可以保留轻量行摘要，仅在展开时提供详情。
- 时间戳、诊断计数和重建对象是否造成无业务变化的 revision 更新。

通过消除无效变更、减少数据和计算实现降负载，不用固定长间隔或周期性重载掩盖问题。

### 6.5 新增批次和灰屏验收

| 新批次 | 内容 | 门槛 |
|---|---|---|
| 5A | 故障分层、独立 bootstrap、原生诊断与恢复入口 | 主脚本解析失败、运行期异常、ACK 中断均能留下可区分证据 |
| 5B | 隐藏释放、观察器收敛、低合成恢复模式 | 状态恢复正确、无命令重放、资源数量有界 |
| 扩展批次 9 | 真实 VS Code 长时间与故障验收 | 同时检查诊断和实际画面，不能仅检查 ACK |

新增测试包括：

- 主脚本解析失败、运行期连续不同异常、CSP/资源加载失败。
- ACK 正常但主容器不可见、主容器被意外覆盖、DOM 存在但布局异常。
- 在隔离 VS Code 实例中暂停或终止 renderer，验证原生恢复入口及下次启动诊断；不操作用户业务窗口。
- 至少 100 次隐藏/显示、终端展开、视图移动、项目切换；验证草稿、滚动位置和 generation。
- 长时间空闲、高频状态更新、锁屏/唤醒、窗口最小化及远程桌面重连场景。
- 连续 8 小时验收中同时记录进程资源、通信、DOM 指标和定点画面；截图只用于验收，不加入生产高频监控。
- 保留并扩展 `panelRenderHealth`、`panelLifetimeRecovery`、`panelBootstrapRecovery`、`panelStaleDocumentHandshake`、`panelStateFlowControl` 等回归，逐文件串行执行。

最终结论分为三档：**根因已复现并修复、预防与恢复机制已验证、原现场暂未复现**。只有复现证据与修复验证对应起来，才能把“长期灰屏”标记为已解决。

## 7. 给 Luna 的执行交接与防误改说明

本节补充执行细节，不替换或削减第 1–6 节要求。用户已授权按本文开始实现；测试/构建、安装、实验、停止现场任务和清理等各自门槛仍按本文及项目约束执行。

### 7.1 先确认实际工作树，避免把旧计划当作当前事实

1. 主工作区是 `D:\GitRepo\MCP\zlk-cluster-orchestrator`。重新读取根目录 `AGENTS.md`、`docs/project-constraints.md`，执行 `git status`、检查分支与 remote。`AGENTS.md` 开头保留有旧路径文本，不能据此切换到另一个仓库。
2. 原有 [安全重试 TODO](todo-safe-request-retry.md) 包含未完成批次的详情；[既有稳定性审查记录](todo-plugin-stability-audit.md) 是前次交付记录，不代表本计划已实施。
3. [目标模式文件](target-mode-plan.md) 目前记录另一个已完成目标。本次没有激活或重写目标模式。后续若用户要求目标模式，先按该模式规则同步目标和批次边界；不要删除本完整计划或覆盖其他目标历史。
4. 原有代码、测试和生成文件已 dirty，不能 reset、restore、checkout 覆盖或全量格式化。不要将所有 dirty 文件一次性提交。每批先审阅现有 diff，识别属于本批的修改。
5. 构建版本、已安装版本、Extension Host 运行版本和 Agent/SFTP 能力分别核对。审查时安装的 SimpleSFTP 为 0.2.46；未来不能把此值当作强制版本或兼容依据。
6. 单独的 SimpleSFTP 工作区在审查时为 `D:\GitRepo\MCP\simple-sftp`。涉及取消回执、压缩、暂存发布时，先读取其自身规则和 Git 状态，再限定修改协议所需范围。它是独立仓库，不能在 SimpleExperiment 中伪造它未提供的能力。

### 7.2 2026-10-04 未完成修改与阻塞快照

开始实施后，工作树包含安全重试新增模块：

- `src/core/SafeRequestRetry.ts`
- `src/features/PlanSafeRetry.ts`
- `src/core/SimpleSftpProgressWait.ts`、`src/extension/legacy.ts`、`src/ui/PanelHtml.legacy.ts` 的修改。
- 对应新增测试及若干旧 fixture 更新；部分 `dist` 已生成，但最新源码修改尚未完成最终门禁。

历史验证记录为：安全重试相关独立用例、build 和 vm.Script 门禁通过；`test/features/planStopClear.test.js` 中 `stopping during a hung fingerprint cancels that submission and a new one can enqueue` 曾在约 20015ms 超时，其余 32 条通过。2026-10-04 用户要求重新检查失败项后，该用例在 75ms 内通过；本轮进一步修复旧测试切片只读取 bootstrap 脚本、消息 mock 缺少当前依赖和队列写入 mock 未模拟固定 `.writing` 槽的问题，整文件现为 33/33。

**不得假设只是 fixture 问题，也不得假设生产代码已正确。** 先静态追踪等待、取消和资源释放链，构造可控、局部的定位证据。遵守项目“超时停止、不重试”的规定；不要为碰运气原样重复运行，不延长超时、不删除失败用例、不关闭并发保护来过关。本轮发现一个真实生产问题：共享 Worker task 请求的最后一个订阅者取消时，取消原因未传到实际 fetch signal；已修正并由 `planStopClear.test.js`、`tunnelClient.test.js` 验证。原超时用例经当前源码和隔离 fixture 复核后通过，批次 0 可从 deferred 更新为 passed；旧超时记录保留为历史。

两个用户 dirty `.pyc` 必须保留。保存本计划前的 SHA256 为：

| 路径 | SHA256 |
|---|---|
| `dist/runtime/__pycache__/cluster_agent.cpython-314.pyc` | `D5FE48406C58309DE04D804FFB9D4F611F4350226D67BD78AC21C00EEFD09AEB` |
| `dist/runtime/__pycache__/cluster_scheduler.cpython-314.pyc` | `B6261FD32D49AF800DAB701DA24D2DAA4E9F982CCACDF30A73D00E82EED00C74` |

哈希仅用于核对，不是恢复或覆盖用户文件的授权。执行时若用户又修改了文件，以新基线为准。避免完整导入 runtime 或使用会重写这些缓存的验证命令。

### 7.3 入口定位表：按符号找代码，不按历史行号机械修改

| 子系统 | 首要入口与需要交叉检查的模块 |
|---|---|
| 请求重试与停止 | `SafeRequestRetry`、`PlanSafeRetry`、`SimpleSftpProgressWait`、`assertPlanNotAlreadyActive`、`reconcileStalePlanRunOperations`、SFTP `createTransferController/openMappedDownloadStream/transfers.cancel` |
| 队列与锁 | `DistributedPlanQueue`、`loadDistributedQueue/saveDistributedQueue/tickDistributedQueueCore`、`ResourceOperationLease`；保留 immutable display snapshot 与磁盘签名 |
| 结果与产物 | `ProjectResultTables`、`writeProjectResultRegistry`、`rebuildDistributedResults`、`retainLatestDistributedPlanOutputs`、`PlanOutputRetention`；复用最新 completed run 权威 |
| 隧道和流 | `RequestBudget`、`RealtimeTunnelClient.legacy`、`MultiEndpointRealtimeClient`、`LocalApiServer.legacy`、Agent HTTP/SSE；控制请求与长连接分开计数 |
| Panel Host | `buildState/flushStatePost`、`PanelStateFlowControl`、`PanelStateProjection`、`PanelPlanStatusSummary`、`PanelBuildIdentity`、heartbeat/ready/recovery 入口 |
| Webview | `PanelHtml.legacy` 的 render/section signatures/visibility/progress patch；`PanelBootstrap`、`PanelRecoveryHtml`；保持外层模板转义正确 |
| 生命周期与附属功能 | `extension/Activation`、`extension.ts`、`TensorBoardLocalProxy`、`PptPlotBridge.legacy`、`GitBackup`、`ExtensionUpdates` |

### 7.4 实现时必须守住的语义

- **取消等待不等于取消底层工作。** `Promise.race` 或 AbortController 触发不能单独证明进程和远端写入已退出。普通超时不能释放仍由未知执行占用的互斥。
- **相同请求和相同目标不是单一按钮名。** key 需包含规范项目、端点和操作目标；读请求可合并，写请求要依据资源冲突。兼容别名不能绕过同一 guard。
- **锁超时不是所有者已死亡的证明。** 固定槽位复用必须有互斥、所有者身份与代际验证；无法判断的旧记录隔离诊断，不能直接抢占。
- **整组结果并不因逐文件 rename 自动变成原子。** 插件内部读者必须按已提交 generation 读取；固定路径导出是兼容输出，崩溃恢复完成前不能声称整组原子可见。
- **只保留最新完整产物不等于立刻覆盖正在运行的 attempt。** 新版本未完整验证前保留上一份可用版本。旧 raw 元数据追溯、旧目录清理与当前表读取权限分开处理。
- **没有加载不等于真实空值。** projection 的 `notLoaded/omitted` 和真实空数据继续区分；所有 Plan 的轻量摘要仍基于未裁剪运行证据，不能因省 payload 把历史 Plan 标成未开始。
- **不要把历史 evidence、当前 session 和 pending generation 混在一起。** UI、诊断、测试都要分别标注；正常 lag 不等于 stall，ACK 不等于像素绘制完成。
- **`retainContextWhenHidden` 的改动是有前置门禁的。** 先验证草稿、筛选、滚动位置、隐藏期间更新、首次显示、旧回执拒绝和新 document generation；未通过前不得只改一个布尔值上线。
- **遥测不能形成业务更新回路。** 高频样本保留在 bounded ring，诊断页按需读取；不得因记录 sectionSlow、流量或 ACK 耗时再次 `postState()`。
- **不要改变正式训练或结果数学语义。** 用带明显 runId/outputDir/hash 区分的 fixture 验证，不能只用相同指标数值推断采用了新 run。
- **清理与诊断采样都要有上限。** 第 6 节每个持久诊断槽位上限设为 256KiB，原生通知按 incident 去重；不创建每秒一份的诊断文件或截图。未知证据标记 unavailable，不编造数值。
- **保留旧公开入口。** 内部可以抽模块，UI/CLI/API alias 保留兼容；不要用空 service、catch 后假成功或强制覆盖绕过失败。

### 7.5 批次验证及外部依赖规则

- 先 `rg --files test` 定位实际文件；下面名称用于导航，不保证未来路径不变。
- 批次 0/1 优先：`safeRequestRetry`、`planSafeRetry`、`safeRetryFeedback`、`duplicatePlanSubmissionGuard`、`planSubmissionOwnerReconcile`、`planSubmissionVisiblePreflight`、`planStopClear`。`planStopClear.test.js` 已在 2026-10-04 回检通过 33/33；其历史超时仅保留作记录。
- 队列/结果优先：`distributedPlanQueue`、`distributedQueueStartup`、`distributedRerunAndWorkerDelta`、`pendingResultMetricSync`、`projectResultSyncCompleteness`、`projectResultTables`、`runCompletionResultRefresh`、日志身份相关用例。
- Panel 优先：`panelLifecycleDiagnostics`、`panelMessageDispatch`、`panelStaleDocumentHandshake`、`panelStateProjection`、`planSelectorStatus`、`panelProgressDom`、`panelRenderHealth`、`panelStateFlowControl`、`panelStateProgress`、`panelLifetimeRecovery`、`panelUnknownHealthRecovery`、`panelWebviewScriptHealth`、`panelBootstrapRecovery`。
- 逐文件使用 `node --test --test-force-exit --test-timeout 20000 <单个文件>`。禁止同时运行 Node/Python 测试，禁止一开始跑宽泛 `npm test`。
- 相关目标测试通过后，按项目规则运行 `npm run build` 和 `node -e "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8'))"`，并保留实际 HTML 内联脚本解析测试。只验证外层 JS 文件不能替代内层脚本门禁。
- 此处 20 秒限制针对单个测试进程；8 小时 soak 是独立的显式验收阶段，不能伪装成已通过的单元测试，也不能通过扩大上述测试超时实施。
- 调整默认并发和压缩参数前记录 workload、文件类型、页面兴趣区域和链路条件。128MiB 是批次字节边界，不是允许一次性把 128MiB 全读入内存。
- 外部源码大多已固定 commit；浮动链接执行时记录实际 commit。Issue 作者的推测不是本机证明，检查是否已有上游修复。复用源码先核对许可证，禁止引入 Redis、同步守护进程或通用前端框架作为默认依赖。
- 本机、Agent、SFTP 和不同版本组合均需兼容测试。能力缺失时明确安全降级，不能按版本字符串猜测回执字段存在。
- 现场 API 每次先读 discovery 和 live capabilities/openapi，端口及根目录来自实际配置；只通过 SimpleExperiment/SimpleSFTP 执行运行或传输。保留精确目标与必要确认。
- 不在用户工作窗口注入 renderer 崩溃，不自动禁用系统 GPU，不自动清空 VS Code 全局缓存，不私自中止现场训练。无法取得真实现场条件时保留“未验证”，继续完成独立可验证的工作。

### 7.6 进度维护与交付

执行顺序固定为 `0 → 1 → 2 → 3 → 4 → 5 → 5A → 5B → 6 → 7 → 8 → 9`。每批限定 2–3 个相关问题、最多 8 个源码/测试/文档文件；生成构建文件不计入该数。更大批次拆为子批次，不悄悄扩范围。

本文件第 1–6 节保留作为验收基准。执行时维护下表，每行只记录最新状态、证据位置/命令摘要、真实 commit、剩余门槛；详细历史由 Git 与相关既有 TODO 保存，不不断创建新的临时总结文件。状态只用 pending、running、blocked、passed、failed、deferred；功能实现通过而现场未测时，在剩余门槛明确记录，不能把总验收勾完。

| 批次 | 状态 | 最新证据 / commit | 剩余门槛 |
|---|---|---|---|
| 0 | passed | 2026-10-04 `node --test --test-force-exit --test-timeout 20000 test/features/planStopClear.test.js` 33/33；之前超时的取消/重提用例约 75ms 完成；`test/tunnel/tunnelClient.test.js` 5/5 验证最后订阅者取消原因到达 Worker fetch | 不代表批次 1 的 SimpleSFTP 版本组合或远端未知结果已验收 |
| 1 | running | SimpleSFTP `b2e39f9` 历史验证结果保留；主仓 `OperationQueue` 超时/取消改为 `cancelling`，只有底层 Promise settle 后才释放 exclusive key，避免 abort/timeout 早到时并发重启；Agent 上传增加按 clientTransferId/目标路径匹配的 upload-cancel settle 回执，逐块/提交请求结算后才允许替代上传；旧 Agent 未声明能力时安全阻止替代重试；Agent 与 Scheduler PID 探测只把 `ESRCH` 当作已退出，权限和未知探测错误保持活动保护；本轮发现并收紧 upload-init 与取消并发窗口，取消可在本地 HTTP 中止收尾的同时立即通知 Agent，未知远端上传保留在 bounded history 且不会被回收；Agent 对初始化请求进行 owner 级互斥，取消尚未落入 upload row 时会留下限额/TTL tombstone，防止迟到 init 越过 settled 回执继续写入；Agent stop marker 绑定 pid/runId，旧 marker 不再清理且不能停止新代进程；exit-code 以可复用 pending 标记开始，仅读取完整整数作为完成证据 | 当前 OperationQueue、安全重试和 Agent 旧/新版本组合尚未验证；SimpleSFTP 版本组合、未知远端结果和现场重试验收留后 |
| 2 | running | 延续已推送的精确清理门禁；Git backup 卸载不再删除 hook 文件或吞掉写入失败，Agent 长期状态只生成限额清理候选，不后台删除；状态扫描限制为 10,000 个目录项、拒绝符号链接与越界目录；被动中断重试也不再自动下发删除 Worker 产物，而是记录带项目/Plan/run/attempt/Worker/outputDir 身份的候选；分布式队列改为固定 `.writing` 暂存槽、文件同步后原子替换，POSIX 尽力同步父目录，避免每次失败遗留随机临时文件；Agent 上传发布遇 Windows sharing violation 只进行有界 `os.replace` 重试，失败保留旧目标和暂存，不再删除旧文件后退化为非原子 move；产物删除 API 现在要求两项确认，只接受已展开的项目内绝对路径，移除按任务 ID 搜索删除回退，并在物理父目录内校验后执行；Plan 停止后的 Worker task 终止限定到同一 `workflowId/runId`，scheduler 孤儿回收限定到目标 tmux session；Plan sync ledger、sync holds、project mirror、代码同步状态及项目 UI 状态写入使用路径级资源锁；共享状态、PPT 审计、草稿和同步选择记录写入共用可复用固定 `.writing` 槽、同步后原子替换；资源锁注册槽按 Extension Host 进程稳定复用，过期恢复仅保留一个固定 `.expired` 槽，避免每次启动/回收新增永久文件；清空 UI 状态写入空记录/墓碑，不自动删除项目文件；启动任务时用 pending 内容替代清除旧 exit-code，完成读取要求合法整数，防止陈旧成功码误判；已拒绝/过期草稿清理改为经双阶段路径预览后移动到 clean_dir，核验普通文件、符号链接、硬链接、父目录与 hash，并追加有界 MANIFEST | 实现尚未验证；固定写入槽与 Windows 文件占用行为、跨窗口状态竞争及运行时清理策略留待代码回归；Agent 外部状态候选仍需完整路径双确认；task run-identity 与现场验收留后 |
| 3 | running | 历史 commit `22d12add` 的事务行为曾通过相关测试和 build；publication journal 与每个索引的 `.new/.old` 暂存/备份改为单一 `current` 固定目录复用；成功发布与恢复不再删除事务文件，未完成事务保留 journal 并由后续恢复/发布复用；无旧目标的回滚以 rename 移回暂存槽，不删除目标文件 | 重新验证固定槽复用、失败回滚、旧版随机目录 journal 兼容、publication 原子性；双窗口竞争及 Extension Host 崩溃恢复留待现场验证 |
| 4 | running | 既有 SSE 背压、journal gap、RPC 取消、请求预算实现保留；控制请求与压缩传输采用轮转仲裁，避免持续快照与长传输互相饿死；Agent `BoundedThreadingHTTPServer` 已有限制 SSE 连接/线程、事件/批次字节及 socket 等待时长；Local API 的任务/结果/日志/tmux 只读 RPC 已把断连取消传到隧道请求，并对共享 Worker task snapshot 按订阅者引用计数，最后一个调用方离开时才取消底层读取 | 集成测试按用户指示暂缓；慢消费者、并发、单订阅取消和断线压力验证留后 |
| 5 | running | `buildState()` 增加日志投影缓存与耗时字段；distributed Plan 进度按队列、Worker 快照修订和目标集合缓存；非 execution 页面只映射当前/活动 Plan 明细；Agent 状态清理诊断增加有界目录扫描与完整性标记 | 相关回归与性能基线留后；源码计算热点复核和现场 payload 数据留后 |
| 5A | running | Panel 静态启动遮罩、阶段诊断和恢复入口已加入；Host 接收 generation-scoped 事件；render geometry 增加有界遮挡 hit-test 证据；新增 100ms 粒度的 Host event-loop delay 有界采样与 Webview viewport/cardDeck/mainColumn/inspector 布局事件快照，诊断不随 full state 发送且不触发 postState | 主脚本解析、CSP/runtime 故障与原生通知验收留后 |
| 5B | running | 隐藏时释放 Webview 已启用；瞬态 UI 状态恢复保留；title MutationObserver 暂停时清空待处理 DOM 引用并跳过脱离文档的子树；TensorBoard Scalar Dashboard 在切换 case、关闭曲线页、文档隐藏或 pagehide 时取消未完成 catalog/tag/series 读取，并通过 Local API request signal 传到 Agent fetch/body reader；自动刷新改为按用户间隔递归调度，连接健康检查在隐藏期间停表并中止当前探测 | 100 次隐藏/显示、焦点/草稿/滚动恢复验收留后 |
| 6 | running | 多 Plan 映射下载使用压缩 tar、按字节/文件数分批、逐文件 SHA256 校验；缺少 hash/size 时先对精确路径做 bounded `projectInventory`，优先复用远端持久哈希缓存；校验通过的本地文件本身作为跨进程恢复检查点，避免另造长期 sidecar；Agent 上传取消使用有界 chunk/commit 活动计数和单一目标暂存槽，能力协商后向旧/新 Agent 安全降级 | 需核实 SimpleSFTP 旧/新版本组合下哈希回退、单批失败重试、upload-cancel 并发边界和暂存收尾；测试和现场恢复验收留后 |
| 7 | running | 用户操作失败终态先回传，再弹 modal；自动导航要求 `userInitiated`；更新资产版本/目标校验已有实现；新增 bounded `OperationOutcome` 分类，将成功、用户取消、请求替代、配置错误、资源冲突和远端结果未知映射为稳定 code/retryability/certainty，并随 UI 终态和最近错误摘要传递；PPT discovery/health/plot 请求支持项目切换和扩展停用取消 | 分类覆盖率、通知去重、更新组合及附属窗口回归留后 |
| 8 | running | 通用命令档位支持工作目录、输入/输出与可选指标采集；Scheduler 按合并后的每 case runner 命令推断单阶段模式；PlanBuilder、Results、Quality、TunnelClientPool 工厂缺失实现时不再返回空结果、通过状态或无操作客户端 | 仍需核实 Runner 输出契约、路径边界、工厂运行路径与兼容性；测试统一留后 |
| 9 | pending | 仅有第 6.1 节短时只读采样 | 全插件回归、现场与 8 小时 soak |

#### 本轮实现追加（尚未验证）

- 批次 2/3：ProjectResultPublication journal、资源锁注册表、代码 manifest 缓存和同步范围哈希缓存统一复用 `atomicWriteText` 固定 `.writing` 槽；Agent 高频 JSON/CSV/text/Plan 队列及事件 journal 写入统一复用固定槽、64 路有界条带锁、文件同步和目录同步。Worker task snapshot 持有项目文件租约后原子替换。
- 批次 2/6：代码上传清单与同步范围清单跳过 `.writing`、`.pending`、`.tmp.*` 和 `.upload.*` 暂存文件，避免把半成品当项目内容同步；Agent 清理诊断将固定 `.writing` 槽列为有界候选，不后台删除。
- 批次 1/2/6：Agent 上传协议新增按明确 transferId/clientTransferId/remotePath 定位的 cancel-and-settle 回执；在途 chunk/commit/init 被计数，进入 `cancelling` 后不再接受新写入，最后一个在途请求结束才返回 settled；初始化尚未建 row 时用最多 256 条、10 分钟过期的内存 tombstone 阻止迟到 init；插件在本地请求退出期间并行发出远端取消，并对未知/旧 Agent 回执保留 `unknown` 且阻止同目标重试。上传覆盖在 Windows 原子替换失败时不再删除现有目标。
- 批次 6：文件传输任务历史限制为最多 256 条、已确认终态最多 128 条，未知远端结果受保护不淘汰；取消先进入 `cancelling` 并等待本地请求与远端回执结算，停用扩展时中止并限时等待传输收尾；下载流改为全量写入、`fsync`、失败取消响应流，避免整文件 `arrayBuffer` 常驻内存；上传持有本地源文件与远端目标双资源租约，并在哈希/传输前后核验源文件身份；范围下载失败时安全回滚固定检查点，避免自动重试重复追加。
- 批次 1/4：本地 API 触发与 Webview 共用安全传输请求替代；相同只读后台请求合并在途 Promise，settle 后立即释放；OperationQueue 对待处理数设上限，并让排队取消以取消结果结算。
- 批次 2/3/7：结果发布暂存/备份固定复用 `simple_cluster/tmp/result_publication/current/<index>.new|old`，committed journal 作为当前已提交标记保留；发布失败时只回滚本次 `publishing` 阶段已触碰的目标，未发布的准备阶段不碰目标；锁回收将验证过期且 owner 已退出的旧记录留在唯一 `.expired` 恢复槽中供下一次原子替换，不再每次 unlink。
- 批次 7/8：PowerPoint 启动及公开打包脚本统一调用 PowerShell 7 `pwsh.exe`，移除业务代码对 Windows PowerShell 5.1 `powershell.exe` 的依赖。
- 批次 1/2：Agent stop 状态固定为带 `pid/runId/requestedAt` 的原子 JSON；run 在登记 pid 前生成 runId 并在 config/pid/lock 中使用同一身份，stop 命令只对仍存活且 config 与 pid 身份一致的代次写入停止请求。旧 stop 文件保留为有界复用槽，新进程会忽略不同代次的旧请求。任务 exit-code 先原子写入 `pending`，读取方只把完整有符号整数当作完成证据；GPU-pane 失败后 fallback 复用 commandId 对应的同一 exit-code 路径。
- 批次 2/7/8：草稿 Plan 扫描改为有界目录项、拒绝链接/跨设备路径并对文件执行安全有界读取；损坏草稿元数据不再伪装为空，草稿元数据的同进程更新串行化并由项目状态文件租约跨窗口保护。同步本机删除在执行前后二次核验直接父目录和目标身份，PowerShell 只接收 `./<leaf>`，校验目标类型、时间戳、大小和重解析点后才删除。PPT discovery/token、绘图文件、请求与响应均增加有界读写；源文件读取使用 no-follow 与身份复核。
- 批次 2/8：隧道 URL 对自定义 hostname、IPv4 和 IPv6 做统一校验及 IPv6 authority 格式化；Agent 启动命令按 Hub/Worker 各自配置绑定 remoteAgentHost。Agent 自动停止逻辑移除按端口杀进程的回退，只匹配本插件 Agent 的 host、port、mode 与 runtime，端口被其他服务占用时不再误杀。
- 批次 2：Plan 归档不再复制后 unlink 源文件；Plan YAML、独占配置与本地 Plan 专属证据在预览的来源/目标路径约束内原子 rename 进归档包，失败时按身份逆序恢复；归档 staging 与失败副本保留为可检查恢复数据，不做递归 rm。草稿清理不再永久 unlink，默认移动到项目 `clean_dir` 并追加大小受限的 SHA256 manifest。
- 批次 2/6：本机同步范围清单改为有界迭代扫描，限制 10,000 目录、100,000 目录项、50,000 文件；拒绝符号链接、跨设备路径和解析越界，目录身份在扫描前后复核。文件哈希用固定内存块且最多读取扫描前记录的文件大小，打开和读取后复核身份；同步哈希缓存限 50,000 项/16MiB，当前清单优先、历史项有界滚动。
- 批次 8：ServiceFactory 拒绝空壳 API 方法表中的非函数处理器；CommandFactory 将缺失/非函数命令映射视作未绑定并在注册前整体拒绝；未绑定命令的错误不再序列化命令参数，避免循环引用/大对象令错误处理自身失败或泄漏参数内容。
- 批次 4/5B：独立 Scalar Viewer 也取消 500ms 间隔轮询，改为递归单次定时器；页面隐藏、切换到原生 TensorBoard 或卸载时取消 catalog/tag/series 在途请求，返回后仅接受最新 series generation，避免辅助曲线窗口在长时间打开时持续空转并压住旧查询。
- 批次 7：Plan 自动失败通知先尝试显示 modal，再持久化已通知键；显示失败时释放本 session 去重键供后续状态重试，避免先写“已通知”后 UI 未呈现导致错误永久静默。
- 批次 7：配套插件安装前重新按当前 VS Code 已安装版本计算更新计划，只下载/安装 updateAvailable=true 的组件；配对状态已变为最新时跳过重复安装。

### 7.7 2026-10-05 实现对照复核

基线 `94721aa9 / 0.5.216` 已推送到 `origin/master`。此前 147 个变更测试文件串行通过，build、Webview 脚本健康检查、vm.Script 与 VSIX 打包通过；这不等价于全仓测试或现场验收。原有两个 `.pyc` 为用户允许再生成的缓存，不纳入代码提交。

| 项目 | 状态 | 本轮核对 / TODO |
|---|---|---|
| 事务与临时文件 | passed | publication 不再自动 unlink/rmdir；保留 committed/rolled-back journal，固定槽复用；备份按已验证独占文件描述符流式写入，拒绝硬链接。publication 9/9、resultTables 18/18，包括 20 次重复发布、准备失败、旧 journal 恢复和全量回滚 |
| 调度与请求负载 | passed | `23c0b4b7` 修复固定 500ms availability push 与失效配置：按配置上报、最小5秒；恢复 poll/TTL/push 的文档边界并同步 Host/UI/manifest。schedulerContract 2/2、configBounds 6/6、extensionStatePost 5/5、schedulerAvailability 12/12、queueCacheStability 7/7；distributed queue 的 500ms tick 保留；requestBudget 11/11 验证每 Worker 控制4/传输1、全局控制8/传输2及独立紧急容量；SSEBackpressure 3/3 |
| 传输与兼容 | partial | `4afca2c8` 修复范围同步仅限制文件数而未限制字节的问题：归档最多128MiB，未知/超大文件独立批次；复用 bounded JSON/SSE decoder，异常流释放 reader，取消请求附 operationInstanceId。sftpProgressWait 4/4、safeRequestRetry 9/9、syncScopeTransferBatch 7/7、boundedResponse 5/5、planSafeRetry 9/9、cancelRetry 2/2；当前配套 SimpleSFTP 0.2.46 的 auto 仅按 zstd 工具可用性选择，压缩收益采样尚未实现。未改配套仓库，不把该项标记为完成 |
| Panel、通知、生命周期 | local-tests-passed | `af43264a` 修复诊断持久化串行 Promise 链积累历史快照：只保留1个在写与1个最新待写，故障仅记录 bounded persistence error；共享读取长身份改用完整 SHA256，避免截断错误合并。sharedReadCoalescer 5/5 含1000次快照积压与实际 Host 写入回归；Panel 核心7文件全部通过（9/5/2/12/10/13/11）；messageDispatch 8/8、staleHandshake 1/1、bootstrapRecovery 7/7、planSelector 11/11、catalogCache 1/1、apiCancellation 1/1、actionLifecycle 9/9、safeRetryFeedback 2/2、navigation 1/1、workspaceIsolation 19/19、agentScope 4/4；保持 ACK/背压/projection 与局部 DOM patch |
| 更新与通用接入 | local-tests-passed | `ce5cc874` 补齐显式 SemVer 依赖：固定 npm semver 7.7.3，仅打包 compare/valid 的9个模块闭包（20,274字节）及许可证；修复 Windows 绝对路径/ADS 契约漏洞。extensionUpdates 7/7、distributedProjectContract 6/6、publicReleaseBundle 4/4、pluginHandoffContract 3/3、multiFormatOutput 1/1、两组 factories 8/8 与14/14。通用 runner 测试证明只需命令/cwd/inputs/outputs/命名任务，无 suite/base_config/seeds/指标或第二阶段要求 |
| 结果、锁与恢复 | local-tests-passed | pendingResultMetricSync 26/26、projectResultSyncCompleteness 16/16、runCompletionRefresh 1/1、distributedRerun 8/8、outputRetention 15/15、跨插件 leaseCompatibility 1/1、hostLease 10/10、manifestStaging 4/4、tunnelClient 5/5、realtimeReconnect 4/4；最新 run 权威、旧 raw 追溯和严格 active guard 继续保留 |
| 测试隔离与可重现打包 | local-tests-passed | memoryBudget 1/1、TensorBoard scalar 9/9、planRunModeWorkflow 5/5 改为函数切片和静态 fixture；不 import/启动完整 Agent/Scheduler、不创建实验或临时项目；Python 子进程限10秒且 windowsHide。VSIX 门禁首次因隐式 npm exec 联网等待在10秒失败；固定本地开发依赖 VSCE 4.0.0、直接 Node 调用且8秒限时后，新实现2/2通过；未延长测试阈值 |
| 回归与交付 | local-gates-passed | 55 个目标测试文件390条均通过；`d8b12158` 为测试隔离及打包工具修复提交。0.5.217 的 `npm run package`（含 build/内联脚本门禁/VSIX闭包）与独立 vm.Script通过；直接读取VSIX验证187个runtime文件的SHA256全部匹配，包2.21MiB，无pyc/node_modules。安装一次成功，`code --list-extensions --show-versions` 为 `simple-local.simple-experiment@0.5.217`，simpleex npm入口和其package版本也为0.5.217。安装后停止Panel操作，现场待用户 Reload Window；交付版本改动按 scoped commit 普通推送，Git日志记录实际提交 |
| 配套剩余实现 | pending | SimpleSFTP 需要按有限样本压缩收益、CPU时间、链路吞吐选择压缩；现有工具能力协商不能证明该要求完成。本轮只读核实配套仓 `extension.js` 已有未提交修改（221行新增/29行删除）及多个未跟踪VSIX，全部保留，未混入本仓提交或安装。后续在配套仓独立批次审阅既有改动后补实现与测试，不更改本仓的传输状态机或引入未经验证的协议参数 |
| 现场与长时门槛 | deferred | `test/core/operationQueue.test.js`、`test/cli/simpleCli.test.js` 两个已知挂起进程不原样重跑；SimpleSFTP 旧/新版本组合、MultiModal 最新产物与 payload/吞吐实测、灰屏现场、跨窗口崩溃恢复、8小时 soak 与100次布局切换仍保留，未实测不宣称解决 |

本轮目标测试按项目约束逐文件执行 `node --test --test-force-exit --test-timeout 20000 <file>`，没有并行测试进程。55 文件是相关目标回归，不是全仓测试总数；上述压缩实现缺口和现场门槛仍是计划未完成项。历史文件和两个用户允许再生成的 `.pyc` 不纳入提交。

### 7.8 2026-10-05 配套实现与计划收口

用户要求本轮完成全部计划内实现；8小时 soak、人工现场和长时间观察由用户后续执行，不作为本轮阻塞。基线：主仓 `8591f513 / 0.5.217`，两个 `.pyc` 保留；SimpleSFTP `b2e39f9 / 0.2.46`，已有 extension.js 的221行新增/29行删除及未跟踪VSIX必须保护，按实际diff审阅后才能纳入相关交付。

| 项目 | 状态 | 交付边界 / 核验 |
|---|---|---|
| 有界压缩收益采样 | local-tests-passed | SimpleSFTP `compression-policy.js` / `compression-sample.py`：最多8文件、256KiB分散窗口，读取不写sample/temp文件；Python采样3秒、SSH外层5秒；真实gzip样本字节/CPU/耗时及双方协商后的zstd参与成本比较，收益或成本优势不足5%使用none。link摘要最多64端点组合/15分钟，仅内存；无实测时明确使用估计。压缩策略6/6、协商/完整传输7/7，不将估计写成现场提速 |
| 暂存与恢复发布 | local-tests-passed | `staged-tar-receive.py`：32固定槽，普通批次完整hash校验后发布；超大单文件最大64GiB，以8MiB SHA256帧连续流传输，重试验证checkpoint后从缺失块继续；无逐块SSH和自动unlink/rmtree。未知/损坏所有者隔离保护。一次checkpoint核验+一次压缩流fixture通过；100次固定槽复用、坏hash保留旧目标、分块失败恢复和fd关闭通过。checkpoint核验会修改暂存journal，按写请求保留远端未知结算保护 |
| 计划全条目复核 | implementation-complete | 下表逐项对照批次0–8/5A/5B；旧OperationQueue挂起fixture改为可控底层settle并验证互斥不提前释放，7/7；CLI关闭模拟HTTP连接并限制子进程10秒/输出字节，原5个HTTP/root回归全部通过。未删除失败测试、延长测试时限或放宽active guard |
| 串行回归与交付 | local-gates-passed | 主仓42个完整目标文件及CLI文件中的5个目标用例，共390项通过；配套27文件142项通过，均逐文件串行。主仓build/内联脚本/vm.Script/187模块闭包通过；配套JS语法、Python AST、16文件闭包通过。源码版本0.5.218/0.2.48；`scripts/verify-delivery-artifacts.py` 直接读取ZIP、流式核对187/16个源码SHA256及两层package/VSIX身份，不解压写临时文件。仅安装各目标一次，核对结果与提交记录在交付补记中保留 |

#### 全计划实现对照（当前状态）

| 批次 | 实现入口及证据 | 当前状态 |
|---|---|---|
| 0/1 | `SafeRequestRetry`、`PlanSafeRetry`、`OperationQueue`、`SimpleSftpProgressWait`、Agent upload-cancel及SFTP durable settlement：旧请求未settle不释放资源；失败历史不阻碍新请求。planStopClear33/33、safeRequestRetry9/9、OperationQueue7/7、SFTP settlement3/3及取消/关闭资源回归通过 | implementation-complete |
| 2 | `ResourceOperationLease` / `StateStore`、Agent scope/cleanup、固定审计环及精确停止：本轮补有界8MiB nofollow读取、独立ownership摘要；损坏主记录按已证实资源保护，双记录损坏fail-closed；只回收已released、确认进程死亡的闲置注册槽，20次重启槽数恒定，竞争仍只允许一方。hostLease14/14、跨插件兼容1/1、staging4/4、agentScope4/4；两款安装器使用固定OS锁，关闭释放，禁止自动删除锁 | implementation-complete |
| 3 | `ProjectResultPublication` / `ProjectResultTables` / 最新completed-run权威和latest-complete retention：固定事务槽、完整generation后切换、不混seed；本轮publication9/9、resultTables18/18、pendingSync26/26、completeness16/16、rerun8/8、completionRefresh1/1、retention15/15；队列23/23、startup19/19、稳定cache7/7验证显示快照不被清空 | implementation-complete |
| 4 | `RequestBudget`、LocalApiServer、Agent bounded HTTP/SSE、SFTP `TransferCapacity`：控制4/Worker、8全局；大传输1/Worker、2全局，SFTP等待64上限、取消等待ticket；独立控制容量。SSE仅drain后结束replay，慢读队列限字节/订阅数；API断开只取消只读，写操作查询回执。SFTP discovery失败关闭新listener、请求body idle5秒/2MiB、响应8MiB。budget11/11、主/配套SSE各4/4、API19/19、capacity3/3通过 | implementation-complete |
| 5 | `buildState` 纯投影、按业务revision缓存、catalog后台加载、Plan轻量摘要、offscreen dirty和局部DOM patch：核心projection5/5、progress DOM2/2、flow10/10、seq progress13/13、selector11/11、sharedRead5/5通过。ACK及one-outstanding机制保持，未通过降低刷新频率/放宽健康阈值取巧 | implementation-complete |
| 5A/5B | 独立bootstrap、incident环/固定诊断槽、原生命令恢复、几何/遮挡/帧证据、隐藏释放与UI草稿恢复、Observer收敛、TensorBoard取消scope：renderHealth12/12、lifetime11/11、bootstrap7/7、diagnostics9/9、dispatch8/8、staleHandshake1/1、实际内联脚本1/1通过。ACK不证明像素正常，未复现原灰屏 | implementation-complete |
| 6 | SFTP跨Plan批次≤128MiB/80文件并限元数据；gzip/none/协商zstd；8MiB超大文件块；固定校验发布槽；上传generated manifest≤2MiB内存Buffer；日志/回执writer只保留1个在写和1个最新待写。mapped16/16、packed7/7、serverToServer11/11、metadata4/4、sample6/6、negotiation7/7通过 | implementation-complete |
| 7 | `OperationOutcome`、即时终态/异步通知、一次性userInitiated导航、标准SemVer/VSIX身份校验、生命周期scope及有界deactivate。SFTP停止自己资源并等待回执、不停止训练；API只使自己discovery失效。actionLifecycle9/9、navigation3/3、extensionUpdates7/7、installSafety10/10及配套API/settlement通过 | implementation-complete |
| 8 | 通用command/cwd/input/output档位、可选CSV/JSON指标、MultiModal preset、动态隧道、工厂缺实现明确失败、小型独立资源/事务/通知/压缩模块及README更新。contract6/6、multiFormat1/1、factories8/8及14/14通过；无额外训练框架、同步daemon或虚拟DOM依赖 | implementation-complete |
| 9 | 短时目标回归及build/package已完成；原现场灰屏、真实MultiModal产物/吞吐、旧新版本现场组合、8小时soak/100次布局切换、跨窗口强制崩溃仍由用户后续观察 | manual/long-run-deferred-by-user |

本轮失败记录：SFTP旧取消fixture等待Promise结束后才emit close，与新“等待close再释放”语义形成测试死锁，20秒停止并核对限定测试进程后，修正fixture顺序，整文件16/16；未延长门槛。主仓staging切片fixture缺少新增helper/Buffer依赖及ownership固定槽期望，补真实依赖后4/4。SFTP VSCE首次8秒冷启动超时，检查本地工具入口后同一限额的build/package通过，未联网取工具或扩大时限。当前相关短时回归无失败；全仓600余文件并未全跑，CLI整文件长回归也未宣称完成。

SFTP既有extension.js修改已按diff审阅并合入相关能力/哈希/批次实现，没有覆盖为旧版；旧VSIX、未知恢复槽和两枚pyc保留。用户确认的永久清理门禁仍保留；可恢复数据不是可随意删除的垃圾。测试隔离证据保留以符合删除约束，不纳入交付。实际链路CPU、吞吐、payload/min和灰屏现场未测，本轮不报告百分比提升。

交付复核补记：SFTP安装器首次因临时根目录尾部斜杠触发严格parent检查，在执行安装前停止；规范化路径并补两条原生PowerShell回归后通过，提交`53a234e`。0.2.47安装一次，后续只读核对发现新固定stage目录/锁和mapped partial可能进入项目清单，补齐JS/Python清单、默认同步和精确路径的统一排除，真实Python清单fixture验证不会扫描或hash暂存数据；该生产修正单独推进0.2.48。此前0.2.47未被重复强制安装。配套主体实现提交`74e7a65`，均普通推送并fetch确认。SimpleExperiment 0.5.218已安装一次，已核对VS Code与全局CLI package版本；安装后不操作运行中的Panel，最终现场必须等待用户Reload Window。

最终配套提交`7821847`已普通推送至`origin/master`并fetch确认一致，工作树干净。0.2.48的27文件142用例、build/闭包/VSIX通过，包116,850字节；16个allowlist文件源码hash及VSIX身份核对通过。已显式安装0.2.48一次并核对VS Code/全局SFTP CLI package。最终版本组合为0.5.218/0.2.48，两个Host均须用户重载；未访问混合版本的Panel API，不把旧Host或尚未重载数据作为新实现的现场验收。主仓代码、测试、计划和版本交付以本次scoped commit及fetch后`HEAD==origin/master`核对记录为准；只保留原有两枚pyc未提交。

下列2026-10-04追加内容继续作为历史实现记录；其中旧的“尚未验证/running”描述已由本节当前对照及第7.7节局部回归覆盖。
- 批次 7/5A：Panel 将 navigate 消息作为一次性事件消费并立即清空待处理引用；导航不再受同一 batch 中旧 state 序号的 early-return 阻断，后续任意状态 batch 也不会重复播放旧的 userInitiated 导航，修复步骤完成后仍偶发自动跳转的问题。
- 批次 7：硬配置/认证失败提示改为修复配置后重新检测隧道，瞬态断线仍按连接策略自动退避恢复；manual_only 的显式手动恢复提示保留。
- 2026-10-04 回检：`planStopClear.test.js` 33/33、`tunnelClient.test.js` 5/5；`npm run build` 成功（含 TypeScript、产物语法门禁和 `panelWebviewScriptHealth.test.js` 1/1）；独立 Webview `vm.Script`、`git diff --check` 通过。两个既有 dirty `.pyc` SHA256 与文档中的保护基线一致。尚未执行 package、安装、远端版本兼容或人工现场/长时间运行验收；批次 1–8 保持 running，批次 9 pending。

每批先审阅 diff，仅提交属于已验证批次的文件。用户 dirty `.pyc`、运行报告和其他未审阅修改不得混入。按当前仓库规则向已核实的 `origin/master` 普通推送，fetch 后核对；上游变化、冲突、凭据或 hook 阻塞按规则停止，不自动 rebase/merge/force push。若用户的新指令将范围限定为“只保存文档”，该轮到文档保存与检查为止，不启动上述代码批次。

发布时重新确定版本，禁止盲目写死下一版本号。统一打包验证后仅安装目标版本一次，核对安装和 CLI，再等待用户重载；之后才进行新 Host 的现场验收。不能将未重载的旧 Host 数据作为新实现的验证。

不要自行开新聊天、派生子代理或切换模型。用户会把本文交给 Luna；执行中需要交接时保留本表与证据，让下一位可以从真实状态继续。

- 批次 1/6：相同项目、命令和目标的 Hub/Worker 代码上传、Agent 部署、远端结果查看也纳入安全请求替代；目标身份包含 Plan/远端文件或服务器与项目路径，避免不同文件/Worker 的请求互相取消。代码同步的循环边界现在检查替代信号，旧任务未结算或 SimpleSFTP 无法给出传输退出回执时不会启动新任务；停止确认使用一个总时限，多个旧传输不会各自叠加完整等待窗口。
- 批次 5：Panel `buildState()` 不再压缩或写入日志投影缓存；实时状态事件与任务选择变更时更新有界日志投影，项目/拓扑状态切换释放旧投影引用。UI 构建只读取匹配当前项目、状态引用和选择 revision 的缓存，缓存未命中时使用实时客户端已限额日志快照。
- 批次 5：execution section 与 Plan 状态摘要不再以每次替换的完整分布式队列对象引用作为变化依据，改用队列磁盘内容签名、队列代次与有界存储诊断摘要；相同队列快照不再触发历史列表重新计算。
- 批次 5：结果目录加载状态由 interest/后台刷新流程维护，`buildState()` 仅读取当前缓存与状态；后台目录线程完成时预先映射表格摘要，避免每次 Panel full-state 都重新遍历 catalog。
- 批次 5：切换项目时释放旧结果 catalog 与表格视图模型，清空旧项目加载错误；后台 catalog 失败状态按所属项目判断，避免旧项目缓存让新项目显示成 stale。
- 批次 5：结果 trace 投影改为仅在进入 results interest、运行证据变化、Plan 选择/版本变化或 trace 保护选择变化时更新；Panel buildState() 只读取与项目、证据引用、保护键和 Plan revision 匹配的投影缓存，避免每份 full-state 同步排序/裁剪长 trace。
- 批次 2/7：LENIENT 软通过审计由无限增长的同步追加日志改为最多 256 KiB 的有界尾部环；读取拒绝链接、硬链接及并发身份变化，并通过项目文件租约与固定原子写入槽串行提交，原有 action error 继续作为持久错误记录。
- 批次 2/7：通用审计 JSONL 记录改为最多 256 KiB、单条最多 8 KiB 的有界最近记录环；逐条限制目标和文本字段，尾部读取拒绝链接、硬链接与身份变化，再通过固定原子写入槽替换，避免审计量随长期运行增长。
- 批次 1：安全请求替代期间保持旧请求的替代锁直到新请求同步登记，避免旧请求 settle 与多个同时重试之间出现锁短暂释放窗口；停止回执仍未知时只解除替代中状态，保留旧请求记录供后续显式核验。
- 批次 1/4：操作队列的同键 coalescing 改为登记原始 Promise，并对成功与失败分支显式清理，避免 `finally()` 产生无人观察的二级 rejected Promise。
- 批次 1/6：FileTransferClient 自动重试遇到远端上传身份未知时立即停止，不在未取得远端 settle 回执时重复 init/chunk；公开 retry 只允许已结算失败/取消任务；上传完成及幂等完成回执必须携带与源文件匹配的 SHA256 和 completed 状态；扩展停用时对所有未结算上传并行发送 upload-cancel settle 核验，并在有界窗口内等待本地与远端收尾。
- 批次 2/4：跨窗口资源锁的 admission 与资源冲突等待从每 10ms 全量重读/争锁改为 20–250ms 指数退避、轻量 jitter 和 AbortSignal 即时唤醒，降低争用时磁盘扫描/原子写入频率且保留 30 秒冲突边界与 ticket 顺序。
- 批次 4/5B/7：TensorBoard Scalar Dashboard 的 catalog/tag/series 读取带 AbortController；换 case、失去可见性、切至原生 TensorBoard 页或关闭 dashboard 时取消不再需要的读取。Local API 将请求断开/响应关闭转成 generation-local AbortSignal，传播到排队的 RequestBudget、每 Worker Agent fetch 和限额响应读取；取消不再伪装成 Worker 故障或进入重试退避。自动曲线刷新从 500ms 周期检查改为按配置间隔的一次性调度，插件健康轮询在文档隐藏时暂停。

### 7.9 2026-10-05 产物同步目录深度与校验批次回归

用户截图中的 108 个 job 校验失败已在真实只读 API 和遵循 SFTP 目录深度语义的 fixture 中复现。`distributedOutputHashes()` 原来从项目根使用 `recursive=false` 查询嵌套文件，精确 scope 并不会改变非递归扫描的深度，导致实际存在的结果被判定为丢失。修复使用 `recursive=true` 加精确文件 scope，最多 128 路径 / 10 KiB UTF-8 参数，不扫描无关历史。

同一次产物同步按 Worker 合并预校验，同时最多两路读取；传输后重新校验目标，缓存不跨请求保留。108 job / 324 片段的 fixture 实际产生 12 次有界清单查询，含传输后的验证。缺失、SHA256 冲突和 SSH/API 错误分别保存具体原因，仍禁止不可信发布或混用其他 run。

真实 corim 完整 run 的六个 job、18 个必要片段，两个 Worker 均 18/18 与 durable queue 原有哈希一致；此前清空的 Worker 18/18 缺失。三批只读查询分别 748/614/591 ms，未执行实际镜像修复或完整发布，未声称按钮耗时已实测改善。14 个目标文件、166 用例串行通过，build、实际内联脚本和独立 vm.Script 门禁通过。具体 TODO、版本交付和现场边界见 [同步校验回归记录](todo-artifact-sync-verification.md)。

### 7.10 2026-10-05 队列替换 EPERM

后续运行中 0.5.219 记录显示同步在本机 globalStorage 的队列 `.json.writing -> .json` rename 失败。队列保存曾独立实现固定槽并单次 rename，未沿用 StateStore 已有的有界共享冲突重试。本轮统一使用 StateStore，并增加每次发布前的磁盘签名/提交代次核验；延迟期间外部版本或取消状态变化必须拒绝覆盖。失败保留最后可信显示与签名，diagnostics 标 stale；不删除文件、不创建无限暂存文件、不重放传输。

真实公共 writer 注入 EPERM 的回归、跨窗口租约/队列并发、原产物校验、通知/Plan guard、Panel 回归共 17 文件202项通过。已有 Plan guard 拒绝新运行而不取消同步；当前证据不能确定 Windows 文件具体占用者。交付门禁、0.5.220 安装及现场边界继续维护在 [同步校验回归记录](todo-artifact-sync-verification.md)。

### 7.11 2026-10-05 传输与校验开销

新增协商后的 stdin scope（5000 路径 / 1 MiB），旧版保留原边界；范围匹配与 SQLite 缓存仅加载请求范围，稳定文件复用五字段身份对应的 SHA256，变化重读。跨 Plan 仍按 Worker pair 合并有界压缩流，不新增压缩包暂存或强制依赖。通知分离哈希、打包、网络、解包和复核；wire bytes 持续可见且不混入控制输出/校验量。未变化的产物确认不重复原子写队列，磁盘并发保护不变。

当前 MultiModal 的 5400 个真实路径在本地重放中由每 Worker 68 查询批次降至 2；未访问当前远端任务，不宣称实测网络提速。目标回归和交付边界见 [传输优化验收记录](todo-transfer-optimization.md)。
