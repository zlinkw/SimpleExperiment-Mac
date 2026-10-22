# Windows 权威源码对齐

> 当前已在2026-10-16同步Windows 0.5.341；最新基线、34份源码差异和验证状态见[077记录](windows-alignment-2026-10-16.md)。下文为075/076历史记录，不代表更新后的源码已运行验证。

本轮按用户2026-10-15新要求实施。Windows业务实现为唯一权威；旧Mac业务差异不作为规则来源。仅本地修改源码与静态审查，不构建、测试、连接生产服务器、训练、删除真实产物、部署、安装、发布或推送未经构建验证的批次。旧版本发布和真机记录仅是历史证据。

## 实际参考基线

- SimpleExperiment Windows `0.5.327`，业务提交 `ea7137d388fc4990016319a1b0be10cef659e055`；远端master `fc6387feb679042c4d7faf1eb8ddca7f183104e2`仅追加交付文档，src/package无新增变化。
- SimpleSFTP Windows `0.2.90`，`23beafc52e4e310001e74a5730f0eae541bbc1bc`，与远端master一致。
- 初始核对为用户指定的0.5.326/0.2.89；实施期间检测到上述后续稳定提交，已将其Agent部署顺序与服务端Scheduler证据修复一并同步，采用更新基线。
- 已只读fetch核实两仓。Windows工作树现有缓存、辅助脚本及交付附件不作为源码输入，不修改Windows工作区。

## 功能对照表（已实施源码修改，运行待验证）

以下位置相对各自仓库根；同路径表示采用Windows同一份实现，平台例外单独登记。

| 范围 | Windows权威实现 | Mac对应位置 | 初始差异及处理 |
| --- | --- | --- | --- |
| Worker与目标 | features/TopologyMode、tunnel/TunnelEndpointRegistry、extension/legacy | src同路径、mac/ManualTunnel | 淘汰活动Hub分支，仅明确启用Worker；保留旧配置但不补目标 |
| PLAN准备与提交 | extension/PlanRunHost、features/WorkerPreparation、StaticEntrypointProbe、CodeSyncProofWaiter | src同路径 | 直接复用检查次序、独立Worker准备与复用/取消；不复用旧Mac额外科研检查 |
| 覆盖确认 | extension/RunConfirmation、features/PlanRunReplacement、PlanOutputReplacement | src同路径 | 复用完整预检、两次精确路径确认；不执行真实清理 |
| 生命周期 | features/TaskLifecycle、WorkerTaskQuery、PulledTaskControl | src同路径 | 主动查询，原commandId及本机意图，不以推送回执推进 |
| 独立队列/tmux证据 | clusterAgentRuntime、clusterSchedulerRuntime、runtime/TmuxTaskLifecycle、TaskShellEnvironment | src同路径 | 权威运行协议整体复用，移除旧Mac attempt/旧调度分支差异 |
| 自动/手动调度与显存 | features/GpuMemoryScheduling、ManualJobDispatch、extension/ManualDispatchHost | src同路径及package配置 | 规则、默认值、优先级一致 |
| 精确停止/清空/保留会话 | extension/GpuTmuxClose、features/PlanStopClear、tunnel/AgentTmuxPolicy | src同路径 | 按真实绑定，旧快照/版本不成为已绑定窗口的停止门禁 |
| Agent与Scheduler更新 | runtime/AgentLifecycle、SimpleSFTP agent-lifecycle | src同路径/配套同名文件 | 同时更新并重启独立Scheduler，保留任务；只实现源代码，不执行部署 |
| 最新产物与逐job同步 | features/LatestJobArtifacts、DistributedJobArtifacts、extension/CompletedJobSyncHost | src同路径 | 最新正式产物，当前勾选范围交集，默认work_dirs兼容work_dir |
| 文件树/实际删除进度 | features/SyncScopeTree、SyncScopeDelete、core/SimpleSftpProgressWait、SimpleSFTP cleanup/transfer-file-progress | 同路径 | 本轮文件系统查询为准，失败结束等待并允许重查 |
| 清理及安全边界 | features/ManifestCleanup、PlanCleanup、SimpleSFTP cleanup-files | 同路径 | 复用安全根、类型、链接、直接父目录、最短子项及确认，不另建Mac清理状态机 |
| tmux面板与错误摘要 | ui/PanelHtml、ui/RunConfirmation、ui/sections | src同路径 | Windows布局/层级/含义原样复用，只做平台入口文字与Command键映射 |
| 配置/命令/API/CLI | package、api/LocalApiServer、cli、features/ApiWorkflow | 同路径 | 补齐新增入口和接口，仅调整扩展身份/发现目录/系统启动参数 |
| SFTP认证/传输 | extension、api-server、transfer-settlement、tar-writer、progress-inactivity | 配套同路径 | Windows业务为主，凭据/本机POSIX/SSH启动集中到Mac平台适配 |
| 更新/平台集成 | updates、features/ExtensionUpdates、tunnel/Xshell入口 | 对应共享实现及平台适配 | Mac独立包身份/公开下载地址、应用目录/终端/CLI为平台差异；不复制Windows安装目标 |

