# SimpleExperiment

SimpleExperiment 是一个 VS Code 插件，用 Xshell 本地隧道、远端 Agent 和配套 SimpleSFTP 管理 Linux GPU 实验服务器。它把项目接入、代码同步、Agent 部署、实验计划校验与运行、GPU/任务监控、结果解析和论文证据检查放在同一个工作流里。

插件不直接发起 SSH、SCP 或 RSYNC。Agent 状态和控制走 Xshell 本地隧道；真实文件传输交给 SimpleSFTP。

## 适合谁使用

- 在 Windows VS Code 中编辑代码，在一台或多台 Linux GPU 服务器上运行实验。
- 希望通过已保存的 Xshell 会话访问服务器，而不是让插件保存另一套 SSH 密钥。
- 需要 Hub 汇总调度，或只需要单 Worker / 多 Worker 直连执行。
- 需要可追溯的 Plan、任务、日志、指标和归档流程。

## 组件

TensorBoard event 日志的目录层级和跨 seed 汇总要求见 [插件实验曲线页面与日志目录](docs/tensorboard-viewer.md)。

| 组件 | 作用 |
| --- | --- |
| SimpleExperiment | 服务器配置、拓扑选择、Plan 校验/预演/运行、Agent 与任务监控、结果分析入口。 |
| SimpleSFTP | 项目文件上传下载、Agent runtime 分发、ignore 规则和路径确认。 |
| Xshell | 用户已配置的登录会话和 `127.0.0.1` 本地端口转发。 |
| Remote Agent | 由用户显式部署到 Hub/Worker 的受管 Python runtime。 |

两个 VS Code 扩展必须一起安装：`simple-local.simple-experiment` 和 `simple-local.simple-sftp`。

## 系统要求

- Windows 10/11 和 VS Code 1.100 以上。
- 可运行的 Xshell，并且能保存 `.xsh` 会话。
- Linux Hub/Worker 已安装 Python 3。
- 运行计划的环境需要 `PyYAML`。例如：

```bash
conda activate ml-env
python -m pip install PyYAML
```

多用户共用服务器时，建议为每台服务器创建独立目录，并在插件中设置不同的 tmux 前缀。

## 安装

1. 关闭旧版本插件后重载 VS Code。
2. 安装最新版 `SimpleSFTP`。
3. 安装最新版 `SimpleExperiment`。
4. 执行 **Developer: Reload Window**。

从 Release 页下载 `.vsix` 后安装：

```powershell
code --install-extension .\simple-sftp-<version>.vsix
code --install-extension .\simple-experiment-<version>.vsix
```

插件开发发布分为两个显式阶段：先运行 `npm run package` 生成并验证 VSIX；所有修改结束后，再运行一次 `npm run install:latest`。`package` 不会自动安装扩展，同版本安装会跳过。安装后执行 **Developer: Reload Window**。不要在窗口继续使用插件时反复强制重装同一版本。

新版面板的“设置”区域提供配套更新入口。它会检查两个插件的 GitHub Latest Release；选择“安装并重载”后，插件安装更新并重载窗口。

## 核心概念

### 拓扑模式

| 模式 | 用法 |
| --- | --- |
| `single_worker` | 只有一台 Worker。该 Worker 自行调度和保存状态，不依赖 Hub。 |
| `worker_pool` | 两台以上 Worker 各自调度分片；无 Hub，不做跨节点备份。 |
| `hub_worker` | Hub 负责全局调度和汇总，至少一台 Worker 执行实验。 |

模式保存在 `simpleExperiment.topologyMode`，推荐在面板“设置 > 服务器”中选择。切换模式不会迁移已有任务。

### 远端根目录

“项目父目录”是服务器上存放项目的父目录，不是当前项目本身。最终项目路径由插件计算为：

```text
<项目父目录>/<本地工作区名称>
```

示例：

```text
项目父目录: /data/experiments
本地工作区: my_project
最终远端项目: /data/experiments/my_project
Agent runtime: /data/experiments/simple_agent
```

