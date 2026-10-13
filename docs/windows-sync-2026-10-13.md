# Windows 新增功能参考同步

本轮冻结 SimpleExperiment Windows `42902a5a → 7bb96599` 的9次提交、SimpleSFTP `acae730 → ed75a5d` 的2次提交。已通过[preview-v0.5.314](https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.314)交付 Experiment 0.5.314 / SFTP 0.2.101；Exp源码`cfc46572020a437096e9aa4ffb8d87d64e69e879`、SF源码`3c58e082adeaafcce923a8f5a4d74ea39d770390`，索引`c6709ea95d3f311f519c34d4060e629026cfe1e9`。

| 参考提交 | Mac采用的思路 | 本地验证 |
| --- | --- | --- |
| `2ae1ecc4` | 正式身份通过独立任务shell传递，清掉继承的其他job环境及Agent token；固定GPU容器内标签继续保留 | Mac隔离身份2，专属tmux并发身份2 |
| `03e9790b` | 停止原job的精确Pane，保留失败文件和共享GPU容器 | 专属tmux精确停止3，Mac GPU标签5 |
| `416fa21f` | 正式控制绑定globalJobId/command/revision/CSV，移除对attempt版本的依赖；历史attempt只读 | 正式队列29、人工拒绝恢复5、停止清理34 |
| `f84e7fde` | 遥测区分能力标记与可调用动作，旧Worker能力不足时先拒绝控制 | Worker遥测8；Mac不采用Windows自动部署 |
| `24cc5a61` | 全部正式job成功后冻结整个run，经SimpleSFTP镜像到启用Worker；持久回执合并并补离线缺项 | 完成镜像11、手动结果边界6、镜像状态8 |
| `8dc2f67c` | 预检按真实资产进度计时，重复阶段心跳不能续命；失败回执持久化，明确人工重排 | 进度2、失败/取消2、预检API7、持久拒绝6 |
| `21f294f1` | 预检和执行使用相同配置环境/真实shell，缺环境先拒绝；仅诊断不会训练 | stdlib环境1、真实Git Bash3 |
| `1802054c` | 失败job遗留先打开冻结身份的只读审核，输出/独立CSV经owner核验；完成清理后仍需用户重新确认重排 | 单job审核4、清理27、审核桥13、重连9 |
| `7bb96599` | Windows更新服务源自Mac；仅补可借鉴的排空续租、取消等待、未知安装回执与冻结批次恢复保护 | Mac更新事务11、门禁3、Bootstrap7；Mac更新源/身份/平台保持独立 |
| SF `39cfaf7` | 正式目录/CSV绑定完整终态owner及SHA，归档batch写入冻结预览摘要，外部CSV先于owner目录处理 | 正式owner4、受限清理18 |
| SF `ed75a5d` | 更新阻止新传输，已有传输仍能续租和验主；取消更新等待不取消原传输 | 跨插件排空2、SFTP Bootstrap4、Mac共享租约3 |

## 操作变化

1. 两插件配套更新并重载。以后更新通知的进度可取消：取消的是更新等待，已运行的传输继续；安装回执不明确时仍需重载核对。已有未完成批次优先显示原版本，不能切换另一清单，重载后由用户点击“安装 preview 配套更新”补装，启动不会自动安装。
2. 新等待协议要求 SimpleSFTP Mac **0.2.101或以上**。首次从旧版过渡请等待本地传输完成，先安装配套SFTP，再安装Experiment并重载；如仍被旧更新锁阻断，直接从同一Release依次安装两份VSIX，无需删锁。
3. 新runtime须任务空闲后通过“准备项目与 Agent”主动确认上传，再在Termius手动处理并检测。旧Worker缺正式身份/无attempt停止/环境预检能力会明确拒绝，不为升级中断现有作业。
4. 正式失败卡片“重新排队此 job”先核对原command、停止状态及占用输出；有遗留时选择“审核遗留文件”。审核范围只含该job当前正式目录和独立CSV，保持PLAN、源配置、成功同伴与共享引用。不会点击一次就移走或重跑；全部节点完成后仍需返回原卡片明确重排。
5. 整个正式Plan成功后，权重/日志/配置/声明CSV自动在启用Worker间受限镜像。原run的revision、代码指纹、globalJobId、command、来源和路径保持冻结，磁盘PLAN后来变化不改身份。目标冲突、活动writer、清理hold、无owner或离线不会当成成功；只补未完成项。解析、汇总、归档与论文表发布仍需用户手动触发，原始结果不会因此下载到本机。

启动诊断API为 `tasks.preflight`、`tasks.preflight.status`、`tasks.preflight.cancel`。每次调用前读取Mac当前discovery及live capabilities，参数来自实际版本；使用原workerId/commandId，`environmentOnly: true`仅检查原配置shell。该操作只诊断已失败/被拒绝的原job，不修改队列，不训练，取消只取消诊断。

## Mac边界与验证记录

Mac身份、静态preview索引、全部包验证后安装、darwin-arm64、Termius手动端点、独立认证、本机中转、POSIX真实拼写、退出证明与共享租约均保留。Windows Xshell、独立稳定更新源、自动安装/自动部署及真实服务器验收记录没有复制到Mac。

Mac仍缺可靠打开文件句柄证明，实际清理返回 `HANDLE_CHECK_UNAVAILABLE` 并阻断。审核页能显示精确路径和保护原因；永久删除仍须两次完整路径确认、物理直接父目录与最短子项检查。已运行任务、旧会话与用户文件不自动迁移、停止或删除。

验证全部在本机：真实编译消费者、隔离Python函数、专属新建WSL tmux服务器、Git Bash/std库环境探针及API/传输替身。没有连接生产服务器、部署Agent、执行科研或真实传输/清理、开发机安装及Actions。曾保留一份10秒终止的旧临时GPU夹具，随后以固定入口AST隔离验证替代；闭包枚举8秒失败也保留，最终发布须重新通过更高版本的完整门禁，不能把失败记录写成通过。

原29条目标维持 **18已验证、11剩余**，整体paused。本轮新增行为尚待M5，旧`.309/.97`报告不能作为新版正式执行、镜像、审核或安装恢复的真机证明。

## 本轮发布验证

146个目标文件（含build面板标记147），234/28运行模块闭包与面板vm、实际两份VSIX消费者232项、1609/89源码快照、匿名四请求/REST0及大小/SHA/CRC/身份/平台核验通过。完整prepare最终exit0；旧GPU身份依赖及两处正式召回UI夹具已修正，早期失败日志保留。外部科研工作树的原Plan已不存在，发布改用实际Scheduler/生成adapter/collector的专属隔离集成夹具；原MULTIMODAL_PATH_CONTRACT_ROOT验收入口保留，须显式指定，未验证该项目专属hook。没有把这一变化当作科研或M5验收。

Release 411312487于2026-10-13T05:27:24Z公开，三附件上传后逐项核验再发布，静态索引普通同步/fetch。实际公开客户端不用REST、无需登录，缓存及同版/高版/已更新SFTP跳过通过。没有安装开发机扩展或操作生产服务器；完整目标保持paused，原29条18已验证11剩余。
