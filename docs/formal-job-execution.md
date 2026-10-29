# 正式 job 与内存汇总契约

> 历史版本协议记录。下文的 0.5.278、协议 1 和旧节点升级步骤不作为当前操作说明；当前只使用单台或多台 Worker，协议与接入以 [项目契约](plugin-project-contract.md)、[配置说明](simple-experiment-setup.md) 和 [接入模板](experiment-integration.md) 为准。

适用版本：本 Windows 仓库的 SimpleExperiment 0.5.278。正式表示执行及保存方式，不代表结果满足论文证据要求。未核验 Mac 仓库 ad87dbd 或其 0.5.310 安装包，也未部署、探测生产 Hub/Worker。

## 新任务路径

`case/runner.result_path_policy`、PLAN 的 `runner.result_path_policy` / `result_path_policy`、项目 `experiments/simple_project.yaml` 的 `resultPathPolicy` 按顺序取值，缺省为 `declared`。显式旧 `attempt` 策略被拒绝，不静默回退。

新任务直接使用 `naming.sweep_dir` / `naming.job_name` 与 `paper.result_csv` 的渲染结果。命令 `{result_csv}` / `--result-csv`、配置 `paper.result_csv`、`test.results_csv`、`runtime.result_csv`、收集路径必须一致。`runtime.result_path_contract` 保存：

```yaml
schemaVersion: 1
policy: declared
declared_output_dir: work_dirs/formal/case/seed42
execution_output_dir: work_dirs/formal/case/seed42
declared_result_csv: tmp/result/formal/case/seed42/metrics.csv
execution_result_csv: tmp/result/formal/case/seed42/metrics.csv
collection_result_csv: tmp/result/formal/case/seed42/metrics.csv
```

仍需先 validate/dryRun，再正式提交。项目的纯 `adapter.resultPathValidator` 接收实际配置及契约；预检不创建 preview attempt。拒绝共享 CSV、越界及链接路径、当前命令与配置不一致、过期 PLAN revision。正式 PLAN 使用 `tmp/result/` 合法，目录名中的 `tmp` 不触发草稿流程。旧 `tmp/plan/` 与 debug 隔离执行明确报 `DRAFT_EXECUTION_RETIRED`。

本机队列、Scheduler、Worker 入队、派发、失败重跑/召回、镜像和结果收集使用同一正式路径。三种执行模式 `train`、`test`、`train_test` 来自已核验 PLAN；`train` 不执行显式测试命令或默认 `test.py`。新运行使用 workflow/runId、globalJobId、commandId、PLAN/代码/配置/源资产及文件 SHA256 核验身份。内部旧 schema 的零值仅用于兼容匹配，不递增、不生成新 attempt ID；新持久队列、Worker 公共任务和汇总来源记录省略该零值。

## 并发、重入与已有权重

每个正式目录持久保存 `.formal_job.lock` 和 `formal_job_owner.json`。预检只读，运行时使用非阻塞文件锁并重新核验；活动目录或 CSV 已有其他写入者时报 `FORMAL_JOB_ACTIVE_WRITER`。重复 commandId 必须绑定相同 job、PLAN revision、执行模式、目录和 CSV。同一已完成身份且产物哈希均匹配时只返回完成证据，不启动任务。

新 commandId 面对已有结果、权重、失败残留或不同所有者时报 `FORMAL_JOB_CONFLICT`。重跑不加时间戳目录、不覆盖、不自动移走原文件。用户须自行发起独立清理或显式修改正式 case/job；尚未启动且有精确释放回执的任务可召回同一目录本机排队。旧 attempts 仅只读展示、核验和收集，不能恢复执行或自动迁移。

同一 job 的 train→test 可使用已核验的本 job checkpoint、最终训练配置及完成证据；测试失败保留训练完成证据。显式 resume 或另一个只测试 job 需要精确声明来源，例如：

```yaml
runtime:
  checkpoint_source:
    checkpoint_path: work_dirs/formal/source/seed42/best_model.pth
    checkpoint_sha256: <文件SHA256>
    config_path: work_dirs/formal/source/seed42/job_config.yaml
    config_sha256: <最终配置SHA256>
    plan_file: experiments/plans/formal/source.yaml
    plan_revision: <来源PLAN文件SHA256>
    code_fingerprint: <来源代码指纹>
test:
  checkpoint: work_dirs/formal/source/seed42/best_model.pth
```