不要填写 `/root`、系统临时目录、`simple_agent`、数据集目录或当前项目名。API 显式传入的 `remoteRoot` / `agentProjectDir` 优先于已保存配置；没有用户配置时插件不会推断路径。可用 `remote.allowedRoots` 和 `remote.deniedRoots` 加安全边界。

## 快速开始

标准接入顺序是：Xshell 会话 -> SimpleExperiment 服务器目录 -> SimpleSFTP 目标 -> 准备 Agent -> 运行 Plan。

### 1. 准备服务器

在每台 Linux 服务器上确认：

```bash
python --version
mkdir -p /path/to/experiments
conda activate ml-env     # 如果使用 Conda；按你的环境名替换
python -c "import yaml"   # scheduler 需要 PyYAML
tmux -V                   # 推荐，用于保持 Agent 和长任务运行
```

如果不用 Conda，把插件中的 condaEnv 留空即可使用系统 Python。

### 2. 配置 Xshell 会话

Hub 和每台 Worker 都需要一个已保存的 `.xsh` 会话。

以 Hub 为例：

1. 打开 Xshell 会话属性。
2. 进入 **连接 > SSH > 隧道**。
3. 选择 **添加**。
4. 类型选择 **Local (Outgoing)**。
5. 源主机填 `localhost`，监听端口填 `18765`。
6. 目标主机填 `127.0.0.1`，目标端口填 `18765`。
7. 保存会话并测试登录。

Worker 不复用 Hub 的本机监听端口。远端 Agent 默认都监听自己的 `127.0.0.1:18765`，但每个 Worker 的本机端口必须不同：

| 角色 | Xshell 监听端口 | 目标主机 | 目标端口 |
| --- | ---: | --- | ---: |
| Hub | `18765` | `127.0.0.1` | `18765` |
| Worker A | `18766` | `127.0.0.1` | `18765` |
| Worker B | `18767` | `127.0.0.1` | `18765` |
| Worker C | `18768` | `127.0.0.1` | `18765` |

规则：

- 源主机/目标主机必须是 `127.0.0.1`、`localhost` 或 `::1`。
- 不同端点不能复用同一个本机监听端口。
- 尽量不要让多个端点复用同一个 `.xsh` 文件。
- 私钥、密码仍由 Xshell 管理；插件不需要写入密码。

### 3. 配置服务器

打开 VS Code 单项目工作区，然后打开 **SimpleExperiment > 设置 > 服务器**。

Hub 至少填写：

| 字段 | 示例 |
| --- | --- |
| 显示名 | `Lab-Hub` |
| Xshell 会话 | 选择已保存的 Hub `.xsh` |
| 本地转发端口 | `18765` |
| 远端 Agent 端口 | `18765` |
| 项目父目录 | `/data/experiments` |
| Conda 环境 | `ml-env`，留空表示系统 Python |

每台 Worker 另外配置：

| 字段 | 说明 |
| --- | --- |
| 本地转发端口 | 必须唯一，例如 `18766`。 |
| 项目父目录 | 通常与 Hub 相同，但必须按实际服务器填写。 |
| 并发占卡上限 | 该 Worker 同时允许被调度占用的 GPU 数。 |
| 允许 GPU ID | 留空不限制；也可填 `0,1,2,3`。 |
| tmux 前缀 | 多用户共用时改成用户短标识。 |

保存后点击 **检测全部**。只有 Hub 和所有启用 Worker 都可达且项目目录匹配，才算通过。

### 4. 准备 Agent

首次配置推荐点击“准备 Agent 并启动”。

未打开工作区时执行“准备 Agent 并启动”会直接打开 VS Code 文件夹选择器。

点击 **准备 Agent 并启动**。插件会按顺序：

1. 显示本地 `.xsh` 备份位置和远端 runtime 目标。
2. 写入受管 `RemoteCommand`，已有非 SimpleExperiment 登录命令时会停止而不是覆盖。
3. 通过 SimpleSFTP 上传 Agent runtime。
4. 打开对应 Xshell 会话。
5. 检测 Hub/Worker。

