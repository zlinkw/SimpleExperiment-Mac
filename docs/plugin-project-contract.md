# SimpleExperiment / SimpleSFTP 项目对接契约

本契约说明当前单 Worker 与多 Worker 的接入边界。完整操作见 [配置与使用说明](simple-experiment-setup.md)，可复制模板见 [最小实验接入指南](experiment-integration.md)。消费项目可以追加科研约束，不能以项目适配器绕过插件的路径、身份、执行与确认保护。

## 1. 当前拓扑与版本边界

- 新配置统一使用 `worker_pool`，支持一台或多台启用 Worker；旧 `single_worker` 等值仅兼容读取，不能据此创建另一类执行端点。
- 连接、准备、同步、校验、派发、查询、清理和汇总目标只来自明确启用的 Worker。旧控制节点字段不能补成当前目标。
- Hub 已退役。其名称只允许用于历史格式读取、退役入口明确拒绝以及 GitHub 功能。历史结构、旧路径字段和 runtime 组件键不是当前调度能力。
- 每台 Worker 有自己的 Agent、Scheduler、任务窗口和产物。多 Worker 不自动把单个 job 变为跨服务器训练。
- 一个 VS Code 窗口只操作一个受支持的项目根目录；API 请求绑定项目及实例，禁止借用另一窗口的发现文件、连接或结果身份。
- 配套版本从当前发布源和实时 capabilities 确认；不能用本文中的某个历史最低版本代替实际协议检查。

## 2. 项目结构与环境

PLAN 放在 `experiments/plans/**/*.yaml`；配置、模型、训练、数据处理、指标、工具等放在各自模块目录。顶层脚本只做轻量入口。需要适配时使用 `experiments/simple_adapter/`，已有项目保留其合理模块划分，不为插件接入复制整套训练框架。

依赖由 requirements、environment.yml、pyproject 或项目自己的锁文件声明。Conda、数据集、权重与科研依赖由用户和消费项目管理。插件只传递所选环境、启动真实命令并回传真实错误，不自动导入 torch、修复环境或安装科研包。辅助 Agent 的解释器不必等于正式任务解释器。

不能要求项目必须采用某一种日志文本、epoch 文案或训练框架才能调度。通用命令可以没有指标；科研指标必须来自真实输出，不得填默认值冒充计算结果。

## 3. 正式任务协议与结果路径

新正式任务采用协议 2：本机保存启动/停止意图，Worker 的独立 Scheduler 保存已接收队列，前台 tmux 任务窗口承载实际执行，最终 artifact manifest 提供结果身份。状态以主动查询归并，不以“请求已接收”判定运行或完成。

新任务默认 `result_path_policy: declared`。`naming.output_dir` / `output_dir` 与 `paper.result_csv` 等声明展开后就是正式执行和收集路径，不默认追加 `attempts/<n>`，不创建新的 attempt 运行目录或额外正式运行状态文件。旧 attempt 只作历史兼容读取，不作为新项目模板。

同一任务的目录和指标路径必须稳定、独立，不能让不同 case、seed 或并发 job 写同一个共享 CSV。推荐：

~~~yaml
naming:
  output_dir: "work_dirs/{suite}/{case}/seed_{seed}"
paper:
  result_csv: "{output_dir}/metrics.csv"
~~~

`tmp/result` 可以是明确声明的正式结果目录；不能只因名称含 tmp 就自动排除。Debug 则有明确隔离标识和路径，不能冒充正式科研证据。

重跑或覆盖前核实真实旧产物并走精确路径审核与两次确认。清除本机历史卡片不是删除授权，也不能抹去产物归属。插件不能自动重跑、清理或恢复未知任务。

## 4. PLAN 字段

| 字段 | 默认 / 约束 | 含义 |
| --- | --- | --- |
| `suite` | 通用命令缺省从文件名派生 | 稳定实验组名，推荐显式填写 |
| `mode` | 可按命令推断；建议显式 | `train`、`test`、`train_test` |
| `base_config` | 按项目需要 | 声明后须是存在的项目内配置文件 |
| `seeds` | 通用命令默认 `[42]` | 明确的整数种子，显式空数组是错误 |
| `cases` | 通用命令默认 baseline | `name` 或兼容 `case`；显式空数组是错误 |
| `cases[].config` | 继承基础配置 | 某个 case 的配置文件 |
| `cases[].overrides` | `{}` | 对生成配置快照应用点分键修改；命令须真正读取该快照 |
| `naming.sweep_dir` | `work_dirs/multirun/{suite}` | 任务目录父路径模板 |
| `naming.job_name` | `{index}_{case}_seed{seed}` | 任务目录名模板 |
| `naming.output_dir` / `output_dir` | 显式值优先 | 可直接覆盖 sweep_dir/job_name 的输出目录 |
| `runner.train_command` | 按 mode 必需 | 真实非交互训练或单阶段命令模板 |
| `runner.test_command` | 按 mode 必需 | 真实评估命令模板；不要求一定叫 test.py |
| `runner.working_directory` | `.` | 项目内工作目录，不得越界 |
| `runner.inputs` | `[]` | 必要输入路径；声明后必须存在 |
| `runner.outputs` | `[]` | 声明任务产物；通用命令应列出所需输出 |
| `runner.collect_metrics` | 兼容默认启用 | 无指标的通用任务设为 false，不伪造指标 |
| `paper.result_csv` | 推荐显式、每 job 独立 | 正式指标路径模板，不是强制共享论文大表 |
| `expectedResults` | `[]` | 附加预期结果路径；声明不等于已生成 |
| `result_path_policy` | 新正式任务 declared | 不把历史 attempt 策略当作新任务默认 |