resume 的配置/命令也必须指向同一个已核验 checkpoint。核对训练配置、seed/患者划分、来源 PLAN 和代码；代码同步指纹变化时仅允许最终快照内的源码 SHA256 与当前实际源码一致的明确来源证明。没有证据就阻断，不自动采用目录内任意权重。不修改 MultiModal 的模型、训练预算、划分、五指标、selection_only 或科学选择规则。

## 结果仅读入内存

“下载指标并重新汇总”“同步服务器结果并更新总表”和远端单文件查看均要求当前 SimpleSFTP `sync.downloadMappedPaths` 公布 `memoryOnly=true`、`memoryWrapperResults=true`。所有 wrapper 格式均内存接收，没有磁盘下载兜底。能力缺失明确失败，保留已有汇总。

原始 CSV/TSV/JSONL、配置快照、manifest、原始 sidecar 不写入本机 `tmp/` 或结果下载缓存。SHA256、文件大小、作业/命令/PLAN/权重归属与四态完整性仍核验。文本查看打开未保存文档；二进制只展示大小和哈希。流程结束不保留原始字节。

允许保存生成的 dataset/method/final 汇总表、每 PLAN 汇总 JSON，以及必要的来源路径/哈希/大小/任务身份。汇总 JSON 只保存指标汇总与格式/行列计数及来源证据，不保存原始文件内容或原始逐行副本。再次同步重新内存读取；“刷新本地结果”可从已保存汇总重建，不需要原始下载缓存。相同 writer 的来源哈希变化或输入不完整时保留之前的完整表，不借用旧 seed。

已有本机原始副本、旧 attempts、结果、日志和权重保持原字节；本次不自动清理。独立清理入口继续遵守精确预览、人工确认和双确认永久删除边界。

## 协议与部署

- Host/Hub/Worker 使用 schema 1、formal job path protocol 1；Agent 的 `declaredJobPaths` 能力还核对安装的 Scheduler 协议标记及与 Agent 相同的 runtime 版本。
- 旧 Agent/Scheduler 在正式提交或实际消息入队前报 `WORKER_PROTOCOL_INCOMPATIBLE`，不能延迟到训练进程才发现。不假定只有升级本机扩展就升级远端。
- `drafts.list/validate/promotionPreview` 保留历史只读接口；实际 `drafts.promote` 路由明确退休，debug 新执行也阻断。现有独立人工审核/清理入口保留。
- Windows 安装 0.5.278 后执行 Developer: Reload Window。之后用户显式更新 Hub 及每个 Worker 的配套 Scheduler/Agent 到 0.5.278，并通过 live discovery/capabilities/OpenAPI 核验，再 validate/dryRun。当前正在训练的任务不重启。
- 本次没有调用研究项目 API、上传、服务器部署、GPU 调度、训练、重跑或清理。Mac 安装/部署与真实 Worker/UI 验收未执行；不能将 Windows 验证结果替代 Mac 0.5.310 的核验。

## 本地验证

每个测试文件串行使用 `node --test --test-force-exit --test-timeout 20000 <文件>`，Python 只 AST 提取被测生产函数，子进程上限 10 秒。使用保留的独立系统临时夹具、mock 多 Worker；没有执行清理器。

| 测试文件（test/features/） | 覆盖 |
| --- | --- |
| formalJobExecution.test.js | 真实 Scheduler/Agent 消息、正式目录锁/哈希冲突、checkpoint 来源、三种子本机/分布式路径、幂等、释放/召回、旧记录只读、TensorBoard/新适配器稳定身份 |
| planResultPathContract.test.js | MultiModal 七个实际 PLAN、实际 experiments/quality_paths.py 纯接口、命令/配置快照/manifest 同路径、零副作用预检、并发 CSV 隔离及旧缓存拒绝 |
| distributedPlanExecutionMode.test.js / planRunModeWorkflow.test.js | train/test/train_test 保存、恢复、派发及不重启活动记录；train 不测试 |
| planRunFreshness.test.js / planArtifactSyncStatus.test.js | 历史结果只读核验、当前身份/SHA256、跨 Worker 镜像及离线状态 |
| wrapperResultPersistence.test.js | 正式 declared/历史重试汇总、所有格式内存读取、零原始缓存、只存汇总、哈希变化/四态不完整拒绝、汇总事务回滚 |
| remoteResultInspectionWorkflow.test.js | 确认后的内存单文件查看、tmp/result 允许而 tmp/plan/cache 拒绝、来源隔离 |
| planOutputRetention.test.js | 自动退休关闭，人工清理双确认和原父目录安全门禁保留 |