Agent runtime 位于 `<项目父目录>/simple_agent/runtime`，项目代码位于 `<项目父目录>/<本地工作区名称>`。

如果 Agent 版本更新，需要重启对应 Xshell 会话或 tmux 会话才能生效。

## 接入实验项目

推荐的本地结构：

```text
my_project/
  train.py
  test.py
  configs/
    smoke.yaml
    baseline.yaml
  experiments/
    plans/
      baseline.yaml
    results/
  work_dirs/
  paper/
    claims.md
```

最低可以只有可执行入口和一个 YAML Plan。结果目录默认是 `experiments/results/`。项目无需提供 `experiments/simple_project.yaml`；旧项目已有该文件时，插件仍兼容读取，但设置里的插件规则优先。插件不会在准备项目或校验 Plan 时自动创建该文件。

普通项目不必复制示例目录或添加论文文件。保留自己的入口、配置格式和命令参数，在 Plan 中写实际命令即可；`train_test` 只用于确实有独立测试步骤的项目，只有训练步骤时选择 `mode: train`。先通过“识别工作区”和“检查项目配置”核对入口，再校验、预演、提交。静态检查异步执行，重复点击共享同一次检查，只更新 `simple_cluster/check_reports/check-static-latest.md`。

现有 CSV/JSON 可在结果设置中指定候选文件、列映射和指标别名，不必为接入改写训练代码。启用 `distributedResults` 的多 Worker 项目默认将所有 Plan 的任务自动分布式派发；未配置 `distributed.planPrefixes` 时不限制 Plan 目录，校验和预演自动选择可用 Worker。只有明确配置 `planPrefixes` 时才限制范围，范围外保留单 Worker 提交流程。高级跨 Worker 产物合并仍需项目自己的汇总模块；非模型训练项目可在工作区设置中明确取消 checkpoint 要求，例如：

```json
"simpleExperiment.projectAdapterRules": {
  "distributedResults": true,
  "distributed": {
    "planPrefixes": ["experiments/plans/"],
    "checkpointRequired": false,
    "resultRowsPath": "metrics.csv",
    "fragmentPaths": ["metrics.csv"],
    "requiredPaths": ["metrics.csv"],
    "mergeModule": "project_tools.merge"
  }
}
```

`project_tools.merge` 是需要替换的项目模块名。此设置只取消默认 `best_model.pth` 要求，指标文件完整性与哈希校验仍生效；不配置时保留原来的模型产物契约。已有 `simple_project.yaml` 的项目也可在 `distributed` 段填写相同字段。

运行时状态尽量保存在内存中：已完成的历史 Plan 不再触发自动 Worker 进度请求；显式刷新仍核对所有 Worker。代码哈希缓存使用一个可复用暂存文件，成功发布后通过原子重命名消耗它，重试不会创建一串 UUID 临时文件。既有历史文件仍通过清理界面预览并两次确认后处理。

Plan 放在 `experiments/plans/`，默认目录由 `simpleExperiment.planDir` 控制。基础示例：

```yaml
suite: demo
base_config: configs/smoke.yaml
mode: train_test
seeds: [0]
runner:
  train_command: python train.py --config {config} --seed {seed} --output_dir {output_dir}
  test_command: python test.py --config {config} --seed {seed} --output_dir {output_dir}
naming:
  output_dir: "work_dirs/{case}/seed_{seed}"
cases:
  - name: smoke
    config: configs/smoke.yaml
paper:
  result_csv: work_dirs/{case}/seed_{seed}/metrics_summary.csv
```

首次运行建议选择小规模 smoke 配置。正式提交前，插件会自动校验、预演并显示 Plan、任务数、远端路径、Worker、Conda 环境、并发上限和预期结果位置。

## 运行实验

1. 在面板选择 Plan。
2. 点击 **校验并提交运行**。
3. 在强确认窗口核对远端路径、任务数、模式和 Worker。
4. 确认后插件自动同步代码到参与服务器。
5. 插件再次执行校验和预演。
6. 通过后才提交后台调度。
7. 在 **任务** 页查看排队、运行、日志、失败、停止和重试。
8. 任务结束后在结果文件区查看总表，需要逐 seed 数据时同步原始与详细表。

