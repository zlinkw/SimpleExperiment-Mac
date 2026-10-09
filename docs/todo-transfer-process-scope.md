# 旧传输退出检查范围修正

目标：处理 0.5.223 / SimpleSFTP 0.2.50 剩余 `REMOTE_TRANSFER_STILL_ACTIVE`，保留真实写入保护，不删除回执、产物或终止未知进程。

- [x] 读取约束、Git 状态和现场 API；主项目仅两个原有 dirty .pyc，SimpleSFTP 干净。
- [x] 现场只读确认：当前无活动 transfer，仍有两个旧 SIGTERM 未知回执。现版本探针只返回通用原因，没有 PID，无法证明截图具体由哪个远端进程触发。
- [x] 在生产探针边界复现僵尸、纯隧道、其他项目接收器和标记文本误判；初始五个新场景失败，修正后通过；保留活跃/不明 writer、忙锁、权限不足保护。
- [x] 精确识别协议接收器和目标：仅同 packaged code SHA256 的接收器可依据 manifest 排除其他根；shell/SSH wrapper、未知程序和修改版代码仍保守阻止。确认 Z/X 已退出状态；单独排除明确 `ssh -N` 且无复用或远端命令的隧道。PID/start-time 改变不能成为退出证据。返回有界 PID/name/state/scope/端点诊断，不返回原始 argv/凭证。
- [x] 串行回归：SimpleSFTP 8 文件 52 Node 用例，SimpleExperiment 3 文件 45 Node 用例，独立 Python 探针 23 用例通过；主 build 的 Webview 1 用例和独立 vm.Script 通过。两项目 build 通过。SimpleSFTP 0.2.51 VSIX 的 18 个 runtime 文件 SHA256、package 和 manifest 版本均与源码一致，不含 test/pyc。
- [x] 完成 SimpleSFTP scoped commit / push / fetch：`5a004d99e8a16f900acfe8b8fb69431fd3662928`，HEAD=origin/master，工作树干净。通过 install:latest 自动安装 SimpleSFTP 0.2.51 一次，无 force；CLI/磁盘版本及 18 个已安装 runtime 文件 SHA256 与源码一致。SimpleExperiment 仍 0.5.223。安装后停止 API/面板操作。此记录的主项目提交身份以文件 Git 历史为准。
- [x] 区分代码 fixture 验证与重载后的实际同步验收：本轮代码/测试通过；截图具体阻挡 PID 和重载后 drf 三项实际同步尚未验证。旧版本无 PID 诊断，不能虚报已经同步成功。SimpleExperiment 源码及已安装版本仍为 0.5.223；只发布修改的 SimpleSFTP 0.2.51，不制造无必要的主插件混合版本。

依据：[Linux /proc 文档](https://www.kernel.org/doc/html/latest/filesystems/proc.html)、[proc_pid_stat](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)。进程名、命令文本或无锁不能单独证明目标仍有 writer；不能以时间过期解除未知回执。

范围限制：真实远端仍有未退出的 writer 时继续阻止重传；不能把本轮确认的兼容性缺陷直接等价为截图具体远端 PID 的成因。新诊断将区分 source/destination、进程状态和确定的目标根/无法确定的目标。多窗口租约、双端探针、槽锁和落盘回执全部保留。

VSIX SHA256：`ffc0aa274405070428cca836d2b7cdfc4f2cd69609f33926f341c8bece0e993e`。没有删除或过期清理未知回执，没有改变传输并发、压缩或当前结果世代的规则。