常用变量包括 config/config_path、suite、case、seed、index、output_dir/outputDir、result_csv/resultCsv、working_directory/workingDirectory、worker_id、gpu_ids、plan_file、job_name、experiment_name、python 和 checkpoint；用花括号书写。适用阶段、展开结果和确切命令以校验及预演为准。

只配置训练命令时可以使用 train；只配置评估命令时可以使用 test。train_test 需要两个阶段命令都能实际执行。case 之间阶段不一致时应明确拆分或补全，不让某些命令静默跳过。

## 5. 结果接口

最小接入不要求每个项目固定生成 metrics_summary.csv、metrics_case.csv、四态 JSON 或项目专用 adapter。项目可以选择：

1. 通用命令只声明真实产物，不采集论文指标。
2. 声明已有 CSV/JSON 指标文件，配置所需解析规则。
3. 在轻量适配入口把真实返回值/现有输出转换成每 job 独立指标文件。
4. 按项目明确启用已有 wrapper、TensorBoard 或日志接入通道。

推荐长表包含 `case,seed,metric,value`，可增加 dataset、method 等维度。列名不同可设置 `csvColumnMapping`；指标别名可设置 `metricAliases`。插件不推断 accuracy 的定义、测试划分、患者级聚合、p 值或科学结论。

原生任务的最终 artifact manifest 由运行协议写入并绑定 commandId/runId、mode、job 索引、case、seed、输出路径、结果路径、实际文件身份及退出事实。项目可以保留自己的附加 manifest 内容，但不得伪造插件完成证据。任务以前台进程树运行，不后台脱离 tmux，不能在命令结束后 exec bash 伪造长期存活。

## 6. 输出接入配置

新项目优先用 PLAN 加面板的“项目输出接入/结果解析”规则。当前 `simpleExperimentMac.projectAdapterRules` 存放候选路径、CSV 列映射、指标别名等；插件将需要的规则同步到 Agent 自有状态目录，不要求项目存在 simple_project.yaml。

历史 `experiments/simple_project.yaml`、run_wrapper 和显式 adapter 仍可兼容读取。不要为了接入通用命令自动生成一套无用旧配置，也不要把历史 MultiModal 的双 CSV、四态指标或论文归档流程变成所有实验的硬要求。

插件准备、校验、预演、启动和收集不自动执行项目的 `adapter.resultPathValidator`、全量数据集哈希、污染/患者/标签协议和论文结论检查。项目自己的严格检查应由项目显式运行，未执行的检查必须标记未检查，不能冒充通过。

## 7. 同步与目录保护

所有正式实验和服务器文件操作使用 SimpleExperiment / SimpleSFTP 的当前 API，不用临时 SSH、scp 或 rsync 绕过插件。

本机代码同步默认排除数据集、checkpoint、权重、日志、运行产物和虚拟环境；实际选中范围以用户当前配置为准。Worker 间默认范围包含完整 work_dirs（兼容 work_dir），不沿用本机代码上传的产物排除。每个 job 完成后，只将该 job 最新产物与当前勾选范围的交集同步到全部启用 Worker；用户取消的范围不自动补回。

文件和目录必须绑定精确 Worker、项目、安全根、真实父目录、固定类型与当前事实。永久删除仍需同一批精确路径两次确认，进入已验证的直接父目录后仅操作直接子项；链接、挂载或越界失败即停止。用户确认的精确删除目标不会因无关旧任务登记而扩大或被替换。

## 8. 查询、完成与中途结果

本轮服务器查询以实际文件系统和相关 tmux 窗口为准。历史回执不能证明文件仍存在；查询失败是未知。结果收集核实当前声明、原生 manifest、实际大小和 SHA256，再通过内存读取轻量文件，生成本地最终汇总，不把原始指标同步成本机缓存。

允许整批尚未完成时汇总已核实结果。旧表保留只表示上次导出仍在，不能把旧行冒充本轮查询成功。真实发现删除、损坏或身份冲突时必须提示；断线、慢日志和 TTL 到期不能自动撤销已确认完成的精确任务。

已完成事实绑定同一项目、Worker、commandId、任务索引和声明输出路径；不能跨运行复用，也不是停止、覆盖或删除授权。实际退出失败、产物状态、日志异常和指标可汇总性分别显示，不用一个状态掩盖其他证据。

## 9. 提交、停止和 Agent 生命周期

正式运行先有配置与 PLAN，再通过当前插件校验、预演，查看准确命令、路径、环境、范围与任务数后确认提交。自动代码同步、静态命令探针、全部启用 Worker 就绪检查和正式输出目录准备保留；完整校验包含真实同步写入，不标为零写入。

本机开始/停止意图与服务器实际运行状态分开。普通停止绑定稳定 commandId 与实际任务窗口，不用旧 PLAN revision、旧源码哈希或扩展版本一致作为停止门槛；不关闭整个 tmux 会话/server，不按方法名前缀批量停任务。

Agent 准备、升级、迁移和重启不能被历史活动/未知任务登记永久卡住。仅关闭用户指定的精确 Agent tmux 窗口，保留科研窗口、任务队列和产物，不通过扫描 PID 或 pidfd 杀进程。

## 10. API 与科研责任

每次调用读取当前项目实例的 discovery 和 capabilities/openapi，取实时方法与参数；端口、实例和 Worker 不能从示例或历史默认值猜测。使用统一 `simpleex-mac` 入口，旧独立 CLI 命令不作为新操作教程。

自动化不能静默填入危险操作确认。`CONFIRM_REQUIRED` 是正常保护；准确展示目标并取得所需确认后才传 confirm/pathConfirmed。运行失败、结果未知和写入接收回执不能作为自动重放修改操作的理由。

科研项目仍负责重复实验、统计、数据协议和论文证据链。插件可核实执行与文件身份，不能单凭“任务已完成”保证实验设计有效或论文结论成立。