构建另运行 14 项 Webview/清理消息桥测试及语法门禁，额外对 `dist/ui/PanelHtml.js` 运行 `vm.Script`。没有执行全套测试、真实训练、生产服务器检查、UI 点击验收或 Mac 验收。

## 0.5.279 启动前拒绝回执

`FORMAL_JOB_CONFLICT` 等启动前预检失败现在持久保存完整 job 身份、错误码、精确输出/结果路径、结束时间和 `neverStartedEvidence: formal_preflight_rejected`，返回 `failed`、`durableAccepted: false`、`admissionRejected: true`。首次派发、原 commandId 核查和重载后的 Worker 快照使用同一证据；不会将拒绝误报为持久接收，也不会一直显示待核实或自动重派。已接收的排队 job 在实际启动前发生路径冲突时也终止报错，代码同步等待仍保留原机制。

只有完整且匹配的 Worker 回执可以终结待核实。普通 HTTP 错误、丢失回执、身份不一致继续保留原 owner。若 durable 行丢失而执行快照或 formal owner 仍证明该 command 曾执行，禁止伪造未启动证据。GPU 繁忙仍返回本机等待，不计为预检失败。界面显示训练未启动，禁止跳转到不存在的 TMUX 日志；已有权重、日志、结果和历史 attempts 保留，路径冲突仍需用户显式处理或修改正式 job 声明。

需要 Windows 扩展与对应 Worker 的 Scheduler/Agent 一起更新到 0.5.279。本轮只读核验了 MultiModal 的本机状态及 Worker 回传快照，未部署 Worker、重启训练或清理目录。`preflightDispatchRejection.test.js` 回放提取的生产 Scheduler、Agent action、Host tick 和持久队列，覆盖首次拒绝、旧 unknown、重复提交、丢失响应、外来/不完整证据、GPU 繁忙和排队后冲突。

## 0.5.280 正式身份穿过 tmux 的契约

本轮基于 Windows HEAD `42902a5a`、0.5.279 源码与消费项目保存的 `identity_forwarding_20261012` 证据实现；没有使用 Mac e81201e/0.5.312 的工作区或覆盖其改动。最新故障是正式身份没有进入 tmux 任务 shell，不能再归因为目录冲突。MultiModal 的七份 PLAN、direct_jobs 路径和配置均未修改。

GPU 独立窗口和普通启动路径共用 `job_shell_environment_prefix`，通过每次命令的 `env` 白名单完整传入原始 `SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY` 字符串，安全引用中文、空格、单双引号、反斜杠和换行。不存在的任务控制字段用 `env -u` 显式清除；身份不写入共享 tmux session/global environment。`fresh_task_runtime_env` 同时隔离 Agent 重启继承的旧身份、只测试标志、分布式结果标志和 GPU 绑定。只传 job 身份/模式控制、conda、GPU、退出码和日志需要的变量，不显式传 Agent 凭据或整个环境。

启动前核查五项身份、`workflowId:index`、原 commandId 及实际 CLI index/revision。受管理 Scheduler 缺少原 JSON 时立即报具体缺失字段，不扫描源目录或补造身份；非法 JSON 和跨 job/command 身份仍拒绝。配套 Scheduler 标记 `FORMAL_JOB_IDENTITY_ENV_PROTOCOL=1`，Worker capabilities/availability 宣告 `formalJobIdentityEnv=1`；旧 Worker 在本机保存/派发前阻断。本地 API execution capabilities 同步公布协议 1，原路径协议/单写者/revision/完成 SHA256 门禁保留。

新的正式任务控制台日志按 commandId 的 SHA256 独占命名，原来的共享 GPU 日志及历史文件保留。失败回执与任务快照保存 `failureDiagnostic`，包括原始有界 traceback、错误字段、commandId/runKey、真实 pane/windowId 与精确日志路径。重启后的退出码核查使用同一证据；不能将 GPU 基础 shell 或其他 command 的日志归给本 job。

目录冲突仍阻断，另外返回只读 `formalConflictEvidence`：Worker、项目根、精确 output/result、有限文件类别/元数据、owner 差异与状态、锁状态、是否仅含历史 attempts 子目录。不会读取权重、推断成功、移动或清理。`completedJobOutputs` 保留兼容入口但不再依据本机 completed 缓存复用/跳过当前作业；必须以当前 Worker 对当前声明的验证为准，已有直接正式目录照常拒绝另一写入者。

