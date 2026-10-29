# Worker 隧道策略

当前只配置启用的 Worker。后台隐藏 OpenSSH 隧道和手动 Xshell 终端为不同入口；新增服务器可导入 Xshell 会话，后台连接使用保存的服务器配置与系统认证。

- 每台 Worker 动态读取 localForwardHost/localForwardPort 与 remoteAgentHost/remoteAgentPort。
- 各 Worker 的本机端口不能互相冲突；远端端口取各自实际服务配置，不强制所有机器一致。
- Xshell 原登录行为保留；不以改写其登录命令作为后台隧道的默认前提。
- Agent 健康、版本与项目身份按当前端点核实；旧控制节点字段不参与目标生成。
- 已接收队列由各 Worker Scheduler 管理；当前状态依赖主动查询归并，不能用历史流事件覆盖真实终态。
- 文件传输走 SimpleSFTP；不把旧上报周期、旧实时模式和固定端口当作新配置要求。

安装、认证、端口排查与具体操作见 [完整使用说明](simple-experiment-setup.md)。本文件保留原文档入口，不再提供已退役架构的配置步骤。
