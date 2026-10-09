# Hub / Worker 多隧道架构

本插件不内置远端 SSH 执行器，也不执行 `ssh`、`scp`、`rsync`。所有 Hub 和 Worker 访问都必须由用户已经配置好的 Xshell 本地端口转发提供。插件只访问本机 `127.0.0.1:<localPort>`，通过 HTTP、WebSocket 或 SSE 与 Agent 通信。

历史代码、配置键和部分测试名里仍可能出现旧隧道工具兼容命名。这些名称只表示遗留兼容层，不代表当前主链路。用户可见文案和新增逻辑必须使用 Xshell 隧道表述。

## 角色边界

### Local VS Code

Local 是用户交互入口，只能访问本机隧道端口。

- 打开 Xshell `.xsh` 会话。
- 通过 `127.0.0.1:<hubLocalPort>` 访问 Hub Agent。
- 通过 `127.0.0.1:<workerLocalPort>` 访问 Worker Agent。
- 用户手动停止、删除、重试、归档准备等操作优先直达 Worker Agent。
- 本机开着时，可把所有 Worker 的简化 GPU availability 批量上报给 Hub，作为 `local_aggregator` 状态源。

Local 不做高频 Worker HTTP polling，不绕过 Xshell 直连远端。

### Hub Agent

Hub 是调度和归档索引权威。

- 计划校验、dry-run、计划运行。
- 全局 scheduler state。
- experiment traces。
- 结果解析、质量门禁、统计、paper table 导出。
- 归档终态、tombstone、全局索引。
- Hub 本地 availability cache。
- 接收 Local 批量 availability 上报。
- 接收 Worker uplink 推送的 availability 和 operation terminal。

Hub scheduler 只读取 Hub 本地 availability cache，不循环高频扫描所有 Worker GPU / CPU。

### Worker Agent

Worker 是本机任务和实时状态入口。

- GPU snapshot 或简化 availability。
- Worker 本机任务状态。
- 实时日志尾部。
- 停止任务、删除本机文件、归档准备、重试本机任务。
- Worker 本机文件状态校验。
- 通过长连接向 Local 推送实时事件。
- 通过 Worker -> Hub uplink 向 Hub 推送 availability 与操作终态。

Worker telemetry 可以补充 Hub 状态，但不能覆盖 Hub 已确认的 `completed`、`failed`、`deleted`、`archived` 等终态。

## 端口策略

默认端口：

- Hub 本地端口：`18765`
- Worker 本地端口范围：`18766-18999`
- Hub 远端 Agent 端口：`18765`
- Worker 远端 Agent 端口：`18765`

远端服务可以都绑定各自服务器的 `127.0.0.1:18765`。本机端口必须唯一。端口分配保存到 VS Code globalState 和 Xshell 会话配置。

示例：

```text
127.0.0.1:18765 -> Xshell -> Hub:127.0.0.1:18765
127.0.0.1:18766 -> Xshell -> Worker-1:127.0.0.1:18765
127.0.0.1:18767 -> Xshell -> Worker-2:127.0.0.1:18765
```

## 实时链路

### Local -> Worker

用户点击触发的 Worker 控制操作直接走本机 Worker 隧道端口。

- `POST /api/actions/stop-worker-task`
- `POST /api/actions/delete-worker-artifacts`
- `POST /api/actions/archive-worker-artifacts`

这些操作不是自动轮询，必须受 `workerActionMinIntervalMs` 和 `workerActionMaxConcurrent` 限制。按钮执行中必须禁用，收到终态后恢复。

### Worker -> Local

Worker 通过 WebSocket / SSE 长连接推送：

- GPU snapshot 或简化 availability。
- task status changed。
- live log tail。
- delete progress / completed / failed。
- archive progress / completed / failed。
- stop progress / completed / failed。
- operation terminal。

Local 断线后使用退避和随机抖动重连，不使用固定短周期重试。

### Worker -> Hub

Worker 主动维持到 Hub 的 uplink 长连接或准长连接。

- GPU availability 低频上报。
- 任务状态变化实时推送。
- 删除、停止、归档准备等 operation terminal 实时推送。