## 实际修改

- 以冻结提交中的325份Experiment生产TS、20份SFTP生产JS/Python及两仓package/lock为输入，共349份基线文件逐项对齐。076句柄接缝加入后，321份仅有扩展身份/设置命名空间映射，28份存在明确登记的平台覆盖。该数字是源码对照范围，不是功能验证通过数。
- 新增Windows当前活动链的WorkerPreparation、CodeSyncProofWaiter、StaticEntrypointProbe、PlanRunHost、RunConfirmation、TaskLifecycle、PulledTaskControl、WorkerTaskQuery、GpuMemoryScheduling、AgentLifecycle、TmuxTaskLifecycle、LatestJobArtifacts、CompletedJobSyncHost、ManifestCleanup等模块；调用方同时直接复用Windows版本。旧Mac的API/workflow、PlanBuilder、结果归档、调度和清理分支不再作为活动业务权威。
- SFTP补入agent-lifecycle.js/.py和transfer-file-progress.js；api-server、cleanup-file-api、cleanup-files采用同源实现。新生命周期与进度查询的SSH启动接入已有Mac认证器，保留独立密码/私钥口令和SecretStorage；不绕开现有认证。
- 追加同步0.5.327/0.2.90的共同修复：部署复用Agent时，从SSH部署通道返回的服务器本地健康结果核对独立Scheduler，不在隧道尚未启动时请求本机转发；API能力显式声明schedulerRuntimeEvidence及localTunnelRequired=false。
- 共同命令、配置默认值、面板布局、按钮含义、API及运行协议按Windows同步。Mac旧命令继续作为兼容入口；只将Xshell输入换为显式端点和Termius指引。服务器表单补充原先由Windows会话文件提供的SSH端口、两端主机，前后端使用同一原生端点就绪适配器。
- 更新事务和门禁改为Windows共同实现，旧src/mac/UpdateTransaction、UpdateGate仅兼容转出；MacReleaseClient只适配preview元数据/资产分发，旧安装回执保留并转换读取。旧记录无法确认时阻断并报错，不另建安装恢复状态机。
- README、配置说明、SFTP说明和项目事实在本轮集中校正：Worker-only、共同Agent/Scheduler流程、最新job产物交集及更新按钮实际入口；删除旧说明中的活动Hub、手动替代Agent生命周期及attempt产物约定。

## 明确保留的平台差异

| 位置 | 原因与边界 |
| --- | --- |
| src/platform/HostPaths、Filesystem；两仓原生path叶子 | Application Support、POSIX、file URI和大小写；共同业务判断不变。Mac身份不导入Windows/ZLK账户资产。 |
| src/platform/Terminal、MacHostAdapter；PanelHtml原生输入接缝 | Mac没有Xshell/.xsh；用户在Termius启动转发。只替换终端/会话文件能力，保存原服务器字段，不伪造启动成功。 |
| src/platform/MacReleaseClient、UpdateDistribution；src/mac/Bootstrap/Vsix | 保留公开preview静态索引、同一Release双包、独立Mac身份及原生入口；事务、校验、恢复由共同模块负责。原打包工具仍可读取完整包目录，ZIP完整性引擎只有共同一份。 |
| SFTP mac-auth/askpass、agent-lifecycle启动注入、extension传输启动 | Mac OpenSSH/ssh-agent/SecretStorage和POSIX流式中转、原生SSH子进程退出证明；生命周期载荷、重试/结算和错误分类仍来自Windows，不增加Mac认证重试类别。 |
| HostOperationLease/ResourceOperationLease、mac-update-gate | 两插件同一Mac目录与原生路径身份，兼容旧mac-preview-update租约；新事务使用共同paired-plugin-update协议。 |
| CacheCleanupPanel → mac/CacheDelete | 只替换本机删除执行器，保留Windows扫描、精确路径审核、两次确认与删除后实查；本轮未执行删除。 |
| SFTP mac_cleanup_handles.py、src/platform/CleanupHandles、mac/CacheDelete | 076补入Darwin libproc只读句柄适配及本机缓存接线。占用返回ACTIVE_HANDLE；无法完整观察时返回HANDLE_CHECK_UNAVAILABLE。源码已实现，ABI/权限/行为仍未运行验证。 |
| RuntimeManifest、package版本及Mac CLI | 仍保留历史0.5.314/0.2.101，尚未构建交付；未来版本递增、CLI安装/权限和系统集成另行验证。 |

Termius私有会话编辑不受支持的旧入口明确报`TERMINAL_SESSION_EDIT_UNAVAILABLE`，并指向共同“准备Agent并启动”；不静默跳过。旧Hub记录保留，但不恢复为Mac目标或功能。未执行自动清理、历史目录迁移、真实产物修改或远端任务操作。