首次接入新项目时，建议先用小规模 Plan 校验命令和结果输出。运行入口只提交完整的正式 Plan。

任一任务明确失败或返回非零退出码后，调度器停止派发该 Plan 的其余任务，已运行任务继续执行到结束。失败任务的 tmux 窗口保留；同 GPU 的后续任务在新窗口运行。插件在检测到失败时提示一次；本机关闭期间发生的失败会在重连后补提示。只有手动点击“中止”才终止任务进程。

同一 Plan 有未结束任务时，重复提交会被阻止。修改 Plan 内容会产生新 revision，不会混用旧结果。

运行环境准备区提供两套互不冲突的范围设置。“设置上传文件范围”显示本机项目目录，用于补充发布代码和运行 Plan 的上传清单；文件和目录均可一次多选，也可设置扩展名与单文件大小上限、预览和移除路径。普通 YAML/JSON 配置无需在文件名中包含 config。“设置下载文件范围”先选择服务器，再显示其远端项目目录；可添加远端文件或文件夹，并独立设置下载扩展名与单文件大小上限。两套设置均保留项目边界、符号链接、`.env`、`.git`、`.vscode` 与插件状态目录保护。

旧的“设置跳过文件”和目标级忽略配置已彻底移除，不再读取或迁移。用户只需分别维护“设置上传文件范围”和“设置下载文件范围”；固定安全目录仍由插件内部保护。

## 结果文件

任务完成后，插件按 Plan 声明的路径解析结果，生成每个数据集的本机 `final` 总表与方法表。结果文件区首先显示这些表；需要核对逐 seed 或追溯文件时，可从数据集的“关联 Plan”打开“查看共享产物”，再到“高级来源”浏览该 Plan 的原始、详细和追溯文件。需要补充服务器文件时，使用“同步当前 Plan 原始与详细表”。PPT 绘图配置位于结果区底部的可选折叠项。

结果区的“结果总表”按实际目录识别数据集。插件按可信 Plan、case、seed、方法与端点，跨 Worker 去重后计算均值和样本标准差；每个数据集的总表位于 `<resultRoot>/<dataset>/final/final.csv` 与 `final.md`，方法表位于 `<resultRoot>/<dataset>/methods/<method>/<method>.csv/.md`。`resultRoot` 来自 `simpleExperiment.resultCsvDir`，默认 `experiments/results`。同一数据集可汇总多个 Plan，并保留 `plan_file` 来源；不同数据集独立保存。同 seed 指标或名称映射冲突会阻止整批覆盖，缺 seed 保留实际/计划数量。

结果区的“编辑列映射”会就地展开表单。优先选择 case、seed、指标名称、指标值；数据集、方法、训练比例和评估端点在“其他字段”。每个下拉项显示原始 CSV 列名和样例值，留在“自动识别”即可沿用当前识别结果。长表使用“指标名称＋指标值”两列，宽表将两项留空并自动识别数值列。需要 BA drop 等跨端点指标时，在“同 seed 配对派生指标”中明确填写指标、左右端点、倍率与输出列名；默认不计算。设置中还可配置候选结果文件、日志和指标别名。规则保存在当前工作区的 `simpleExperiment.projectAdapterRules` 设置中，并通过现有 Agent 隧道写入各 Agent 自有状态目录，供本机关闭后的自动解析使用。保存后点击“重建汇总”。缺少可信 case 或 seed 的行不会被猜测归入 Plan。

Plan 原始、详细与追溯产物进入 `<resultRoot>/<dataset>/plans/<plan-key>/{raw,detail,trace}/[<worker-key>/]`。Plan key 包含完整相对路径的稳定摘要，Worker key 也带身份摘要，防止同名覆盖。多数据集原始证据进入 `_shared`，缺数据集进入 `_unassigned` 并提示列映射；原始文件内容不改写。面板按“数据集 → 总表/方法表/Plans → 产物”展示，打开与拆表使用 catalog key 验证，拆表存入源表的 `by_<field>` 子目录。旧平铺结果保留，不自动迁移或删除；只有旧结构时显示只读兼容区。

