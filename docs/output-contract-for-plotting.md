# SimpleExperiment 输出到 PPT 绘图插件的稳定契约

目标消费端：`D:\GitRepo\my_ppt_app`

本契约只描述机器可读轻量输出。原始数据集、大 checkpoint、权重文件和日志全文不通过绘图契约传输，只通过 manifest 或摘要字段引用。

## 必备语义字段

- `method`
- `dataset`
- `split`
- `fold`
- `seed`
- `metric`
- `value`
- `mean`
- `std`
- `ci`
- `pValue`
- `adjustedPValue`
- `significant`
- `case_id`
- `patient_id`
- `subgroup`
- `error_type`

## 文件契约

### Result Registry

路径：`simple_cluster/results/result_registry.json`

用途：实验结果注册表，用于发现所有可绘图实验。

稳定字段：`resultId`、`experimentId`、`suite`、`method`、`dataset`、`split`、`fold`、`seed`、`metrics`、`dimensions`、`sourceFiles`。

### Statistics

路径：`simple_cluster/results/statistics.json`

用途：聚合统计，用于绘制均值、标准差、置信区间和显著性标注。

稳定字段：`suite`、`group`、`metric`、`mean`、`std`、`ci`、`pValue`、`adjustedPValue`、`significant`。

### Paper Table

路径列表：`paper/tables/<dataset-key>/simple_results_table__<plan-key>.csv`。契约 `files.paperTable.paths` 保存按数据集分区后的路径；只有一个数据集时 `path` 指向该文件。

用途：选择一个数据集的论文表格 CSV 生成表格图或柱状图。不得将不同数据集合并绘图。旧平铺表只读保留，新产物不再写入顶层混表。

稳定字段：`method`、`dataset`、`split`、`metric`、`mean`、`std`。

### Case Level

路径：`simple_cluster/results/case_level_index.json`

用途：病例或样本级结果，用于错误案例、子组图和泄漏检查图。

稳定字段：`case_id`、`patient_id`、`method`、`dataset`、`split`、`metric`、`value`、`subgroup`、`error_type`。

### Dataset Profile

路径：`simple_cluster/datasets/profile.json`

用途：轻量数据集画像，用于类别分布、split 分布和泄漏摘要图。

稳定字段：`dataset`、`split`、`class`、`case_id`、`patient_id`、`classDistribution`、`splitDistribution`。

## 兼容说明

- 插件会同时兼容 camelCase 和 snake_case，但新增输出应优先使用本文档字段。
- `pValue`、`adjustedPValue` 和 `ci` 可为空；`significant` 应为布尔值或可解析布尔文本。
- PPT 插件不要扫描原始数据集或 checkpoint 目录；只读取上述 JSON/CSV/Markdown 摘要。

## 列级 Schema（类型-空值-口径）

| 文件/字段 | 类型 | 空允许 | 口径/生产者 |
|---|---|---|---|
| `result_registry.json: resultId/experimentId/suite/method/dataset/split/fold/seed` | string/int（seed int） | 否 | Scheduler 归档时写入；`fold` 无折时记 `0` |
| `result_registry.json: metrics/dimensions/sourceFiles` | object/array | 否 | `sourceFiles` 指归档内相对路径 |
| `statistics.json: suite/group/metric` | string | 否 | Scheduler 归档聚合写入 |
| `statistics.json: mean/std/ci/pValue/adjustedPValue` | number | `ci/pValue/adjustedPValue` 可空 | `mean/std` 聚合必填有限数值 |
| `statistics.json: significant` | boolean\|可解析文本 | 可空 | `true/false/1/0/yes/no` 均接受 |
| `paper/tables/<dataset-key>/*.csv: method/dataset/split/metric` | string | 否 | 由归档大表生成，`mean/std:number` 必填 |
| `case_level_index.json: case_id/patient_id/method/dataset/split/metric/value/subgroup/error_type` | string/number（value 有限数值） | `patient_id/subgroup/error_type` 可空 | 与 per-job `metrics_case.csv` 同源（`experiment_id,case_id,dataset,split,method` 必填列展开），Scheduler 归档时建索引 |
| `profile.json: dataset/split/class/case_id/patient_id/classDistribution/splitDistribution` | string/object | 分布对象可空 | 轻量画像，不含原始数据 |
| 通用 | `timestamp:ISO8601, epoch/step:int` | 可空 | 缺失不阻断绘图 |
