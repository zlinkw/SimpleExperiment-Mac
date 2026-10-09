# experiment active JSON

`simpleex experiment active --json` 的默认输出，`schema_version` 为 `"1"`。字段变化必须提升版本号。

```json
{
  "schema_version": "1",
  "snapshot": { "snapshot_id": "string", "snapshot_time": "string", "runtime_version": "string" },
  "active_count": 0,
  "workflows": [],
  "runs": []
}
```

## snapshot

| 字段 | 含义 |
| --- | --- |
| snapshot_id | 本次查询编号，只在这一次调用内有效 |
| snapshot_time | 本次查询时刻，ISO 字符串 |
| runtime_version | 当前运行实验中最新的状态更新时间 |

## runs

每个正在运行的 worker run 一项。

| 字段 | 含义 |
| --- | --- |
| id | 实验 id |
| experiment_case | 实验用例名，空则省略 |
| stage | 当前阶段，空则省略 |
| seed | 随机种子，空则省略 |
| worker | `{ id }` 或 `null` |
| gpu | `{ id }` 或 `null` |
| progress | `{ epoch, max_epoch, percent, loss, updated_at }`，没有进度时为 `null`，缺的数字为 `null` |
| updated_at | 状态更新时间，ISO 字符串 |

`progress.percent` 表示当前终端可识别训练循环的完成度，不保证表示整个 `worker_run`。一个 `worker_run` 顺序运行多个训练循环时，`epoch` 和 `percent` 可以在循环切换后重新从较小值开始。Agent 不应仅凭此字段估计整个任务的剩余时间。

CLI 可识别包含 `epoch X/Y` 与 batch 百分比的终端进度条，以及 `Epoch N: Val Loss = ...` 形式的 epoch 完成日志。后一格式的 `max_epoch` 从实际运行的 `job_config` 训练配置补全；无法取得总 epoch 时仍返回 epoch 和 loss，percent 为 `null`。

Rich 解析限于本项目 `TerminalProgress` 的宽、窄布局，不承诺识别任意 Rich 组件。宽布局有显式 `epoch X/Y` 时可计算训练循环 percent；窄布局只显示 `Train/Val` 与 batch 进度时，解析器保留可信的 batch/loss，不推断 epoch，因此公开 percent 为 `null`。公开 progress 字段仍不包含 batch。

tmux pane 中仍能解析到旧训练文本，并不单独证明任务仍在运行。若同一物理 `worker_run` 已有 Worker Agent 的 `success`、`failed` 或 `cancelled` 终态，终态优先，残留的 runtime observation 不进入 `active`。

Worker `/api/tmux/list` 若提供窗口 task 元数据，CLI 优先用该 task 的 stable `commandId` 作为运行对象 id；`run-<timestamp>` 窗口名只作为内部 runtime alias。明确标为终态的 task window 在 capture 前被忽略，Hub `tasks.list` 短暂缺失或限流也不应令 active id 退化为 alias。没有 task 元数据的窗口仍使用原有 runtime alias 和身份匹配逻辑。

`workflows` 每项为 `{ id, status, plan, worker, tmux }`，空字段省略。`--json --full` 额外保留 `created_at`、`health_status`、`children`、`model`、`dataset`。
