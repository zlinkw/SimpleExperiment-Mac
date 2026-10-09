# experiment health JSON

`simpleex experiment health --json` 和 `simpleex experiment overview --json` 的健康字段，与 `experiment inspect` 的 `health` 同构。字段名是 `health`，不是 `overall`。

```json
{
  "health": { "status": "healthy", "reason": "" }
}
```

| 字段 | 含义 |
| --- | --- |
| status | `healthy`、`warning` 或 `error` |
| reason | `failed_recent`、`stalled`、`missing_progress`，没有则为空字符串 |

`missing_progress` 表示训练型 running `worker_run` 自 `started_at` 或 `created` 起超过 10 分钟，从未产生可信 progress；适用 stage 为 `run`、`train`、`train_test`。`test`、`debug` 和未知 stage 不因缺少训练 progress 告警。RuntimeObservation 的 `updated_at` 仅是查询观测时间，不会重置宽限期。

`stalled` 是 warning，表示 running 对象超过 30 分钟没有可观察任务输出。对于 live Worker task，CLI 使用 Worker task 日志的最后修改时间，不用本次查询刷新的 `updated_at`；旧 Worker 未提供该时间时回退到已有的 `row.updated`。它表示没有可观察输出，不证明 GPU 计算已经卡死。

`failed_recent` 加 `error` 表示最近失败尚未恢复；加 `warning` 表示同一 plan、experiment_case、seed 已有更新的运行中重试。最新重试成功后，失败不再影响当前健康状态，也不再进入 `overview.alerts.failed_recent`。过去 24 小时的失败历史仍可从 `overview.summary.recent_failures` 或 `experiment summary` 查询。

全局 `health` 和 `overview` 对已有子 `worker_run`、且 `status_source=aggregate` 的失败 `workflow` 去重；实际失败由子 `worker_run` 计入。没有子 `worker_run` 的独立 Scheduler/workflow 失败仍计入 `failed_recent`。单独 `inspect` 失败 `workflow` 仍显示该对象的 `error / failed_recent`。

`experiment health` 的 `health` 额外带 `alert_level`：`healthy` 映射为 `ok`，`warning` 和 `error` 保持原值。`overview` 和 `inspect` 的 `health` 没有该字段。`experiment health` 只返回 `health` 和 `alerts`，不返回运行列表。