## 静态审查记录

- 357份TS仅做AST语法解析与相对依赖路径存在性检查；没有运行TypeScript类型检查、transpile或生成dist。
- SFTP打包清单中的23份JS仅用VM编译包装语法解析，6份Python仅ast.parse；未加载应用模块，未启动原生句柄查询、Python运行时Agent或Scheduler。
- 两仓git diff --check及UTF-8说明文件复读属于文本审查。349份权威文件及额外原生适配文件的指纹见[scripts/windows-source-baseline.json](../scripts/windows-source-baseline.json)。
- [scripts/check-windows-alignment.js](../scripts/check-windows-alignment.js)仅核对源文件指纹，可选从指定Windows本地仓库git show核对冻结提交；不构建、测试、联网或执行扩展。
- 当前源码与旧dist/VSIX不是一批，不复用旧版构建或真机验证结果。

## 剩余7类待验证

| 类别 | 后续验证内容 |
| --- | --- |
| 1. 构建与类型 | 两仓类型/运行时构建，runtime版本统一、生成Python与面板脚本语法；本轮全部未执行。 |
| 2. 自动化回归 | Windows共同链的最小目标测试、Mac适配边界；逐文件串行，沿用20秒及Python隔离10秒约束。现有旧Mac测试需按新权威链复核，不能据旧断言改回旧业务。 |
| 3. 包与安装 | 新模块依赖闭包、VSIX真实身份/平台/版本/大小/SHA，原生CLI及权限，实际安装/重载。 |
| 4. 更新过渡 | 下次构建两仓递增版本，SFTP至少0.2.102。先等旧版传输完成并先装配套SFTP的过渡、旧事务/未知回执、取消等待、限流、并发点击、部分安装/补装；不能用当前0.2.101源码版本号直接发包。 |
| 5. Mac系统与UI | M5终端/转发、Command快捷键、配置保留、深浅主题、中文/空格/大小写、凭据和CLI；生成面板实际运行未验。 |
| 6. 传输与清理 | 密钥/密码/口令/agent、单端及双端流式传输、进度查询失败/重连、原生进程退出证明；076句柄源码已补齐，Darwin ABI、权限、占用/释放、目录/线程/映射、枚举变化、超时及真实清理均未执行验证。 |
| 7. Worker业务 | 隔离验收环境中的单/多Worker、PLAN预检与并行准备、原commandId查询、独立队列/Agent+Scheduler更新、显存调度、GPU任务标签页、精确停止、最新产物交集及实查文件树。不得据源码对照宣称服务器行为已通过。 |

## 后续同步方式与Git状态

Windows先实现并稳定提交，Mac按提交读取对应完整模块，先更新共同业务，再以明确平台适配器覆盖必要叶子；不得从旧Mac逻辑重推规则，也不反向改写Windows。平台覆盖必须在指纹清单记录原因；更新基线时一并刷新文件SHA及本说明。保留兼容入口，已退役分支按Windows活动调用链处理。

本轮源码修改已落到两个Mac工作区，未提交/推送。构建是现有提交门禁，而用户明确禁止本轮构建，因此不能将静态审查冒充成功验证后提交。没有安装、部署或发布。原目标模式仍paused；旧29条18/11为历史计数，本轮源码实施无预定待执行子批次，上表7类验证均保留待执行。

## 076 原生句柄适配源码交付

实现依据[Apple XNU公开ABI声明](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h)及[libproc接口](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.h)。只读查询同用户进程的cwd/root、线程cwd、vnode FD/fileport和文件映射；匹配冻结清单的设备号/inode，不依赖被截断的路径显示或名称前缀。库入口、结构大小及当前进程/cwd身份校准在运行时验证。

进程出生时间在查询前后核对，退出仅接受原生ESRCH证据；缺权限、短结构/截断列表、不支持的ABI/类型、PID复用或新增进程、容量及时间预算耗尽都阻断，不当作无人占用。内部查询预算6秒，缓存入口Python子进程上限8秒；超时只结束本次探针子进程，不向被扫描进程发送信号。适配器不调用任何删除函数；它提供本轮观察，不能保证观察后没有其他程序打开目标。

SFTP仅增加Darwin分派，Windows/Linux和共同confirmed_paths/managed_tmux授权边界不变；本机缓存通过配套SFTP包内同一只读模块取得证据后，仍执行原来的路径、父目录、身份/内容复核及最短子项删除。旧配套包没有模块时明确阻断，未来配套打包必须包含mac_cleanup_handles.py。此次没有运行适配器、权限探测或清理操作，没有添加另一套清理状态机。

本轮列明的无需真机源码缺口已处理；剩余上表7类验证。源码审查不证明M5能力可用：尤其受保护同UID进程可能限制libproc可见性，遇到该情况保持失败，不能宣称清理已经通过。