真实测试在本机 WSL Ubuntu-Codex、tmux 3.4、Python 3.12.3 上运行两个已有隔离服务器路径（GPU 与普通），每条路径同时启动 index 0/1 的轻量探针；调用提取的生产启动函数与真实 bash/tmux，合法身份进入实际 Scheduler writer，修改/缺失/跨任务身份被拒绝。没有使用研究 train.py/test.py。夹具保留，结束时仅停止该夹具创建的隔离 tmux server。模式、checkpoint-only、train→test、重载、旧 Worker 阻断另有提取生产函数回归。

七份实际 MultiModal PLAN 的 20 条真实 launch-message 生产函数契约已校验，预算仍为 PAD/fold0/seed42 的 18 个压力作业和 2 个官方参考。该消息测试使用冻结的夹具代码证明值，禁止重新扫描科研数据树或访问网络；它不代表远端资产/权重或科研结果验证通过。

安装 Windows 0.5.280 后需用户重载 VS Code，再显式部署匹配版本的 Agent/Scheduler（含 NWPU2）。之后先核对失败 job 的现有文件、revision、checkpoint/owner/hash 与实际 Worker capabilities，再人工决定是否重新提交。不自动更名、清理、覆盖或重训。提供的 traceback 与调用顺序表明该次 train.py 尚未调用；NWPU2 远端产物实检、实机重跑和 Mac 部署仍待验证，本轮未连接服务器执行训练、同步、部署或清理。

## 0.5.281 正式 job 精确中止

0.5.280 的正式任务快照按协议省略 `attempt`，但中止匹配仍直接执行 `int(task.get("attempt"))`。Host 队列内部的兼容值 `0` 因此无法匹配同一个正式 job；Worker 返回“没有与指定 job 身份一致的任务”。对 Git 中 0.5.280 的真实生产函数进行了 AST 提取复现：除快照没有 `attempt` 外身份完全相同，旧函数拒绝，新函数接受。正式任务不再创建或持久保存 attempt 版本。

Host 的中止、排队召回和重新分配共用冻结身份请求，正式任务显式传递 `resultPathPolicy`、`globalJobId`、`collectionResultCsv`，不发送 `attempt`。Worker 按正式或历史任务分别匹配；旧 schema 的正式兼容值 `0` 可读取，非零 attempt、原 workflow/command/revision/代码/结果路径不一致仍拒绝。中止回执完整保留正式身份。待启动任务取消保留原 GPU 绑定并释放该 job 的预约；失败/已完成窗口仍必须取得精确 pane 消失证明，不能关闭共享会话或猜测不存在。

结构化失败包含 `WORKER_TASK_IDENTITY_REQUIRED`、`WORKER_TASK_IDENTITY_MISMATCH` 或 `WORKER_TASK_NOT_FOUND`，附带缺少/不一致字段。`/api/v1/capabilities` 的 `execution.formalJobStopIdentityProtocol` 为 `1`；Worker 实时 `actionEndpoints["stop-worker-task-formal-identity"]` 必须为 `true`，旧 Worker 在发送正式停止请求前被阻断并提示更新。

验证串行执行，全部通过：`formalJobStop.test.js` 2 项、`planStopClear.test.js` 33 项、`formalJobExecution.test.js` 6 项、`prequeueRecallLifecycle.test.js` 5 项、`test/agent/prequeueRecall.test.js` 1 项、`distributedPlanExecutionMode.test.js` 9 项，以及构建的 Webview/清理消息桥 14 项，共 70 项。相关旧测试夹具补齐生产依赖和 declared 路径，移除已退休的“召回自动追加 attempt”期望；未放宽生产门禁。

新增真实边界测试在本机 WSL Ubuntu-Codex、tmux 3.4 的专用隔离 server 上执行：failed/running/completed 三种任务只关闭对应 pane，另一窗口保留；重复停止成功；跨任务/缺字段/非零 attempt 均不调用 tmux；待启动任务取消的正式回执经 JSON 进入 Host 的实际中止方法。原失败日志字节保持不变，已确认清除的队列不会被后台快照恢复。只运行轻量 `sleep` 夹具，未运行科研入口；夹具文件保留，结束时仅停止该测试创建的隔离 tmux server。

Windows 插件和 runtime 为 0.5.281。用户须重载 VS Code，并部署、重启关联 Worker 的 0.5.281 Agent/Scheduler，随后人工重试原 `late_fusion.yaml` 的“终止并清理”。本轮未调用生产 API、连接服务器执行停止/部署、修改 MultiModal、清理文件或重启训练；原 workflow 的生产服务器/UI 验收和 Mac 部署仍待验证。安装包验证不等于这些实机操作已经完成。