Agent 的 Plan seed/final 表位于 `simple_cluster/results/by_plan/<plan-key>/datasets/<dataset-key>/`，项目表位于 `simple_cluster/results/by_dataset/<dataset-key>/`，论文表位于 `paper/tables/<dataset-key>/simple_results_table__<plan-key>.csv/.md`。summary 使用 `datasetResultTables`、`projectDatasetTables`、`paperDatasetTables` 并保留 Worker 所有权；旧 scalar 仅用于唯一数据集。统计 JSON 与 registry 可保留多数据集；PPT 必须选择一个数据集的表格。

“按列和值拆成子表”可选择 final 或任一方法表，选择拆表列，用搜索、逐项勾选、全选或取消批量选择词条，并可选择子表保留列。每个所选词条生成一张 CSV，放在所属表的 by_<列名> 子目录；例如按 rate_percent 选择 0、30、70、100 会得到四张子表。源表不改动。

原来的逐条“归档”和“删除”入口已从面板隐藏。旧归档仅改变旧统计流程纳入记录的状态；它不等于同步结果文件。现有质量门禁、旧统计、论文表格和部分 PPT 绘图仍依赖该旧状态，相关高级分析不能直接把新总表当作已归档记录。后台兼容命令保留，现有文件不受影响。

标准结果建议包含 `metrics_summary.csv`、`env_snapshot.json` 和 `config_snapshot.yaml`。详细契约见 [plugin-project-contract.md](docs/plugin-project-contract.md)。

## 设置参考

### 项目设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `topologyMode` | 空 | `single_worker`、`worker_pool` 或 `hub_worker`。 |
| `planDir` | `experiments/plans` | 相对工作区的 Plan 目录。 |
| `codeSync.includePaths` | `[]` | 运行 Plan 前额外上传的本机文件或目录，在“设置上传文件范围”中维护。 |
| `codeSync.allowedExtensions` | 常见源码与配置类型 | 上传范围内允许的扩展名；可交互修改，`*` 表示任意类型。 |
| `codeSync.maxFileSizeMB` | `2` | 上传范围内单文件大小上限，单位 MB，可交互修改。 |
| `resultCsvDir` | `experiments/results` | 新任务的结果 CSV 默认目录。 |
| `projectAdapterRules` | `{}` | 当前工作区的输出接入、指标别名和列映射，由面板交互式设置。 |
| `remote.allowedRoots` | 空 | 允许作为远端项目父目录的前缀白名单。 |
| `remote.deniedRoots` | 空 | 明确禁止的父目录前缀，优先级高于 allowed。 |
| `simpleExperiment.showAdvancedCommands` | `false` | 在命令面板显示旧兼容和诊断命令。 |

### 连接和隧道

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `connectionMode` | `xshell_tunnel_realtime` | 正常使用保持实时隧道。`offline_import` 只导入离线包。 |
| `tunnel.localForwardPort` | `18765` | Hub 的本机监听端口。 |
| `tunnel.remoteAgentPort` | `18765` | Hub 远端 Agent 端口。 |
| `tunnel.agentToken` | 空 | 可选共享 token；所有 Agent 使用同一值。不要写入项目文件。 |
| `tunnel.remoteTmuxSessionPrefix` | `simple` | 远端 tmux 前缀，只允许小写字母、数字、点、下划线和连字符。 |
| `tunnel.condaEnv` | 空 | 全局默认 Conda 环境。空值不激活 Conda。 |
| `tunnel.workerRealtimeMode` | `hub_only` | `hub_plus_workers` 时同时连接已配置的 Worker 实时通道。 |
| `workspaceHostRoot` / `workspaceContainerRoot` | 空 | 仅 Dev Container 工作区映射需要。 |

### Worker 配置

