# 旧传输退出检查与常驻 SFTP 会话

目标：修正服务器最新产物同步被无法归属的常驻 sftp-server 会话阻止；保留真实旧传输、同目录写入和未知证据保护，不清理文件或终止进程。

- [x] 读取约束、Git 状态、两插件当前 discovery/capabilities；主插件运行/安装 0.5.224，SimpleSFTP 0.2.51，主工作区仅原有两个 dirty .pyc，SimpleSFTP 干净。
- [x] 现场只读 transfers.list：无活动 transfer，两个旧 SIGTERM outcomeUnknown 回执仍在；截图明确阻挡进程为 destination 的 sftp-server，state=S、scope=unscoped。现探针对同用户任一 sftp-server 无条件认定为旧传输，未检查目标文件。截图不能证明 PID 1494219 的具体打开文件或其会话来源。
- [x] 在实际生产 Python 探针建立常驻 SFTP、目标写句柄、其他项目、权限不足、进程/FD 变化等回归并先复现：新增四个场景在旧代码失败，消息同截图（sftp-server/unscoped）；修正后探针 32 个 Python 场景与真实回执链 16 个 Node 用例通过。Windows fixture 显式提供 Linux O_ACCMODE，不修改生产常量来迁就测试。
- [x] 仅针对内核可核实的普通 SFTP 服务进程作有界 FD/flags/身份检查：每会话最多 1024 FD、一次 census 合计 4096 FD；验证 exe、重复 FD link/flags/inode/mount identity、前后 FD 清单与最终 PID/start-time/state。无目标写句柄的稳定睡眠会话不能充当旧 tar/staged 协议 writer；目标写句柄（含已删除但仍打开的文件）报告 target-root，不确定证据、可疑硬链接、D/T/R 状态继续阻止。其余进程/双端槽锁和回执门禁不放宽。
- [x] 串行相关测试：SimpleSFTP 8 文件 60 个 Node 用例（transferRecovery 16、transferSettlement 3、stagedTarReceive 2、transferMetadata 4、transferCapacity 3、apiBackpressure 4、hostOperationLease 9、api 19）；SimpleExperiment 4 文件 62 个（safeRequestRetry 13、planArtifactSync 12、pendingResultMetricSync 31、sftpProgressWait 6）。另有 build 内 Webview 1 个，合计 123 个独立 Node 用例；探针 32 个 Python 场景包含在 transferRecovery 内串行执行。两插件 build、vm.Script、git diff --check 通过。首次 SimpleSFTP build 的 vsce ls 8 秒超时，后续完整 npm run package 门禁通过，未放宽超时。
- [x] 仅修改的 SimpleSFTP 递增到 0.2.52，npm run package 通过；VSIX package/manifest 版本和 18 项 runtime SHA256 全部与源码一致，无 test/pyc 或遗留 .writing；SHA256=165a80dda7fc1b8d5afdc3d804593d1658f549f8cadeabab27f48b7b60eb9157。主插件保持 0.5.224。
- [x] SimpleSFTP scoped commit 76184a56b2949e0a4d24972df01de259ca78229d 已正常 push/fetch，HEAD=origin/master、工作树干净。通过 install:latest 自动安装 0.2.52 一次，无 force；18 个已安装 runtime SHA256 与源码一致，CLI/磁盘版本已核对。主插件仍为 0.5.224。安装后停止 API/面板操作。
- [x] 最终明确无需根据此报错清理旧文件或终止未知会话：没有具体文件占用证据；代码已经修正可复现的范围假阳性。人工重载后再试实际 drf 三项同步，PID 1494219 的现场句柄和真实新版本远端同步仍未验证，不宣称已同步完成。

原始信息保留：旧回执、产物、活动租约全部不删除。标准 SFTP 服务处理独立会话请求；进程存在或 S 状态本身不能证明旧产物传输正在占用文件。新检查证明协议 writer 和当前目标写句柄，而非声称外部会话永久不能再发起写入；外部工具未来操作仍应避免与同步同时写同一文件。

依据：[OpenSSH sftp-server](https://man.openbsd.org/sftp-server.8)、[Linux /proc fd/fdinfo](https://www.kernel.org/doc/html/latest/filesystems/proc.html)。不通过直接 SSH 绕过项目 API；现 API 不提供通用进程 FD 查看，具体 PID 的现场句柄和重载后的实际 drf 同步留待可用 API/人工验收。

交付保护：未修改 MultiModal 数据、活动任务、历史回执或租约；主项目最终只保留原有两个 dirty .pyc。文档提交身份以本文件 Git 历史为准。