## 0.5.282 中止链路移除 attempt 依赖

0.5.281 对正式 job 仍保留了停止请求 `attempt=0` 的兼容，Host 匹配、清除确认键和已清除记录也还依赖旧字段。本轮明确移除这些控制链路的依赖，而不是用缺失字段补造版本。正式任务的快照匹配、中止/召回回执、清除确认键、派发中的保护键和新清除审计记录以原 workflow、command、globalJobId、revision、代码和路径为依据，不读取 `attempt`。不同 command 或 revision 产生不同控制键；旧的 attempt 确认键不能授权清除当前正式 job。

Worker 在任何中止或排队召回操作开始前拒绝正式请求携带 `attempt`（包括 `0`），返回 `FORMAL_ATTEMPT_RETIRED`。正式停止回执的构造直接跳过旧字段；不先计算一个假 attempt 再删除。历史任务仍可以通过其原登记身份手动中止，历史数据不迁移或删除。已清除的旧审计记录即使含 `attempt=0` 也只读取原 command/revision/路径等证据，不修改原记录字节，且不会恢复已清除的卡片。

本地 API 的 `execution.formalJobStopIdentityProtocol=2`、`formalJobStopUsesAttempts=false`，对应 Worker 需同时声明 `stop-worker-task-formal-identity` 和 `stop-worker-task-formal-no-attempt`。只具有上版兼容能力的 Worker 在停止请求发送前被阻断，必须显式部署、重启 0.5.282 Agent/Scheduler。没有改写声明输出、创建 attempts 目录、启动训练、自动部署或执行真实清理。

验证共 72 项全部通过：`formalJobStop.test.js` 3 项、`planStopClear.test.js` 34 项、`formalJobExecution.test.js` 6 项、`prequeueRecallLifecycle.test.js` 5 项、`test/agent/prequeueRecall.test.js` 1 项、`distributedPlanExecutionMode.test.js` 9 项、构建消息桥和 Webview 14 项。新增回归让正式 job 的 `attempt` 读取直接抛错，覆盖实际 Host 完整中止/清除路径、精确确认键和旧审计刷新；本机独立真实 tmux 测试也禁止 Python 读取该字段，并验证带 `attempt=0` 的中止及召回都拒绝。历史记录和失败日志保留原样。

验证边界仍为 Windows 构建/安装、WSL 隔离 tmux 和本地合成消息。没有执行生产服务器操作、全套测试或 Mac 部署；生产 UI 和原 NWPU2 任务中止需用户重载、更新关联 Worker 后实测。版本更新后停止操作旧面板，不能将安装成功当作生产任务已经中止。

## 0.5.283 部署探测接受正式中止能力标记

上版 Agent 已声明 `stop-worker-task-formal-identity`、`stop-worker-task-formal-no-attempt`，但本机 Worker Telemetry 校验器只识别实际控制动作，漏掉了这两个协议能力标记，因此健康响应可达的 Worker 仍被判为 `worker_api_invalid`。本地回归通过实际能力生产函数和 HTTP 探测复现了截图中的两条“不允许的控制动作”。

本机校验器用独立、精确的能力标记表识别这两个名称，保留原有真实控制动作白名单。标记不会变成可调用的 POST 动作，未知名称、相似前缀、Hub 部署动作和文件写入/列表能力继续拒绝。正式中止的无 attempt、完整身份及窗格验证门禁不变。

回归的 Agent 能力数据改为 AST 提取安装包 runtime 的实际 `api_capabilities`，并读取配套 Scheduler 头部核验版本/协议，不再用正则拼出模拟能力表。该 JSON 通过本机随机端口 HTTP 服务进入实际 `probeWorkerTelemetryTunnel`，随后验证部署等待循环能结束。没有启动完整 Agent、连接生产服务器或执行部署。

34 项验证通过：Worker Telemetry 契约 8 项、HTTP 隧道探测 9 项、正式中止 3 项、构建消息桥/Webview 14 项。构建/打包新增强制的串行 Telemetry 契约与 HTTP 探测门禁，能力生产方与校验方不一致时直接停止，不能再打包安装。Windows 0.5.283 安装后需重载 VS Code，再点击隧道检测核对现有 Worker；此截图的修复位于本机校验逻辑。若后续提交或部署提示 runtime 版本需要一致，再由用户显式部署 0.5.283 配套 runtime。生产服务器、实际 UI 和 Mac 验收未执行，科研任务、历史产物和 MultiModal 未修改。
