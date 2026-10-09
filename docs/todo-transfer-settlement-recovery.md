# 旧传输回执恢复

目标：修复服务器产物同步被旧 `outcomeUnknown` 永久拦截；保留安全重试和完整退出证据。

现场：0.5.222 / SimpleSFTP 0.2.49；两个旧实例留下 SIGTERM 未知回执，当前无活动传输。本地进程消失不能单独证明远端已停止。

- [x] 回归复现：未知回执阻塞；未启动的新请求不能留下不存在的停止检查。
- [x] SimpleSFTP 提供受身份约束的退出核实：本地旧实例/传输进程、两端进程、接收槽锁、两端资源租约；任一证据不足继续阻止。
- [x] 保留原始失败原因；持久化恢复回执成功后才允许新请求；新请求重新校验，不能宣称旧传输成功。
- [x] SimpleExperiment 自动调用核实并重试一次；保留取消、背压、数据世代和投影。
- [x] 串行回归、build、vm.Script、版本和 VSIX 内容门禁。23 个目标文件共 209 个 Node 用例通过；另有 build 内联 Webview 1 用例和独立 vm.Script 通过。Python 只读探针的 10 个子用例通过。初次 Windows fixture 未模拟 Linux isabs，已修正 fixture 并验证，不放宽生产路径检查。
- [x] 两插件各通过 install:latest 安装一次，CLI 及磁盘版本核对为 0.5.223 / 0.2.50；未使用 force。安装后未再调用当前面板/API。已安装的 186 / 18 个 runtime 文件逐项 hash 一致；package.json 除 VS Code 安装附加的 __metadata 外结构一致。
- [x] SimpleSFTP scoped commit / push / fetch 核对完成：db0c090681d36794a84c8fe9bb34c560ab7fe2a8，HEAD=origin/master，工作树干净。
- [x] SimpleExperiment 实现提交 4b64a1b5bfa5aad548267fc5572b72eb49b2964e 已正常 push / fetch，HEAD=origin/master；主项目只余两个原有 dirty .pyc，未纳入提交。收口记录的提交身份以本文件 Git 历史为准。
- [x] 现场验收边界已标明：安装后的 Extension Host 需要用户重载，不能用旧 API 冒充新实现验收。现场 API 后续已拒绝连接，远端退出探针及最终实际同步未完成现场验收。

不删除回执、不删除产物、不终止未知远端进程、不根据时间过期解锁。兼容旧回执的身份由原 requestKey 与当前相同请求重算证明，仅支持受控 serverToServerFpsync 协议。

协议依据：[Linux /proc](https://www.kernel.org/doc/html/v6.9/filesystems/proc.html)、[Python flock](https://docs.python.org/3/library/fcntl.html)。进程目录 owner 不能单独代替真实 UID；nondumpable 同用户进程、hidepid=4、权限不足、清单超限均不能被当成“无进程”。接收槽锁只打开已有文件，不创建、删除或写入远端文件。恢复回执只证明旧 writer 已退出，实际内容仍由新同步重新 SHA256 校验。

交付：SimpleExperiment 0.5.223 / SimpleSFTP 0.2.50。两个 VSIX 的 package/manifest 身份及 187 / 18 个 runtime 文件 SHA256 与源码一致。生产 Windows CIM 探针实际核对两个旧实例 PID，均为 localOwnerExited=true、localTransportCount=0；这不是远端退出证明，不据此修改现场回执。