Worker 推荐在面板卡片中配置。底层设置是 `tunnel.workerTunnels` 数组，常用字段：

| 字段 | 说明 |
| --- | --- |
| `id` / `displayName` | Worker 标识和显示名。 |
| `savedSessionPath` / `.xsh` | 对应 Xshell 会话。 |
| `localForwardPort` | 本机唯一监听端口。 |
| `remoteTelemetryPort` / `remoteAgentPort` | 服务器上 `127.0.0.1` 的 Agent 端口。 |
| `agentProjectDir` | 项目父目录；插件自动追加当前工作区名。 |
| `condaEnv` | Worker 环境覆盖全局设置；`-` 视为未配置。 |
| `maxConcurrentGpus` | 同时占卡上限，默认 `1`。 |
| `allowedGpuIds` | 允许调度的 GPU 列表。 |
| `enabled` | 是否参与检测、运行和监控。 |

### 调度与上报

这些参数用于降低高频请求风险，通常保留默认值。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `scheduler.pollSeconds` | `60` | 调度轮询基准秒数，最小 60。 |
| `scheduler.jitterSeconds` | `30` | 正向随机抖动。60+30 表示实际间隔约 60-90 秒。 |
| `scheduler.workerStatusTtlSeconds` | `180` | availability 缓存 TTL，不是轮询间隔。 |
| `scheduler.localAvailabilityPushSeconds` | `60` | 本机向 Hub 上报可用性的基础间隔。 |
| `scheduler.workerAvailabilityPushSeconds` | `60` | Worker 向 Hub 上报的基础间隔。 |
| `scheduler.operationEventMaxDelayMs` | `1000` | 操作事件最大合并延迟。 |
| `scheduler.workerActionMinIntervalMs` | `1500` | 同一 Worker 控制动作最小间隔。 |
| `scheduler.workerActionMaxConcurrent` | `1` | 同一 Worker 控制动作并发上限。 |

### GPU 高亮

| 参数 | 说明 |
| --- | --- |
| `gpu.currentUser` | 服务器上的用户名，用于高亮自己的进程。 |
| `gpu.currentUserAliases` | 其他用户名别名。 |
| `gpu.myCommandKeywords` | 命令行关键词，例如项目名或脚本名。 |
| `gpu.myProcessMatchMode` | `username`、`command_contains` 或 `both`。 |

### PPT 和界面

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `ppt.chartType` | `auto` | 交给 PPT 插件按契约选择图型。 |
| `ppt.styleMode` | `activePpt` | 使用当前 PPT 方案。 |
| `manualPanelLayout` | `false` | 启用手动排序。 |
| `panelSectionOrder` | 空 | 手动分区顺序。 |

## 安全边界

- 所有 Agent API 访问目标是本机 `127.0.0.1`。
- 文件传输必须经过 SimpleSFTP 的路径确认门禁。
- 危险操作、正式运行和覆盖 GitHub 操作需要显式确认。
- 远端删除只允许项目内托管产物，不会删除数据集、checkpoint、模型缓存等大资产。
- 旧 Debug 记录只供历史追溯；新提交会拒绝 Debug 运行参数。
- 插件不会把 token、密码或私钥写入项目文件。
- `remote.deniedRoots` 命中的路径会被拒绝；真实路径和符号链接逃逸也会被检查。

## AI / SKILL 使用约束

如果让 Codex、Claude 或其他 AI 操作本插件，建议把本节内容加入项目的 `AGENTS.md`、全局 `SKILL.md` 或 MCP 工具说明。推荐安装或维护一个名为 `simple-local-api` 的本地技能；没有该技能时，至少把以下规则原样交给 AI。

### 必须先发现，不能猜接口

- 每个工作会话开始前先运行自检：

```powershell
simpleex self-check
simple-sftp-api self-check
simpleex api status
simple-sftp-api status
```

- 地址和 token 必须每次读取：
  - `%APPDATA%\SimpleExperiment\api.json`
  - `%APPDATA%\SimpleSFTP\api.json`
