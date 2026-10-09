# experiment inspect JSON

`simpleex experiment inspect <id> --json` 的默认输出，`schema_version` 为 `"1"`。字段变化必须提升版本号。每个字段只承担一个职责。

```json
{
  "schema_version": "1",
  "snapshot": {},
  "summary": {},
  "status": {},
  "progress": {},
  "health": {},
  "diagnosis": {},
  "alerts": {}
}
```

## snapshot

本次查询的版本信息，不描述实验本身。

| 字段 | 含义 |
| --- | --- |
| snapshot_id | 本次查询编号，只在这一次调用内有效 |
| snapshot_time | 本次查询的时刻，ISO 字符串 |
| runtime_version | 实验状态版本，等于 `status.updated_at` |
| runtime_source | 状态数据的主要来源：`experiment_index`、`history` 或 `runtime_observation` |

`history` 包括 Worker task 历史、Scheduler operation 生命周期记录和现有历史产物；`runtime_observation` 表示当前运行时观测参与了结果；`experiment_index` 表示当前对象仅由本地 experiment index 提供。

## summary

实验身份。

| 字段 | 含义 |
| --- | --- |
| id | 实验 id |
| type | `workflow` 或 `worker_run` |
| status | 运行状态 |
| health_status | 行级健康标记 |
| experiment_case | 实验用例名 |
| seed | 随机种子 |

## status

当前状态。不含 `snapshot_id`、`snapshot_time`、`runtime_version`，这些只在 `snapshot`。

| 字段 | 含义 |
| --- | --- |
| id | 实验 id |
| type | 实验类型 |
| status | 运行状态 |
| health_status | 行级健康标记 |
| plan | 计划文件 |
| worker | `{ id }` 或 `null` |
| gpu | `{ id }` 或 `null` |
| stage | 当前阶段 |
| updated_at | 状态更新时间，ISO 字符串，来自实验记录 |

## progress

训练进度，整个输出中只出现这一处。

| 字段 | 含义 |
| --- | --- |
| epoch | 当前 epoch，没有则为 `null` |
| max_epoch | 总 epoch，没有则为 `null` |
| percent | 当前训练循环完成百分比；多训练循环任务切换循环时可以重新从较小值开始，不是整个 `worker_run` 总体完成率；无法确定时为 `null` |
| loss | 当前 loss，没有则为 `null` |
| updated_at | 进度对应的状态更新时间 |

没有进度数据时整个字段为 `null`。

窄布局 Rich 进度可提供 batch 等局部证据，因此 progress 可以非 `null`，但 epoch 和 percent 为 `null`。字段级 `null` 表示该值当前不可证明，不等于整个 progress 不存在。

标准 `Epoch N: Val Loss = ...` 日志表示第 N 个 epoch 已完成。例如第 9/300 个 epoch 完成后，当前训练循环 percent 为 3.0%。该值不表示整个 `worker_run` 的完成度。

## health

健康判断，唯一来源。

| 字段 | 含义 |
| --- | --- |
| status | `healthy`、`warning` 或 `error` |
| reason | `failed_recent`、`stalled`、`missing_progress`，没有则为空字符串 |

## diagnosis

原因分析，不重复 `health` 的结论。

| 字段 | 含义 |
| --- | --- |
| reason | 失败原因列表，非失败为空 |
| suggestions | 去掉 `unknown` 后的原因 |
| latest_message | 评分最高的有效训练日志，没有则为空字符串，最长 300 字符 |
| stale_seconds | 对于 live Worker task，表示距离最后可观察任务输出的秒数；没有 Worker activity 时间时回退到状态更新时间，无法解析时为 `null` |
| failure_context | 仅当实验 `status` 为 `failed` 时出现，健康和运行中的实验没有该字段 |

`failure_context` 为 `{ last_error, stage, worker }`。`last_error` 是最后一条错误日志，最长 300 字符，没有则为空字符串，不含完整日志。`stage` 是失败时所处阶段，`worker` 为 `{ id }` 或 `null`。

`--full` 额外包含 `evidence`，最多 20 条，每条最长 200 字符。

## alerts

风险标记。三个布尔值之外附带 `alert_details`，正常时为空数组，异常时每项为 `{ type, message }`，不含日志。

| 字段 | 含义 |
| --- | --- |
| missing_progress | 训练型 worker_run 从 started_at/created 起超过 10 分钟仍没有任何可信 progress；run、train、train_test 生效 |
| stalled | running 对象超过 30 分钟没有可观察任务输出；live Worker task 使用日志 mtime，不受 CLI 查询刷新 updated_at 影响 |
| recent_failure | 24 小时内失败 |
| alert_details | `{ type, message }` 列表，`type` 取值与上面三个字段相同 |
