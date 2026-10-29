# 当前 Worker 传输边界

状态、GPU 和任务查询经各 Worker 配置的本机转发端点访问 Agent；队列、窗口与最终产物以主动查询归并，不以推送或启动接收回执确认完成。

后台受管 OpenSSH 隧道与手动打开的 Xshell 会话分开。系统 SSH 使用用户配置的密钥、ssh-agent、别名及端口，不读取 Xshell 加密密码；不能假设某个固定本机或远端 Agent 端口。

实际上传、下载、部署及服务器文件操作通过 SimpleSFTP API，保留确认、退出核实与路径保护。插件 API 不可用时不绕过它临时执行 SSH、scp 或 rsync。

只读结果查询可对短暂网络错误有限退避重试；修改操作结果未知时不自动重放。低流量模式减少重复读取，不等于服务器停止调度或绝对零通信。

完整步骤见 [配置与使用说明](simple-experiment-setup.md)，字段见 [配置参考](configuration-reference.md)。历史 ControlMaster、persistent shell、控制节点 stream 优先级等描述不作为当前配置方式。
