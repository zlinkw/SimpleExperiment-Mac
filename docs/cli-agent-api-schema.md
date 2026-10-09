# Agent JSON API

`simpleex experiment <active|health|overview|inspect> --json` 的稳定输出，`schema_version` 固定为 `"1"`。字段变化必须提升版本号。四个接口职责不重叠，文本模式不带 `schema_version` 和 `snapshot`。

四个接口的 `snapshot` 相同，描述这一次查询，不描述实验：

| 字段 | 含义 |
| --- | --- |
| snapshot_id | 本次查询编号，只在这一次调用内有效 |
| snapshot_time | 本次查询时刻，ISO 字符串 |
| runtime_version | 实验状态版本，等于相关实验最新的 `updated_at` |
| runtime_source | 状态数据的主要来源：`experiment_index`、`history` 或 `runtime_observation` |

来源优先级为 `runtime_observation > history > experiment_index`。`history` 包括 Worker task 历史、Scheduler operation 生命周期记录和现有历史产物。`runtime_source` 描述对象数据来自哪层记录；`status_source` 描述最终公开状态由 `scheduler`、`worker`、`aggregate` 等哪种逻辑决定，两者不是同一概念。

## experiment active

当前运行中的任务。

```json
{
  "schema_version": "1",
  "snapshot": {},
  "active_count": 0,
  "workflows": [],
  "runs": []
}
```

`runs` 每项为 `{ id, experiment_case, stage, seed, worker, gpu, progress, updated_at }`。`worker` 和 `gpu` 为 `{ id }` 或 `null`，`progress` 为 `{ epoch, max_epoch, percent, loss, updated_at }` 或 `null`。空的 `experiment_case`、`stage`、`seed` 省略。

`progress.percent` 只表示当前可识别训练循环的进度，不是 `worker_run` 总体完成率。多阶段任务切换训练循环时可以回退；没有可识别的 `epoch/max_epoch` 时为 `null`。

进度证据包括 `epoch X/Y` 终端进度条和 `Epoch N: Val Loss = ...` 完成日志。后一格式的总 epoch 来自实际运行的 `job_config`；若无法取得总 epoch，仍保留 epoch 和 loss，percent 为 `null`。`progress=null` 仅表示当前捕获内容没有可信训练进度证据。

Rich 仅识别本项目 `TerminalProgress` 的已知宽、窄布局。标准 epoch 日志与可识别的 Rich 行按文本位置选择最新证据；最新窄布局缺少 epoch 时，不把较旧标准日志的 epoch 与当前 batch 拼接，epoch 和 percent 保持 `null`。

`experiment active` 返回归一化后的当前运行对象，不是所有仍能从 tmux pane 解析出的历史文本。若唯一匹配的 Worker Agent 历史已确认 `success`、`failed` 或 `cancelled`，该终态高于 pane 中残留的 runtime observation。

当 Worker `/api/tmux/list` 提供窗口 task 元数据时，`active.runs[].id` 优先使用 Worker task 的 stable id；runtime pane/window id 是内部 alias，已标记终态的窗口不进入 active。元数据不可用时，继续使用现有 runtime observation 归一逻辑，不增加公开字段。

## experiment health

整体健康判断。

```json
{
  "schema_version": "1",
  "snapshot": {},
  "health": { "status": "healthy", "reason": "", "alert_level": "ok" },
  "alerts": { "missing_progress": false, "stalled": false, "recent_failure": false, "alert_details": [] }
}
```

`health.status` 为 `healthy`、`warning` 或 `error`，`reason` 为 `failed_recent`、`stalled`、`missing_progress`，没有则为空字符串。`alert_level` 只在本命令出现：`healthy` 映射为 `ok`，其余与 `status` 相同。`overview` 和 `inspect` 的 `health` 没有 `alert_level`。

`missing_progress` 表示训练型 running `worker_run` 从 `started_at` 或 `created` 起超过 10 分钟，仍未出现任何可信 progress；适用 stage 为 `run`、`train`、`train_test`，不适用于 `test`、`debug` 或未知 stage。RuntimeObservation 的 `updated_at` 是状态观测时间，不会重置这段启动宽限期。

`stalled` 表示 running 对象超过 30 分钟没有可观察任务输出。live Worker task 使用日志 mtime 判断；旧 Worker 没有提供该时间时回退到 `row.updated`。CLI 查询刷新的 `updated_at` 仍表示状态观测时间，不作为新版 Worker task 的输出活动时间。

`failed_recent` 与 `error` 组合表示最近失败尚无更新的运行中或成功重试；与 `warning` 组合表示同一 plan、experiment_case、seed 已有更新的运行中重试。`overview.alerts.failed_recent` 只返回当前仍需关注的近期失败：尚未恢复的失败和存在更新 running retry 的失败。最新 retry 成功后，该失败从告警消失；过去 24 小时内已恢复的失败仍保留在 `summary.recent_failures` 历史摘要中。