GPU availability 的实际推送间隔为：

```text
workerAvailabilityPushSeconds + random(0, jitterSeconds)
```

操作事件不受 GPU availability 低频参数影响，只受 `operationEventMaxDelayMs` 的最大合并延迟影响。

### Local -> Hub

Local 开着时，Local 可作为最高优先级状态汇总源，把 Worker availability 批量推给 Hub。

实际上报间隔为：

```text
localAvailabilityPushSeconds + random(0, jitterSeconds)
```

Local 不逐 GPU 高频请求 Hub，也不对 Worker 做高频短连接探测。

## Availability Cache

Hub 本地 availability cache 保存每台 Worker 的简化状态：

- `workerId`
- `available`
- `availableGpuIds`
- `busyGpuIds`
- `reason`
- `source`
- `updatedAt`
- `ttlSeconds`
- `capacityLimit`

状态源优先级：

1. `local_aggregator`
2. `worker_uplink`
3. `hub_cached_snapshot`

`workerStatusTtlSeconds` 只表示缓存有效期。若 `now - updatedAt > workerStatusTtlSeconds`，scheduler 不再信任该 Worker 当前可用。TTL 不是轮询间隔。

## 调度节奏

`pollSeconds` 是 Hub scheduler 尝试消费 queued 队列的基础间隔。实际间隔为：

```text
pollSeconds + random(0, jitterSeconds)
```

默认 `pollSeconds=60`、`jitterSeconds=30`，即实际调度尝试间隔为 60 到 90 秒。Plan 可以包含超过 Worker 并发上限的实验数；`maxConcurrentGpus` 只限制同一 Worker 同时占用 GPU 数，不限制排队总量。

## 文件传输边界

`SimpleSFTP` 只负责低频真实文件传输：

- Local -> Hub 首次上传和代码同步。
- Local -> Worker 首次上传和分发代码。
- Hub / Worker -> Local 下载结果、日志包、manifest。
- Worker -> Hub 结果归档相关文件传输。

SFTP 不负责：

- GPU 状态。
- 实时日志流。
- 心跳。
- 操作进度。
- 删除状态。
- 任务状态流。

Agent 实时通道也不传大文件。权重、checkpoint、datasets、work_dirs 等大产物默认不从 Worker 拉到 Local。

## 权威合并规则

- GPU：优先使用新鲜 Worker telemetry，回退到 Hub GPU。
- Worker health：只来自 Worker telemetry。
- Worker task telemetry：只做补充信息。
- Scheduler：Hub 权威。
- Experiment traces：Hub 权威，Worker 只补充实时状态。
- 归档索引和最终归档状态：Hub 权威。
- 删除本机文件执行结果：Worker 权威，Hub 收到终态后更新 tombstone / index。

Worker telemetry 不能覆盖 Hub 的终态记录。

## 风控要求

禁止：

- 固定短周期 polling。
- Hub 循环高频扫描所有 Worker GPU / CPU。
- Local、Hub、Worker 三端同时对同一状态源高频探测。
- SFTP 承载实时状态、日志、心跳或操作事件。
- 插件内新增直接远端 SSH、SCP、RSYNC 回退路径。

要求：

- 自动刷新、自动上报、availability 推送最小基础周期为 60 秒。
- 实际自动节奏使用 `base + random(0, jitterSeconds)` 正向抖动。
- 断线重连使用退避和抖动。
- 所有敏感 token、密码、私钥完整路径、敏感命令参数在 UI、日志、诊断中脱敏。

## 手动验收重点

1. 插件只访问 `127.0.0.1:<localPort>`。
2. Xshell `.xsh` 会话能启动 Hub / Worker 隧道。
3. Hub 和 Worker 本地端口唯一，无冲突。
4. Worker GPU 状态可通过 Worker Agent 实时通道更新。
5. 停止、删除、归档准备优先 Local -> Worker，Hub 只接收终态并更新索引。
6. SFTP 只在上传/下载真实文件时触发。
7. 调度和 availability 上报不低于 60 秒基础间隔，并带随机抖动。