- 不要硬编码 `19765` 或 `19766`；端口冲突时会顺延。
- 修改任何配置或执行远端操作前，先读取：
  - `GET /api/v1/capabilities`
  - `GET /api/v1/openapi.json`
  - SimpleExperiment 的 `actions.list`
  - SimpleSFTP 的 `status`、`servers.list`、`target.show`

### 实验必须走标准工作流

研究型工作区包含 `experiments/plans/`、`experiments/simple_project.yaml`、`paper/claims.md` 或 `docs/project-constraints.md` 时，AI 应先读项目契约，再按以下顺序操作：

1. 确认 Plan 和实验配置已存在。
2. 调用 SimpleExperiment `workflow.plan`。
3. 只执行返回值里的唯一 `nextAction` 和对应 `calls`。
4. 修复阻塞后重复 `workflow.plan`，直到 `ready: true`。
5. 再调用 `workflow.run`。
6. 用 `operations.list` 查进度；用 `tasks.list`、`gpu.list`、`gpu.history`、`live.output` 监控。

不要从源码反推调用链，也不要绕过 `workflow.plan -> workflow.run` 直接拼内部命令。只有 `workflow.plan` 明确路由到某个低层方法，或用户明确要求单独操作时，才使用低层 API。

### 文件传输边界

- 项目代码、runtime、日志包和结果文件传输只能通过 SimpleSFTP API。
- 禁止用 `scp`、`rsync`、临时 SSH 命令或自写脚本替代插件传输。
- 上传目标以 SimpleExperiment 当前解析的远端根目录为准：API 显式路径优先于用户保存配置，禁止根据服务器名推断路径。
- 传输前必须展示本机路径、服务器身份和完整远端路径。

### 确认门禁

- 配置写入、上传、下载、运行、停止、归档、删除、部署 runtime 和覆盖 GitHub 都是受门禁操作。
- 缺少确认时 API 返回 code `2001`、message `CONFIRM_REQUIRED`，并在 `error.data` 中给出目标预览。
- `CONFIRM_REQUIRED` 不是错误重试信号；AI 应把预览展示给用户，等用户明确批准后才能传 `confirm: true`。
- SFTP 路径动作还需要 `pathConfirmed: true`，或存在完全一致的既有免提醒记录。
- AI 不能自行补 `confirm: true` 或 `pathConfirmed: true` 来绕过弹窗和人工核对。

### 安全与调试限制

- discovery 文件里的 token 是机密；只能在当前命令会话使用，不能打印、提交或写入项目文件。
- 校验、预演和能力检查不得顺带启动隧道、上传文件、提交计划或调用 PPT automation。
- 诊断调试包与运行模式独立，仍可用于故障排查。
- 远端根目录必须遵守 `remote.allowedRoots` 和 `remote.deniedRoots`。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 本地端口未打开 | Xshell 会话是否启动，隧道是否保存为本机 `127.0.0.1`。 |
| Agent 不可达 | 本机端口、远端端口、Agent token 和 tmux 会话是否一致。 |
| Agent 版本不匹配 | 点击部署后重启 Xshell/tmux，再执行检测全部。 |
| 项目目录不匹配 | “项目父目录 + 当前工作区名”是否就是 Agent 报告的项目路径。 |
| Worker 可用性缺失 | 保持 Worker 隧道在线；新 runtime 会做有界刷新。 |
| 未配置 condaEnv | 在 Worker 卡片填写环境名；`-` 不是有效环境名。 |
| PyYAML 缺失 | 在对应 Conda/system Python 中安装 `PyYAML`。 |
| 上传很慢或失败 | 检查 ignore 规则是否排除了大数据集和 checkpoint；确认 SimpleSFTP 目标路径。 |

更多历史细节和架构说明见 [docs/technical-notes.md](docs/technical-notes.md)。开发和研究项目契约见 [docs/testing.md](docs/testing.md)、[docs/architecture.md](docs/architecture.md) 和 [docs/plugin-project-contract.md](docs/plugin-project-contract.md)。