全局 `experiment health` 和 `experiment overview` 不重复统计已有子 `worker_run`、且 `status_source=aggregate` 的失败 `workflow`；其失败由实际子任务表达。没有子 `worker_run` 可代表的独立 Scheduler/workflow 失败仍进入 `failed_recent`。单独 `inspect` 失败 `workflow` 时，仍报告该对象自身的失败健康状态。

`alerts` 只有布尔值和 `alert_details`，不含实验列表。`alert_details` 每项为 `{ type, message }`，最多 10 条，`message` 最长 300 字符，不含日志。

## experiment overview

全局汇总，一次查询产出。

```json
{
  "schema_version": "1",
  "snapshot": {},
  "summary": {},
  "active": {},
  "alerts": {},
  "health": {}
}
```

| 字段 | 含义 |
| --- | --- |
| summary | `running_count`、`failed_count`、`success_count` 统计 `worker_run`；`workflows` 统计已知 `workflow` 总数。`active_workers`、`gpu_usage` 来自运行中的 `worker_run`；`stalled_experiments` 保持健康与告警口径；`recent_failures` 是最近 24 小时失败历史，包括已恢复的实际 `worker_run` 和没有子 `worker_run` 可代表的独立 `workflow` 失败，不重复列出聚合父 `workflow`。按 unresolved → running retry → resolved 排序，最多 5 条 |
| active | 与 `experiment active` 的 `active_count`、`workflows`、`runs` 相同，不含 `schema_version` 和 `snapshot` |
| alerts | 当前告警列表：`failed_recent` 仅含未恢复或正在重试的近期失败，不含已被更新 success attempt 恢复的历史失败；`stalled` 和 `missing_progress` 保持当前告警语义。`failed_recent` 默认最多 3 条，`--full` 最多 10 条 |
| health | `{ status, reason }`，与 `inspect` 的 `health` 同构，没有 `alert_level` |

`summary.running_count` 与 `active.active_count` 口径不同：前者是正在运行的 `worker_run` 数，后者是 `active` 返回的 `workflow` 与 `worker_run` 对象总数。一个 `workflow` 调度三个训练任务时，前者可以为 3，后者可以为 4。

## experiment inspect

单个实验。

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

`summary` 是实验身份，`status` 是当前状态，`progress` 是训练进度且只出现这一处，`health` 是健康判断，`alerts` 与 `experiment health` 的 `alerts` 同构。字段明细见 `cli-inspect-schema.md`。

`diagnosis` 为 `{ reason, suggestions, latest_message, stale_seconds }`。仅当实验 `status` 为 `failed` 时额外包含 `failure_context`：

| 字段 | 含义 |
| --- | --- |
| last_error | 最后一条错误日志，最长 300 字符，没有则为空字符串 |
| stage | 失败时所处阶段 |
| worker | `{ id }` 或 `null` |

`failure_context` 不含完整日志。`--full` 额外给出 `diagnosis.evidence`，最多 20 条，每条最长 200 字符。

## experiment config

公开字段保持 `{ id, config_path, yaml, experiment_case, seed, dataset, model, optimizer, batch_size, epoch }`。对 `worker_run`，`config_path` 优先表示该任务实际执行时的 `job_config.yaml`。历史配置依次来自 task snapshot 中当时持久化的路径、该 task 自身 `logPath` 的启动上下文、仍存在且按稳定 Worker task ID 精确匹配的 terminal pane。若历史 `job_config.yaml` 已不存在，显式查询可从该 task 日志前部的 `context-json.config_text` 读取当时实际使用的配置文本及其原始路径；Worker task API 仍不把不存在的文件填入 `configPath`。Worker task API 对旧任务只返回恢复后的视图，不改写 snapshot。Plan 是可变输入，不是历史任务真值；CLI 不重新展开当前 Plan，也不按 case、seed 或 index 扫描目录。

`workflow` 仍返回本地 plan/config。旧 Worker 离线，或 task snapshot、持久日志、terminal pane 均无法提供可验证路径或配置文本时，可能只能返回原有 plan 信息；CLI 不会猜测 `job_config.yaml`。

## result 与 experiment results

`result list/show/export` 汇聚本地结果注册表、本地结果文件、已连接 Worker 的 `/api/results/summary` 和 Hub `results.list`。相同 `resultId` 继续去重；Hub 记录优先于 Worker 直连记录。`stdout.log` 和 `stderr.log` 属于诊断及输出证据，不能产生结构化结果；CLI 过滤历史 Worker summary 和 Hub 结果中仅由这两类日志生成的伪结果。`result list` 展示已解析结果，不表示已通过最终证据审核。

`experiment results` 首先将结果的 `resultId`、`experimentId`、`runKey` 与 CLI 实验 ID 精确匹配。成功的 `worker_run` 若没有直接匹配，可以读取其真实 `job_config.yaml` 中的 `experiment_name`，与结果的 `experimentId` 完整相等时关联。plan、worker、case、seed 只用于冲突校验，不能单独建立关联。失败、取消、运行中或未知状态的 `worker_run` 不使用该逻辑身份回退，避免继承后续重试的结果。公开 JSON 字段保持 `{ experiment_id, result_ids, metrics, output_paths, reason }`。
