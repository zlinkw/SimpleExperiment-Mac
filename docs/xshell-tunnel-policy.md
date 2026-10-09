# Xshell 本地隧道策略

当前主链路是 `Xshell 本地隧道 + Hub/Worker Agent + SimpleSFTP`。

- 插件只访问 `127.0.0.1:<localPort>`，不直接访问远端服务器地址。
- 插件只打开用户已配置好的 Xshell `.xsh` 会话，不在插件内执行远端 shell 命令。
- Hub 默认本地端口是 `18765`，Worker 本地端口从 `18766-18999` 分配。
- 远端 Agent 可以统一监听各自服务器上的 `127.0.0.1:18765`。
- 实时状态使用 Agent WebSocket/SSE/HTTP API，经 Xshell 本地端口转发访问。
- 文件上传下载使用 SimpleSFTP，不用于心跳、GPU 状态、日志流或操作进度。
- 自动轮询和可用性上报最小基础周期是 60 秒，并叠加正向随机抖动。

诊断信息只展示本地端口、Agent 健康、实时流状态、重连状态和脱敏错误。token、密码、私钥完整路径不得出现在 UI、日志或报告中。
