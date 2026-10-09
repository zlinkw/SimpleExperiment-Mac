# SimpleExperiment

本插件面向 `Xshell 隧道 + Hub/Worker Agent + SimpleSFTP` 架构。

核心原则只有三条：

1. 本机到远端的所有访问都只走本机 `127.0.0.1:<localPort>` 隧道，不在插件内直接发起远端 SSH、SCP、RSYNC。
2. 实时状态、任务控制、操作进度走 Agent 实时通道。
3. 真实文件上传和下载只走 `SimpleSFTP`，不用它做心跳、日志流或实时控制。

长期开发批次状态保留在本地开发环境和 git 提交记录中，不作为公开发布文档分发。公开架构边界见 [architecture.md](architecture.md)。

## 插件能做什么

SimpleExperiment把一个本地 VS Code 项目接到多台 GPU 服务器上，用于完成从代码发布、Agent 管理、GPU 状态监控、实验计划运行、任务状态查看、结果解析、质量检查、论文证据追踪到归档删除的闭环。

插件默认假设用户在本机使用 VS Code 写代码，在 Hub 上做调度与全局索引，在 Worker 上运行真实实验。Hub 和 Worker 的 Agent 都运行在远端服务器本机，VS Code 只通过用户已经配置好的 Xshell 本地隧道访问 `127.0.0.1:<localPort>`。代码、日志包、结果和 manifest 等真实文件传输交给 `SimpleSFTP`，实时状态与手动控制交给 Agent。

插件不要求所有项目一开始就按固定模板开发。推荐做法是先让插件自动识别项目入口、配置、结果文件和控制台指标；识别不足时，通过“实验准备”里的接入模板生成轻量 adapter，再由用户把训练或测试输出映射到标准结果契约。

核心能力：

- 管理 Hub / Worker 的 Xshell 隧道会话、Agent 随隧道启动命令、端口分配和端口冲突。
- 展示 Hub、Worker、GPU、任务、计划、结果、操作进度和通信风险。
- 区分 GPU 空闲、占用、高显存、高负载、共享占用和“我在用”。
- 发布当前项目到 Hub / Worker，首次上传、分发代码、部署最新版 Agent。
- 校验与预演实验计划；单计划、复现和批量运行前都会自动同步代码、校验代码指纹，并重新执行校验与预演后再提交。
- 查看任务运行状态、实时日志尾部、停止、重试、删除、归档准备。
- 解析 `metrics_summary.csv`、结果 CSV / JSON、控制台输出和文本 summary。
- 生成质量门禁、统计摘要、论文表格和 claim 证据状态。

## 从零开始使用

推荐按下面顺序接入新设备和新项目。每个 VS Code 窗口只打开一个实验项目；检测到多根工作区时，项目接入、Agent 路径写入、SFTP 上传和远端实验操作都会在产生副作用前阻断，避免把首个工作区目录误当成目标项目。切换工作区目录时，插件会清空上一项目的 Plan 选择、任务选择、结果摘要、离线覆盖、同步状态和操作记录，再从新项目的 `simple_cluster/ui/` 重新加载；全局 Hub/Worker 与 Xshell 设置保持不变。旧项目尚未完成的项目状态文件回读、检测或实时回调都会被丢弃，不会覆盖新项目状态。

命令面板可直接使用“SimpleExperiment：检查服务器配置”“SimpleExperiment：接入当前项目”和“SimpleExperiment：准备 Agent 并启动”。未打开工作区时执行“接入当前项目”或“准备 Agent 并启动”会直接选择本地单项目并自动续接；“检查服务器配置”只校验现有配置并把缺口定位到“设置 > 服务器”，不从零初始化服务器。默认列表只保留新项目主流程以及配置 Xshell、Worker、端口、启动全部连接和检测全部等常用入口；旧自动隧道、单端点启动、实时流和诊断恢复命令仍保持注册及原有 handler，需要时可在插件面板“设置 -> 高级命令 -> 打开命令设置”中启用 `simpleExperiment.showAdvancedCommands` 重新显示。“启动全部 Xshell 连接”只打开现有会话，不会部署或改写 Agent。打开面板时，已完成服务器配置的项目会自动检测 Hub/Worker，无需每次重载后手动点击“检测全部”。检查流程会先阻止缺少 `.xsh` 会话的配置继续进入 Agent 部署，并在仅有 Hub时直接前往服务器设置；完全没有 Plan 和既有项目状态的新项目从“接入当前项目”确认会话前缀、完成服务器配置或 Agent 准备后，会继续提供“Debug 首跑”或“正式运行”两个明确选择，不必重新寻找运行入口。计划模式区不会自动替用户切换正式或 Debug；当前 Plan revision 尚无运行证据时，项目关键入口和运行区会同时提供“Debug 首跑”与“正式运行”，每个按钮直接携带对应模式，避免全局模式与提交参数不一致。Debug 完成后提示先复核日志再正式运行；已有当前 revision 运行证据、运行中及历史任务继续使用原流程。手动保存 Hub 或 Worker 后会显示最终代码与 runtime 位置，并按当前完整度提供下一步。新项目显示“可提交”前还会检查配套 SimpleSFTP 是否安装并声明 `uploadWorkspace`、`uploadFiles`、`configureIgnores` 三个编排命令；缺失或版本过旧时直接显示“待安装 SimpleSFTP”并打开配置说明，不会等到上传阶段才失败。

未打开工作区时从命令面板执行“接入当前项目”或“准备 Agent 并启动”，选择一个本地项目文件夹后会等待工作区状态刷新并自动继续原流程，不需要再次点击命令。取消选择、仍未打开项目或选择多根工作区时会停止在当前步骤，不会写入项目文件、上传代码、部署 Agent 或提交实验。

首次启动提示同时检查服务器配置、启用 Worker 与配套 SimpleSFTP。SimpleSFTP 缺失或 ABI 过旧时，提示会直接说明文件传输依赖，并提供配置说明和扩展管理入口；服务器或 Worker 不完整时直接前往“设置 > 服务器”，不在弹窗里从零填写；三项均就绪时不重复提示，用户中途取消后下次启动仍会继续引导。直接从命令面板运行“检查服务器配置”或“准备 Agent 并启动”也使用相同门禁。部署 Agent、代码同步、忽略规则和运行前自动同步会在同步 Xshell 配置或写共享目标前再次执行该门禁；依赖未就绪时不会修改 `.xsh`、启动会话、显示上传开始或写入远端。独立的“启动连接”和“写入 Agent 自启动命令”仍可用于不涉及文件上传的故障恢复。配置说明在服务器已配置但尚未打开项目时提供“选择项目并继续”，选择后自动回到说明并判断下一步，不需要重新打开面板。

当前项目完全没有 Plan 时，“接入当前项目”先执行无写入基础设施门禁：确认 SimpleSFTP、Hub/Worker Xshell 会话、服务器项目父目录和至少一个执行 Worker 均已就绪，才允许进入 Plan 与接入模板生成。用户选择“稍后”、取消配置或基础设施仍不完整时，不会先在项目里留下半成品 Plan、adapter 或 claims 文件。已有 Plan 的项目不走该门禁，现有任务、结果和失败恢复仍按原生命周期优先显示。

“打开配置说明”在展示 Markdown 预览后会按当前状态只提供一个主动作：服务器未完成时打开服务器设置，仅有 Hub 时打开服务器设置，未打开工作区时选择项目并继续，服务器和项目都就绪时直接接入当前项目。“打开面板”始终作为次要入口。服务器配置固定在“设置 > 服务器”手动维护；项目接入弹窗只确认 tmux 会话前缀等项目参数，不从零初始化服务器。

从配置说明完整完成 Agent 准备或成功添加 Worker 后，流程会重新判断当前状态并继续提供下一个唯一动作，最多连续推进四步。一键配置或手动保存服务器后的“选择项目并继续”会保留配置后半程；选择“稍后”、仅保存部分配置、取消操作、状态没有变化、接入项目或打开面板时立即停止，不会覆盖用户的暂停选择、重复弹出同一个问题或形成无限循环。

“发布同步”流程的 Agent 步骤直接读取 Hub/Worker 检测结果，显示“已就绪”“需升级”“待重启”“项目不匹配”或“待检测”，不会在 Agent 已可用时继续显示固定警告。

未手动上传代码不再显示为首屏阻塞。运行确认后会自动生成代码指纹，并同步 Hub 与参与 Worker；只有明确返回失败或错误时，概览才显示“代码同步失败”并要求处理。

未提前执行校验或预演时，运行门禁显示“自动校验预演”，不再显示为黄色待处理项。“校验并提交运行”会按顺序自动校验和预演；“单独校验”“单独预演”只用于提前排查，已有失败结果仍显示红色并保留原因。

选择 `Debug` 后，当前 Plan 的运行按钮统一显示“Debug 运行”；切回正式模式后恢复各入口原文案。Debug 已完成时提供的“正式运行”保持固定，不会被当前模式标签覆盖。

概览中的“结果证据”不会在空项目上显示“闭环”。它按真实状态显示待运行、等待任务结果、待筛选、有效结果数量、未发现结果或解析失败；只有已归档记录才计为有效结果。

编辑当前 Plan 会生成新 revision。插件会立即隐藏同一路径下旧 revision 的结果摘要、输出契约、统计、Case 分析、异常诊断和 PPT 绘图入口，并且不会在保存后自动把旧输出重新解析成新 revision；新版本已有真实运行或当前 revision 已有手动解析摘要时，结果文件变化才恢复自动解析。重新运行并解析新版本后才恢复分析入口，避免旧实验结论被误当成当前 Plan 证据。

面板顶部长期保留“接入当前项目”。新项目和已有项目都可重复执行；插件只补齐缺失 Plan 或接入规则，再根据当前服务器、Agent 与结果门禁状态给出唯一修复动作。当前 Plan revision 在所有条件就绪但尚无运行证据时，项目状态显示“建议 Debug 首跑”，并同时提供“Debug 首跑”与“正式运行”；已有当前 revision 运行证据时保持原“校验并提交运行”入口。项目关键入口默认只展示 Plan、配置、入口、结果与状态，环境、服务器、连接和代码同步操作收在可展开详情中，功能不减少。接入提示直接显示当前第一项真实缺口，不再只显示“若干项”；Plan 已声明可解析结果位置时不会误提示必须生成 `experiments/simple_project.yaml`。多 Plan 项目未明确选择时只提示先选择；选择后，接入缺口和不可解析结果提示只读取当前 Plan 与项目级共享规则，其他 Plan 的输出或预览不会掩盖当前缺口。入口状态条的“结果与归档”阶段与结果工作台共用同一顺序，依次显示待解析、待筛选或归档、质量门禁、统计、论文证据、论文表格、PPT 绘图契约和可绘图；仅存在有效结果时不会提前显示为闭环完成。
项目关键入口首行持续显示当前本地项目名和路径；检测到多根工作区时明确显示文件夹数量与远端操作阻断原因，避免把错误项目上传或启动 Agent。远端上传位置仍按服务器父目录与当前项目名计算，并在“上传位置”详情和强确认窗口中再次展示。

项目关键入口使用“打开配置”“训练”“评估”等明确动作，路径仍显示真实文件；运行时自动同步统一显示“代码指纹”，不会改变配置、入口或 fingerprint 的内部兼容值。

1. 安装 `SimpleExperiment` 与 `SimpleSFTP`。
2. 在 Xshell 中为 Hub 和每台 Worker 准备 `.xsh` 会话，配置本地端口转发。
3. 打开 VS Code 工作区，也就是你的项目根目录。
   已先完成一键配置但尚未打开项目时，向导会提供“选择项目并继续”，选择后自动生成当前项目目标并继续后续配置。
4. 打开“SimpleExperiment”面板，进入“服务器管理”。
5. 配置 Hub、Worker、项目父目录、Xshell 隧道会话、本机端口和远端端口。
6. 配置每台 Worker 的 `maxConcurrentGpus` 和 `allowedGpuIds`。
7. 配置“调度与上报策略”，默认保持 `60s + jitter` 即可。
8. 一键配置会检查 Hub/Worker 的 `.xsh` 会话、项目父目录、至少一个执行 Worker、本地端口冲突、会话复用、端口参数和非回环转发；缺失或冲突时按唯一下一步补齐。随后点击“准备 Agent 并启动”，一次完成受管自启动命令、runtime 部署、Hub / Worker Xshell 会话启动和连接检测。
9. 点击“检测全部”，确认 Hub 与 Worker 均为可用状态，且 Agent 返回的项目目录等于 `<项目父目录>/<当前 VS Code 工作区名>`。
10. 点击面板顶部或“实验准备”中的“接入当前项目”；插件会选择或创建 Plan，并仅在缺少接入配置时生成输出模板。
11. 按项目入口给出的唯一下一步检查当前 Plan；已有 `experiments/simple_project.yaml` 时直接打开原配置补充结果捕获规则，不重复生成模板。
12. 确认“结果位置”显示当前 Plan 或接入规则声明的真实候选路径，并确认运行门禁通过；首次运行不要求预先存在结果文件。
13. 点击“校验并提交运行”，先确认 Plan、模式、任务数、配置和 Worker；确认后插件才同步代码到 Hub 和参与 Worker，再校验、预演并启动调度。
14. 在“任务运行状态”和“操作进度”里查看运行、停止、删除、归档和失败原因。
15. 在“结果与归档”里解析结果、检查质量门禁、导出论文表格和 claim 证据。

如果某一步不可用，右侧工作详情和诊断区会显示中文原因。常见原因包括：隧道端口未启动、Agent 版本不匹配、缺少接入配置且 plan / 结果未声明、未发现结果捕获规则、Worker 不可达、任务缺少可操作标识。

## 推荐项目组织方式

插件把当前 VS Code 工作区视为一个实验项目。项目名默认使用工作区目录名，并会同步到每台服务器的：

```text
<项目父目录>/<当前 VS Code 工作区名>
```

每台服务器还会使用独立的 Agent 目录：

```text
<项目父目录>/simple_agent
```

推荐本地项目结构：

```text
my_project/
  README.md
  requirements.txt 或 environment.yml
  train.py
  test.py
  configs/
    baseline.yaml
    ablation.yaml
  scripts/
    train_baseline.ps1 或 train_baseline.sh
  experiments/
    plans/
      smoke.yaml
      main.yaml
    simple_project.yaml
    simple_adapter/
      result_writer.py
      run_wrapper.py
      collect_results.py
      console_parser.py
      factory_hooks.py
    results/
      metrics_summary.csv
      metrics_case.csv
  paper/
    claims.md
  work_dirs/
    run_001/
      metrics_summary.csv
      env_snapshot.json
      config_snapshot.yaml
      artifact_manifest.json
```

最低可运行结构有两条路径。`experiments/simple_project.yaml` 是推荐接入配置，不是最低必需文件。

Plan 直连路径：

```text
my_project/
  train.py 或 test.py
  experiments/
    plans/
      smoke.yaml
```

接入模板辅助路径：

```text
my_project/
  train.py 或 test.py
  experiments/
    plans/
      smoke.yaml
    simple_project.yaml
    simple_adapter/
      result_writer.py
      run_wrapper.py
```

最低可解析结果结构同样有两条路径。已有结果文件可直接被识别；需要控制台捕获、指标别名或工厂模式 hook 时，再生成接入模板。

已有结果文件路径：

```text
my_project/
  work_dirs/
    run_001/
      metrics_summary.csv
```

接入模板辅助结果路径：

```text
my_project/
  experiments/
    simple_project.yaml
  work_dirs/
    run_001/
      metrics_summary.csv
```

插件会自动识别常见目录和文件：

- 入口：`train.py`、`test.py`、`main.py`、`run.py`、`scripts/*.py`、`experiments/*.py`
- 配置：`configs/`、`config/`、`conf/`、`cfg/`、`experiments/configs/`、`experiments/config/` 下的 YAML、JSON、Python 配置，以及项目根目录常见的 `config.*`、`hparams.*`、`params.*`、`settings.*`
- 环境：`environment.yml`、`requirements*.txt`、`pyproject.toml`、`Pipfile`、`uv.lock`、`poetry.lock`、`requirements/` 下的依赖清单
- 结果（标准）：per-job `metrics_summary.csv` + `metrics_case.csv`，最终大表 `experiments/results/<method>.csv`；历史兼容（`results.csv`、`metrics.csv`、`summary.csv`、`classification_report.csv` 等）仅识别红单参考，不作新标准。
- 日志（标准）：per-job `stdout.log` + `stderr.log`；历史兼容（`train.log`、`test.log`、`summary.txt` 等）仅识别红单参考。
- 命令形态（MultiModal 对齐）：train 仅 `--output-dir`，test 双写 `--output-dir {output_dir} --result-csv {result_csv}`；试探输出先落 `tmp/`，确认后转正。
- 轻量结果目录：`experiments/results`、`work_dirs`、`outputs`、`runs`、`logs`、`results`、`test_results`

默认不会把 `datasets`、`checkpoints`、`weights`、`pretrained`、`.git` 等大目录作为结果下载或轻量同步目标。需要保留大文件时，应在 SimpleSFTP 或项目自己的数据管理流程中单独处理。

## 实验计划组织

实验计划默认放在：

```text
experiments/plans/
```

该目录由 `simpleExperiment.planDir` 控制。计划文件建议按用途拆分：

```text
experiments/plans/
  smoke.yaml          # 小规模连通测试
  baseline.yaml       # 主基线
  ablation.yaml       # 消融
  sensitivity.yaml    # 参数敏感性
  external.yaml       # 外部验证
```

计划应描述实验套件、基础配置、运行命令、种子、实验 case、输出目录和结果文件。当前插件把“通用外部项目 Plan”和“插件生成调度 Plan”合并到同一套共享契约：调度主格式固定为 `suite / base_config / mode / seeds / paper / runner / naming / cases`，外部字段只作为兼容别名进入同一主线。也就是说，README 里旧式 `name / experiments / command / outputDir / expectedResults` 写法不是另一套执行系统，而是会被规范化到同一个调度模板后再运行。

- `cases`：插件生成的调度计划主格式，推荐用于 Hub scheduler。
- `experiments`：通用外部项目格式，适合从旧计划或其它工具迁移；插件会把其中的 `id`、`name` 或 `case` 识别为同一个实验 case 名。

推荐共享模板如下。`case`、`name`、`id` 三者任选其一即可；极简计划也可以在 `cases` / `experiments` 下直接写标量项，例如 `- baseline` 或 `cases: [baseline]`，但多配置、多输出目录或自定义命令建议使用对象写法。`seeds` 统一放在顶层，由 scheduler 展开，不建议再把 `seed` 写入 case 级 `overrides`。单个 case 可以覆盖 `base_config` / `config`、`outputDir` / `output_dir`、`runner.train_command` / `runner.test_command`，也可以直接写 `command`、`train_command` 或 `test_command`。命令模板支持 `{config}`、`{config_path}`、`{base_config}`、`{base_config_path}`、`{suite}`、`{case}`、`{name}`、`{id}`、`{seed}`、`{index}`、`{job_name}`、`{experiment_name}`、`{output_dir}`、`{outputDir}`、`{result_csv}`、`{resultCsv}`、`{worker_id}`、`{gpu_ids}`、`{mode}`、`{plan}` 和 `{plan_file}`。

单实验计划可以省略 `cases` / `experiments`。此时插件和 scheduler 会生成一个默认 case：优先使用顶层 `case`、`name` 或 `id`，都没有时使用 `baseline`。这样旧的单文件外部计划只要有 `base_config` 和运行命令，也能在计划列表、注册表和远端调度中显示为 1 个实验，而不是 0 个实验。

共享字段映射规则如下，插件生成模板和外部导入计划都会按这套规则进入同一调度主线：

| 通用外部字段 | 插件调度字段 | 实际含义 |
| --- | --- | --- |
| `name` / `id` / `case` / 标量列表项 | `cases[].case` | 实验 case 名。可以不写在列表第一行，但必须是当前实验条目的第一层字段；`- baseline` 和 `cases: [baseline]` 这类标量项只适合无额外覆盖的极简 case。 |
| `experiments` | `cases` | 外部计划列表别名。调度前会规范化为 case 列表。 |
| `command` | `runner.train_command` | 训练命令简写。case 级 `command` 会覆盖顶层 `command` / `runner.train_command`；同一 case 内显式 `train_command` / `runner.train_command` 优先于 `command`。测试命令请使用 `test_command` 或 `runner.test_command`。 |
| `outputDir` / `output_dir` | `output_dir` | 当前 case 输出目录，可使用模板变量。 |
| `expectedResults` / `expected_results` / `resultFiles` | 结果候选 | 运行门禁和结果解析线索，不会被误当作 case 名。 |
| `base_config` / `config` | `base_config` 或配置补丁 | 字符串表示当前 case 的配置文件；对象表示叠加到当前 base config 的 case 级配置补丁。 |

```yaml
suite: smoke_classification
description: 小规模分类烟测
mode: train_test
base_config: configs/smoke.yaml
seeds: [1, 2]
paper:
  result_csv: experiments/results/smoke_classification.csv
runner:
  train_command: "python train.py --config {config} --seed {seed} --output-dir {output_dir}"
  test_command: "python test.py --config {config} --seed {seed} --output-dir {output_dir} --result-csv {result_csv}"
naming:
  sweep_dir: work_dirs/multirun/{suite}
  job_name: "{index}_{case}_seed{seed}"
cases:
  - case: resnet50
    method: resnet50
    dataset: demo
    split: test
    overrides:
      model.name: resnet50
  - name: convnext_tiny
    base_config: configs/convnext.yaml
    outputDir: work_dirs/custom/{name}_seed{seed}
    runner:
      train_command: "python train.py --config {config} --model convnext_tiny --seed {seed} --out {outputDir}"
    expectedResults:
      - work_dirs/custom/{name}_seed{seed}/metrics_summary.csv
```

如果已有通用外部项目计划，也可以继续使用 `experiments`：

```yaml
suite: smoke_classification
base_config: configs/smoke.yaml
seeds: [1]
experiments:
  - id: smoke_resnet50_seed1
    command: "python train.py --config {config} --seed {seed} --output-dir {output_dir}"
    outputDir: work_dirs/smoke_resnet50_seed1
    expectedResults:
      - work_dirs/smoke_resnet50_seed1/metrics_summary.csv
```

插件生成的 Plan 模板会直接使用 `suite / base_config / mode / seeds / paper / runner / naming / cases`，并默认生成 `paper.result_csv`、`runner.train_command`、`runner.test_command`、`naming.sweep_dir`、`naming.job_name`、case 级 `outputDir` 和 `expectedResults`。外部计划迁移时不需要一次性重写字段，但建议最终收敛到同一共享模板，避免多配置实验被错误套用顶层配置。外部 `experiments` 列表中即使先写 `command`、`outputDir` 或 `expectedResults`，再在后续行写 `case`、`name` 或 `id`，插件也会把它识别为同一个实验 case。`PlanBuilder.parsePlanCases()` 只读取 `cases` / `experiments` 当前实验条目第一层的 `case`、`name`、`id`、顶层标量项或 inline flow-list 项，不会全文件扫描；即使计划没有真实 case，`expectedResults` 内部的 `id` / `name` 也不会被误当成实验 case。YAML flow map 写法如 `{id: smoke, command: ...}` 和 inline 列表写法如 `cases: [baseline, {id: smoke}]` 也会被识别。运行门禁只读取未注释的真实输出字段；注释里的 `metrics_summary.csv` 不算证据。对象式 `expectedResults` 只读取 `path`、`file`、`result_csv`、`resultCsv`、`metrics_csv` 等结果路径字段，不读取 `id`、`name`、`note` 这类说明字段。

多 Plan 项目中，各 Plan 声明的输出候选只用于自身运行门禁和本地结果发现，不会被提升为全局接入规则去放行另一个缺少输出契约的 Plan；用户明确保存的 `experiments/simple_project.yaml` 规则，以及由项目代码、配置或工厂模式证据推断出的通用规则，仍作为项目级共享规则。

项目接入中的本地“结果解析预览”按当前 Plan 的结果模板与项目级共享规则筛选。切换 Plan 后只显示匹配候选，并明确标出隐藏的其他 Plan 候选数量；运行工作台的预览计数和输出门禁使用同一筛选结果。

一键运行计划前会自动执行：

1. 计算本地代码指纹。
2. 同步当前项目到 Hub。
3. 同步当前项目到本次参与 Worker。
4. 回读远端 `simple_cluster/code_sync_state.json`。
5. 代码指纹全部一致后才校验和运行计划。

Plan 允许实验数量超过 Worker 的全局 GPU 上限。`maxConcurrentGpus` 只限制同一 Worker 同时被插件占用的 GPU 数，不限制 queued 队列长度。GPU 释放后调度器会继续消费队列。

## 项目接入成功标准

项目接入区的五个阶段会突出当前待处理阶段，点击阶段可直接定位到对应的设置、Plan、连接、运行进度、任务或结果区域；实际执行仍以“下一步”唯一动作和门禁为准。

一个项目要和插件完整对接，至少需要满足三类条件。

### 1. 入口可识别

插件需要知道实验怎么启动。可通过以下方式之一提供：

- 项目根目录存在 `train.py`、`test.py`、`main.py` 或可识别脚本。
- `experiments/plans/*.yaml` 中写明 `command`。
- `experiments/simple_project.yaml` 中写明入口命令模板。
- “生成 Plan 模板”后手动补齐命令。

### 2. 输出可捕获

插件需要知道结果在哪里。可通过以下方式之一提供：

- 实验输出 `metrics_summary.csv`。
- 实验输出可解析 CSV / JSON。
- 控制台日志中有可解析指标，例如 `AUC: 0.932 accuracy: 89.5% F1=0.88`。
- `experiments/simple_project.yaml` 中写明 `candidateCsv`、`candidateJson`、`consoleLogs`、`textLogs` 或 `metricRegex`。
- 使用 `experiments/simple_adapter/run_wrapper.py` 捕获原始命令输出并归一化。

### 3. 证据可追踪

插件需要能把结果、产物和论文 claim 对上。推荐提供：

- `experiment_id`
- `suite`
- `method`
- `dataset`
- `split`
- `seed`
- `metric`
- `value`
- `artifact_manifest.json`
- `paper/claims.md`

缺少这些字段不会阻止所有功能，但会降低统计、归档、论文表格和 claim 证据检查的可用性。

## 安装即用边界

VSIX 内置以下内容：

- Hub / Worker Agent runtime。
- 调度 runtime。
- 项目输出接入模板。
- 结果契约文档模板。
- 论文 claim 模板。
- Webview UI 与本地命令处理逻辑。

因此在另一台电脑安装插件后，不需要克隆本插件源码仓库，也能执行：

- 打开面板。
- 配置 Xshell 会话和端口。
- 部署最新版 Agent 到 Hub / Worker。
- 生成项目接入模板。
- 保存 `experiments/simple_project.yaml`。
- 同步项目代码。
- 检测 Hub / Worker。

仍然需要用户提前准备：

- VS Code 工作区。
- Xshell 客户端与 `.xsh` 会话。
- 远端 Python 环境。
- Hub / Worker 上用于存放项目的可写父目录。
- `SimpleSFTP` 插件。
- 数据集、权重、checkpoint 等大文件的外部存放方式。

## UI 交付原则

最终版 UI 必须首先保证美观、直观、易用，并以中文母语表达为主。所有用户可见按钮、配置标题、状态标签和错误建议都应使用中文；必要的英文协议名、命令名和文件名保留原文。

每个区域的优化都应直接按最终形态设计和实现，不先做临时普通版再自我推翻。每一批 UI 修改必须同时考虑视觉层级、真实 handler、按钮终态、悬浮解释、错误提示和测试覆盖，避免只迁移外观导致功能丢失。

所有可点击按钮都必须有鼠标悬浮解释，说明该按钮会触发什么链路、是否会影响真实服务器、是否需要等待终态、失败后应如何处理。配置项也应提供悬浮解释，尤其是调度轮询、可用性上报、TTL、实时事件合并延迟、Worker 控制最小间隔、Worker 控制最大并发、GPU 并发上限和允许 GPU 列表。

后续 UI 优化可以检索和参考开源 VS Code 插件的 Webview 与 Tree View 实现，并自动选择适合本插件的结构。默认参考方向是：Kubernetes Tools 的资源树和集群对象组织、GitLens 的高密度状态卡片、GitHub Pull Requests 的列表/详情/日志/操作按钮风格，以及 Cline/Continue 的复杂步骤流 Webview。参考实现只用于结构和交互取舍，不引入不必要依赖，不牺牲现有功能入口。

服务器管理区域应先展示“对象总览”，把 Hub、Worker、端口、会话、GPU 上限、端口冲突和调度策略压缩为可扫读状态卡；完整配置表单仍保留在下方，避免为了美化 UI 丢失实际入口。

中间列应作为“运维总览”首屏，把 Xshell 隧道、Hub 控制面、Worker 状态、GPU 资源、任务队列、项目接入、操作进度和调度策略压缩为高密度状态卡；基础摘要保留在折叠区，用于排查旧字段和兼容状态。此前提到的“集群概览”如涉及布局职责，统一指整个中间列，而不是某一个独立卡片。

面板顶部应提供轻量“状态路径”，把集群连通、运行门禁、调度执行、结果证据和阻塞提示压缩为可扫读状态，不再承载大块重复业务按钮。真实操作入口统一放在右侧工作详情和对应详情卡片内，防止 UI 优化导致旧功能丢失。

首屏“项目接入”和“运行门禁”必须按真实首次运行顺序判断：服务器 Xshell 与项目父目录、当前明确选中的 Plan、输出契约、执行 Worker、Agent 配置冲突、版本、项目目录和连接检测。仅发现 Plan、接入模板或结果线索不能显示“可运行”。运行提交、校验、预演、任务监控、结果处理和失败恢复阶段也应显示对应真实状态，避免新项目在尚未完成服务器或 Agent 接入时被误导为可提交。

工作流入口下方应提供“对象状态条”，用一行高密度卡片展示 Hub、Worker、GPU、任务、计划、结果和操作状态。对象状态条参考 Kubernetes Tools 的对象导航、GitLens 的高密度状态卡和 GitHub Pull Requests 的列表详情工作流，只做可读状态汇总，不新增无 handler 的空按钮。

调度与上报策略卡片必须同时提供输入框、悬浮解释和可见术语说明。`实时事件最多等待` 表示 Worker 把停止、删除、归档、任务状态等变化合并推送前最多等待多久；`Worker 操作防连点间隔` 表示同一 Worker 两次手动控制动作之间的最小间隔；`Worker 操作同时执行数` 只限制停止、删除、归档、重试等手动控制动作，不等于 GPU 任务并发数。

左侧资源树不仅用于跳转，还应在详情框里说明当前区域状态、对象数量、状态含义和下一步建议，避免用户只看到术语而不知道该先处理哪里。

资源树还应直接展示 Hub、Worker、GPU 服务器、任务状态、结果线索和操作状态等子对象，形成接近 Kubernetes Tools 的对象层级；点击子对象仍跳转到对应详情区，避免额外引入只读空入口。

最终工作台应采用“三栏运维布局”：左侧资源树负责对象导航，中间保留完整功能卡片，右侧工作详情栏按当前资源树选择展示状态摘要、关键事实、下一步建议、最近操作和常用按钮。右侧详情栏参考 GitHub Pull Requests 的列表/详情/日志/操作区组织方式，只汇总已有 handler，不新增空按钮。

操作进度区域、资源树和工作详情使用“已提交”“执行中”“失败”“卡住”“已完成”等中文术语，并按真实 operation 统计 accepted/submitted/queued/running、成功终态和 failed/stalled/unsupported/error；原始值保留在悬停和搜索文本中。`accepted` 只能表示已提交，不能作为按钮持续 loading 的依据；按钮恢复必须以 `uiCommandStatus` 终态或 watchdog stalled 为准。

操作进度中的 `validate-plan`、`dry-run-plan`、`run-plan`、`parse-results`、质量门禁和论文导出等类型会显示为中文名称；悬停仍保留原始 operation type，未知类型原样显示，便于兼容新旧 Agent。

发布同步、服务器状态和实时连接中的 `running`、`connected`、`syncing`、`failed`、`completed_with_errors` 等常见状态会显示为中文；失败状态保留冒号后的原始错误详情，未知状态原样显示，便于兼容不同版本 Agent。

结果工作台及记录详情事件线中的 `archived`、`pending_review`、`parsed`、`parse_failed`、`deleted` 和 `residue` 等记录状态会显示为“已归档”“待筛选”“已解析”“解析失败”“已删除”和“有残留”；记录详情悬停仍可查看原始状态，未知状态原样保留，不影响结果筛选、归档和删除判断。

Plan 运行工作台的执行阶段会显示“可提交”“校验中”“预演中”“提交中”“运行中”“结果待处理”或“任务需处理”等中文阶段；内部 `phase` 只保留在徽标悬停提示中，未知阶段原样显示，不影响阶段判断和下一步按钮。

结果摘要使用“解析失败数量”等用户可读字段名，SCI 统计中的显著性状态会显示为“显著”“不显著”“样本不足”或“需实验”等中文。PPT 绘图选项显示“自动”“跟随当前 PPT”和“默认样式”，但仍保存既有 `auto`、`activePpt` 和 `default` 配置值，未知值原样保留。

GPU 资源卡中的服务器状态会显示为“在线”“离线”“已过期”或“降级”；状态徽标悬停可查看 Agent 原始值，未知状态原样显示，不影响 GPU 占用、我的任务和缓存判断。

任务事件线和运行进度卡中的任务状态、Worker 实时状态同样显示为中文；悬停或事件详情保留 Agent 原始状态，Worker 告警保持原文，不影响任务终态、日志、重试或归档判断。

端口冲突卡中的 `warning/error` 会显示为“注意/错误”，实时通道没有 WebSocket 或 SSE 时显示“快照备用”而不是 `snapshot`；悬停保留原始诊断值，不改变端口冲突和通信能力判断。

最近错误列表会把 `runPlan`、`parseResults`、`uploadProjectToHub` 等内部命令显示为中文操作名称；悬停仍可查看原始命令 ID，未知命令原样保留，不影响错误持久化和恢复操作。

Worker telemetry 卡片中的 `websocket`、`sse` 和 `snapshot` 会显示为“WebSocket（本地转发）”“SSE（本地转发）”和“快照备用”；悬停保留原始事件流值，不改变实时通道选择或推送策略。

概览分区签名必须包含 operation 摘要和项目就绪状态。操作终态、Plan 选择、服务器配置、Worker、Agent、输出门禁或运行阶段变化后，首屏卡片和阻塞条必须立即刷新，不能继续显示上一状态。

概览的预依赖键同样必须包含 Hub/Worker probe、operation、Plan 选择和计划列表；否则即使完整状态已经更新，分区缓存仍可能跳过真实重绘。

任务运行状态应采用“列表 + 详情 + 日志/事件线 + 操作按钮”的原生 VS Code 工作流风格。右侧详情必须展示可操作标识、Worker 直达状态、停止/重试/归档/删除可用性原因、实时或最终日志，以及与该任务相关的 operation 终态，避免旧任务按钮看似可点但没有反馈。

诊断区域中的 Hub 控制面、Agent 会话、Worker telemetry、隧道端口分配和端口冲突也应使用高密度状态卡呈现，优先显示本机端口、远端 Agent 端口、事件流、心跳、tmux、Xshell 会话和修复入口；表格只作为必要时的内部实现，不作为主要阅读方式。

诊断区域还应展示“功能可用性审计”，按发布同步、计划运行、Worker 控制、结果证据、诊断恢复分组列出当前可用状态和中文不可用原因。任何仍未具备真实 handler、能力门禁或终态恢复的入口都不能表现为普通可点击按钮。

诊断区域还应展示“目标验收矩阵”，把当前目标拆成 UI 中文工作流、Xshell 边界、通信风控、任务按钮终态、项目自动接入、真实 Agent 能力、真实集群烟测和旧隧道兼容命名最终迁移等条目。矩阵只展示证据和待验收项，不能把需要真实集群验证或最后阶段迁移的内容标成已完全完成。

实验准备区域应把“项目结构识别、输出接入、分类指标主线、结果捕获优先级”放在同一个自动接入工作台里。分类任务是默认主线，常用指标包括 AUC、accuracy、F1、AUPRC、precision、recall、specificity、balanced accuracy 和 loss；Dice、DSC、IoU、HD95、ASD 等分割指标保留为兼容项。

实验准备区域还应提供“运行前门禁”工作台，把当前计划、运行前代码同步、校验与预演、调度队列和输出闭环放在同一处。计划列表中的单行按钮必须使用该行自己的 `planFile`，不能因为全局输入框为空而误禁用；一键运行仍必须先同步本地最新代码到 Hub 和参与 Worker，确认 fingerprint 后再启动实验。
运行前门禁和发布同步状态统一把 fingerprint 显示为“代码指纹”，未选择计划时明确提示“需要选择计划”，原始 fingerprint 仅保留在悬停提示中。

结果与归档区域应把解析状态、质量门禁、SCI 统计、论文证据和归档终态放在同一个证据工作台里。论文 claim 需要强关联到 `experiments/runs/`、`experiments/results.csv` 或 `paper/claims.md`；缺证据必须显示 `unsupported` 或 `needs experiment`，不能显示成已完成。

实验记录详情应按“列表 + 详情 + 事件线 + 操作按钮”展示。每条记录需要展示归档标识、Worker 直达状态、产物路径、结果路径、解析/归档/删除事件线和行级解析、同步、三方校验、归档、删除按钮；缺少 Worker 或可操作标识时必须显示中文原因，不能静默点击无反应。

## 通信架构

### 1. 本机 VS Code -> Hub Agent

- 路径：`http://127.0.0.1:<hubLocalPort>`
- 载体：Xshell 本地端口转发
- 用途：
  - 调度入口
  - 全局状态索引
  - 归档终态权威
  - Hub 本地 availability cache
  - 计划校验、计划运行、结果汇总等 Hub 侧动作

### 2. 本机 VS Code -> Worker Agent

- 路径：`http://127.0.0.1:<workerLocalPort>`
- 载体：Xshell 本地端口转发
- 用途：
  - GPU 状态
  - 任务运行状态
  - 实时日志尾部
  - 删除、停止、归档准备等手动控制
  - Worker 本机文件状态校验

手动操作优先直达 Worker Agent，不强制经过 Hub 中转。这样能减少无意义链路，也更符合“用户点击才触发”的低频控制模型。

### 3. Worker Agent -> 本机 VS Code

- 方式：SSE / WebSocket 长连接推送
- 用途：
  - GPU snapshot 或简化 availability
  - task status changed
  - live log tail
  - delete progress / completed / failed
  - archive progress / completed / failed
  - stop progress / completed / failed
  - operation terminal

本机不会对 Worker 做高频 HTTP polling。

### 4. Worker Agent -> Hub Agent

- 方式：Worker uplink 推送
- 用途：
  - 低频 GPU availability 上报
  - 任务状态变化
  - 删除、停止、归档准备的实时终态
  - operation terminal

设计原则：

- GPU availability 低频、带正向随机抖动。
- 操作和任务事件按变化实时推送。
- 断线重连使用退避和抖动，不做固定短周期重试。

### 5. Hub Agent -> Worker

Hub 不再对 Worker 做高频 GPU / CPU probe。

Hub 只负责：

- 读取本地 availability cache
- 调度 queued 队列
- 维护 scheduler state
- 维护归档索引和终态

### 6. SimpleSFTP

SFTP 只负责低频真实文件传输：

- Local -> Hub 首次上传与代码同步
- Local -> Worker 首次上传与分发代码
- Worker / Hub -> Local 下载结果、日志包、manifest
- Worker -> Hub 结果归档相关文件传输

服务器管理只需填写服务器地址、登录用户和项目父目录。服务器地址是插件 SSH 与 SimpleSFTP 文件操作的权威地址，应填写真实 IP 或可直接解析的域名，不是远端文件路径；已有 `transferHost` 等旧字段只在服务器地址缺失时作为兼容回退。文件传输目标路径根据项目父目录和当前项目名自动计算。Xshell 会话只负责 Agent 隧道，不提供文件传输地址。

SFTP 不负责：

- GPU 状态
- 实时日志
- 心跳
- 操作进度
- 删除状态
- 任务状态流

## 风险评估

### 低风险

- 本机通过 `127.0.0.1:<localPort>` 访问 Hub / Worker Agent
- Worker -> Local SSE / WebSocket 长连接推送
- Worker -> Hub 低频 availability 批量上报
- SFTP 低频上传下载代码、日志包、结果文件

诊断区通信拓扑会把 Worker 可用性批量上报、实时日志/GPU/任务推送和 SFTP 低频文件传输分开显示；实时状态不需要配置为 SFTP 文件流。原因：连接稳定、频率可控、链路职责清晰。

### 中风险

- 用户频繁手动点击停止、删除、归档、重试
- Hub 与 Worker 的 uplink 断线后持续重连
- availability 上报间隔配置过短

控制方式：

- 所有操作按钮必须在终态后恢复，禁止重复连点堆积。
- 重连使用退避和抖动。
- 自动轮询与自动上报最小值统一限制为 60 秒。

### 高风险

- 对 Worker 做固定短周期 polling
- Hub 直接循环扫所有 Worker GPU / CPU
- 用 SFTP 搬实时状态或日志流
- Local / Hub / Worker 三端同时对同一状态源做高频探测

这些行为容易形成明显的短连接模式，也是最容易触发风控的实现方式。当前架构明确规避这类链路。

### 自动通信频率底线

- 自动健康检查、自动快照 fallback、Hub 调度轮询、Local availability 上报和 Worker availability 上报的默认周期都不低于 `60s`。
- 实际周期统一使用 `base + random(0, jitterSeconds)` 的正向抖动，避免固定节奏。
- WebSocket / SSE 属于长连接推送，不按短周期轮询计算；删除、停止、归档和任务状态等实时事件走推送通道。
- 面板中间列的“通信风险矩阵”会直接展示每条链路的载体、频率、权威边界和风险提示。

## 参数说明

以下参数现在应直接在插件 UI 的“服务器管理”区域中配置。

### 调度与上报策略

- `pollSeconds`
  - 含义：Hub scheduler 基础调度轮询间隔。
  - 作用：只影响 Hub 多久尝试消费一次 queued 队列。
  - 默认：`60`
  - 最小：`60`
  - 实际间隔：`pollSeconds + random(0, jitterSeconds)`

- `jitterSeconds`
  - 含义：正向随机抖动秒数。
  - 作用：打散固定节奏，避免形成规则化高频特征。
  - 默认：`30`
  - 最小：`0`
  - 示例：当 `pollSeconds=60` 时，实际间隔为 `60-90s`

- `workerStatusTtlSeconds`
  - 含义：Hub 本地 availability cache 的有效期。
  - 作用：如果 `now - updatedAt > ttl`，Hub scheduler 不再信任该 Worker 的 availability。
  - 默认：`180`
  - 最小：`60`
  - 注意：TTL 不是轮询间隔。

- `localAvailabilityPushSeconds`
  - 含义：本机作为 `local_aggregator` 时，向 Hub 批量上报 Worker availability 的基础间隔。
  - 默认：`60`
  - 最小：`60`
  - 实际间隔：`localAvailabilityPushSeconds + random(0, jitterSeconds)`

- `workerAvailabilityPushSeconds`
  - 含义：Worker Agent 向 Hub 推送 availability 的基础间隔。
  - 默认：`60`
  - 最小：`60`
  - 实际间隔：`workerAvailabilityPushSeconds + random(0, jitterSeconds)`

- `operationEventMaxDelayMs`
  - 含义：删除、停止、归档、任务状态等实时事件的最大合并延迟。
  - 默认：`1000`
  - 最小：`100`
  - 注意：这个参数只影响事件聚合延迟，不影响 GPU availability 轮询频率。

- `workerActionMinIntervalMs`
  - 含义：同一类 Worker 控制动作之间的最小间隔。
  - 默认：`1500`

- `workerActionMaxConcurrent`
  - 含义：Worker 控制动作的最大并发数。
  - 默认：`1`

### 每个 Worker 的资源限制

- `maxConcurrentGpus`
  - 含义：该 Worker 同时允许被插件调度占用的 GPU 数上限。
  - 默认：`1`
  - 说明：只限制并发占卡数量，不限制队列总长度。

- `allowedGpuIds`
  - 含义：允许该 Worker 被调度使用的 GPU ID 列表。
  - 默认：空
  - 说明：留空表示不限制；多个 GPU ID 用逗号或空格分隔。

## 可用性来源优先级

Hub 调度时只看本地 cache，不主动高频扫 Worker。

可用性来源优先级如下：

1. `local_aggregator`
2. `worker_uplink`
3. `hub_cached_snapshot`

含义：

- 本机 VS Code 开着时，Hub 优先使用本机汇总的 Worker availability。
- 本机关掉或本机上报过期后，Hub 回退到 Worker 自己的 uplink availability。
- 再不行才使用更旧的 Hub cache snapshot。

## 删除、停止、归档的职责边界

### 删除

- 用户点击删除 -> Local 直发 Worker Agent
- Worker 本机执行删除，范围包含任务目录、日志、轻量结果、manifest，以及用户明确选中的托管项目文件，例如 `src/`、`configs/`、`scripts/`、`train.py`、`test.py` 等正常代码文件
- Worker Agent 只允许删除当前项目根目录内的托管目标；`.git`、`.vscode`、`.ssh`、`.env`、私钥和跳出项目根目录的路径会被拒绝
- 缺失、越界或受保护目标会让本次删除返回 `failed`，并在操作进度中显示 skipped/residue 原因，不会伪装为成功
- Worker 实时推送进度和终态到 Local 与 Hub
- Hub 收到终态后更新 tombstone / index

如涉及 Hub 本地归档副本，只由 Hub 删除 Hub 自己的文件，不替 Worker 执行本机删除。SFTP 不承载删除状态流；删除进度和终态只走 Worker Agent 实时事件。

### 旧版任务残留

旧版插件生成的任务可能只有 `global_job_id`、`session` 或旧 run id，没有新版 Worker / archive key。新版插件按以下规则处理：

- 任务自带 `artifactPath`、`artifact_path`、`hub_job_dir`、`worker_job_dir`、`native_job_dir`、`workDir` 或 `outputDir` 时，删除和归档优先使用这些路径。
- 任务只有旧 id 时，Agent 只会在 `work_dirs`、`experiments/runs`、`simple_cluster/archive`、`simple_cluster/results`、`results`、`exports` 这些产物根内按精确名称查找候选目录或文件；命中后才真实删除。
- 旧 id 自动定位不会扫描 `src`、`configs` 等代码目录。代码文件删除必须来自用户明确选择的路径，避免把旧任务 id 当作普通文件名误删。
- 如果没有任何可定位路径，任务区会提供“隐藏残留 / 清除全部旧任务残留”。该操作只清理本机 UI 显示，不删除 Hub、Worker 或本地项目文件。

### 停止

- 用户点击停止 -> Local 直发 Worker Agent
- Worker 停止本机 tmux / 进程
- Worker 推送终态到 Local 与 Hub
- Hub 只更新 scheduler control 与全局状态

### 归档

- 用户点击归档 -> Local 直发 Worker Agent 发起归档准备
- Worker 负责本机产物检查、manifest、轻量日志包准备
- Hub 负责归档索引和最终归档状态
- 大文件同步仍走 SFTP / Hub 拉取链路
- “检查同步清单”只检查目标并准备 manifest，不会上传、下载、移动文件，也不会把目标标记为已归档
- “三方一致校验”只检查目标是否存在且已登记归档状态，不会隐式归档；缺失或未归档会返回失败并显示具体目标
- 停止、重试、同步清单、三方校验、归档和删除的强确认窗口会列出当前选择可确定的产物、结果和日志文件位置，并单独列出任务标识；无法展开位置时会明确说明由 Hub Agent 按标识解析

## 首次配置

### 1. 准备 Xshell 会话

每个端点都需要一个 Xshell 会话，至少包含：

- 登录信息
- 本地端口转发

插件只打开 `.xsh`，不在插件内直接执行远端 shell 命令。Agent 不再单独配置启动会话；需要自动启动时，必须由用户显式点击“写入 Agent 自动启动命令”。该按钮只修改本地 `.xsh` 的 `RemoteCommand`，只会写入空命令或替换 SimpleExperiment 管理的旧命令，不修改 `ForwardX11`、Host、User、端口转发或其它会话项。写入前会覆盖同名 `.simple-backup` 固定备份，不堆积时间戳备份。写入完成后会显示每个会话的写入、跳过或失败状态。Conda 环境为可选设置；新安装默认留空，此时 Agent 和 Plan 使用服务器系统 Python，完全跳过 Conda 激活。填写环境名后会尝试激活该环境；Agent 自身不会因激活失败而阻断隧道端口，真正运行 Plan 和 job 时仍会严格要求该环境。已有显式环境设置会原样保留。若会话已有非 SimpleExperiment `RemoteCommand`，插件会跳过并提示中文原因，不覆盖用户自定义登录命令。

### 2. 配置隧道端口

示例：

| 角色 | 本机端口 | 远端目标 |
| --- | ---: | --- |
| Hub | `18765` | `127.0.0.1:18765` |
| Worker 1 | `18766` | `127.0.0.1:18765` |
| Worker 2 | `18767` | `127.0.0.1:18765` |
| Worker 3 | `18768` | `127.0.0.1:18765` |

要求：

- 本机端口必须唯一
- 远端目标统一绑定 `127.0.0.1`

### 3. 配置服务器管理卡片

在“服务器管理”中填写：

- Hub / Worker 的显示名
- 登录别名或地址
- 项目父目录
- Xshell 隧道会话
- 端口对

Worker 额外配置：

- 并发占卡上限
- 允许 GPU 列表

### 4. 配置调度与上报策略

在“调度与上报策略”卡片中直接设置：

- 调度轮询基准
- 随机抖动
- availability cache TTL
- Local 汇总上报间隔
- Worker 上报间隔
- 实时事件合并延迟

### 5. 部署 Agent

首次配置推荐点击“准备 Agent 并启动”。一次确认后会按固定顺序写入受管 `RemoteCommand`、通过 SimpleSFTP 部署最新版 runtime、打开全部 Xshell 会话并检测 Hub/Worker；任一 `.xsh` 已有非 SimpleExperiment 登录命令时，会在远端部署前停止且不会覆盖。部署、写入、启动和检测仍保留独立按钮用于故障恢复。

“启动连接”只负责打开 Xshell 会话，不会自动改写 `.xsh` 或提交实验。写入后的 `RemoteCommand` 会在后台启动受管 Agent tmux，然后让前台终端串行读取登录 profile、`.bashrc`、按需激活配置的 Conda 环境、切到自动计算的当前项目代码目录，并保持正常交互式 bash。环境留空时直接使用系统 Python，不探测或激活 Conda；填写环境名后若 `conda activate <env>` 失败，终端会保留 Conda 原始报错和一行 Agent 失败码，便于定位环境问题。提交 Plan 时，Hub scheduler 和 Worker run-job 会严格继承各自选定的执行环境；Worker 采用固定GPU窗口（tmux split-window）+ capture-pane 主镜像，日志以 capture-pane 为主，文件日志仅兜底（旧每job一tmux/文件日志为主已废弃）。

如果 Hub 仍显示 `agent_version_mismatch`，说明远端运行的 Agent 会话还没有重启到新版本。

## 运行与校验

### 提交运行

未打开工作区时执行“准备 Agent 并启动”会直接打开 VS Code 文件夹选择器，不会写入 `.xsh`、部署 runtime 或启动远端 Agent；打开真实单项目后再继续准备。

“启动连接”只打开 Xshell 会话，不会部署 Agent 或提交实验；若会话已有受管 `RemoteCommand`，Agent 会随登录自动启动。Hub 负责控制与调度，正式实验至少需要一个已启用的 Worker；仅配置 Hub 时仍可管理本地 Plan 和执行部分 Hub 操作，但“校验并提交运行”“复现”和“运行全部计划”会在确认或上传前明确阻断并引导到“设置 > 服务器”添加 Worker。准备 Agent 前必须打开要运行实验的本地项目，插件不会使用通用占位项目目录；准备完成后可直接点击“接入当前项目”。“接入当前项目”会沿用当前明确选中的 Plan；项目存在多个 Plan 且尚未选择时必须先选择本次目标，不会静默使用列表第一项。切换目标且 Agent 连接就绪后会立即按新 Plan 请求结果摘要；新摘要返回前，结果、质量门禁、统计、论文表、claim 证据和 PPT 绘图契约不会沿用上一 Plan 的状态。接入完成后会即时检测已配置端点，并按结果输出门禁、服务器配置、Worker 和 Agent 的真实状态只提示一个下一步；仅当全部通过时才提示“校验并提交运行”。缺少 Worker 时“添加 Worker”会直接启动 Worker 配置向导；保存成功后同一接入流程继续提示准备 Agent，检测通过后继续提供“校验并提交运行”。离线导入模式会直接打开 `simpleExperiment.connectionMode` 设置，不再只打开面板后要求用户自行寻找。流程中新建 Plan 只更新当前选择，不会自动切换编辑器；若同时生成输出接入模板，则保留接入说明页。只有用户选择对应下一步时才打开当前 Plan 或接入配置，避免创建文件后连续跳页。如果该流程引导用户先完成服务器配置或“准备 Agent 并启动”，Agent 检测通过后会在同一流程再次提供“校验并提交运行”，不会停在准备完成提示。单 Plan 确认框会列出 Plan、模式、任务数、基础配置和 Worker；批量运行会先完成本地输出门禁和配置检查，再用强制确认窗口列出计划总数、已知任务总数、Worker 及各 Plan 的模式和配置。只有确认后才会同步 Hub 和参与 Worker，再依次校验、预演和提交调度，取消不会触发代码上传或远端预演；任一批量 Plan 未通过时整批停止提交。“单独校验”和“单独预演”用于需要先检查门禁结果的场景；校验或预演失败后，“下一步”会切换到对应的重新执行动作。工作台会直接显示最近一次校验任务数、预演可调度数、排队数和真实失败原因，重复传播的同一失败只保留一条最近错误。概览中的操作卡同时统计真实进行中、失败和成功终态，并展示最近 operation 状态和类型。提交运行后 UI 不会立即解析尚未完成的旧结果；调度器最后一个任务进入完成、失败、取消或停止终态时，Hub 会按 operation 携带的 `planFile` 自动检查输出契约并解析完整预览结果，多 Plan 并行互不串扰。预览结果先用于人工对比并选择归档；质量门禁只检查已归档结果，随后才生成最终统计、论文证据、论文表和 PPT 数据。未归档记录保留在完整预览中并明确标为未纳入。运行计划前会自动完成：

Plan 卡、运行工作台以及单 Plan/批量运行确认会把任务规模统一显示为“实验项数 × 随机种子数 = 任务数”。运行工作台和确认窗口还会按允许 GPU 与并发上限计算静态首轮容量，说明首轮最多运行数和至少排队数，便于提交前发现 Plan 规模或 Worker 配置错误；确认窗口同时逐个列出 Worker 使用的 Conda 环境或系统 Python、并发占卡上限与允许 GPU ID。这些值来自本地 Plan 与服务器配置，不代表当前空闲 GPU；实时分配和实际排队仍以预演和任务页为准。底层字段仍使用 `case`、`seed` 和 `job`，不影响旧 Plan 或调度兼容。提交给 Hub 的 Worker 目标会携带各自的执行环境，Worker 启动任务时显式覆盖 `SIMPLE_EXPERIMENT_CONDA_ENV` 和是否要求 Conda 的标记，因此不同 Worker 可以选择不同 Conda 环境或系统 Python，不依赖 Agent 启动时遗留的旧值。

单 Plan 或批量运行的强确认窗口还会显示当前模式实际会执行的训练或评估命令，便于同时核对 Plan、入口和远端输出位置。未声明的命令会明确提示运行前校验将阻断提交；过长命令会截断显示，但仍保留核对提示。该信息只读展示，不改变旧 Plan、旧任务或调度参数。

Scheduler 需要当前执行环境安装 `PyYAML`。Plan 校验、预演、正式调度和 Worker 任务启动共用同一依赖预检；缺失时会在启动任务前显示当前系统 Python 或 Conda 环境、`yaml (PyYAML)` 缺失项和可直接执行的安装命令，不再返回 Python traceback。插件不会静默修改服务器 Python 环境，安装后重新校验 Plan 即可。

重复执行“接入当前项目”时，若当前 Plan 已有排队、运行或未结束提交，流程会直接进入任务或操作进度，不再再次提示提交。复杂新项目允许连续完成更多配置步骤；若某一步执行后状态没有变化或连续步骤仍未收敛，会停止重复弹窗并提供“打开实验准备”，不会静默结束或无限询问。

“检测全部”只有在 Hub 和每个已启用 Worker 都返回可用状态时才显示成功。任一 Worker 失败、超时或因配置不完整而未实际执行检测时，插件会显示警告，并按服务器名称给出真实错误或修复建议；不会因 Hub 正常而把整组检测误报为成功。禁用的 Worker 不参与本次检测结论。

运行中 Plan 的优先级高于新的本地接入阻塞。即使实验开始后修改了输出契约、服务器配置或连接模式，命令接入、首屏状态和“项目关键入口”仍先显示现有任务或提交进度，避免用户误以为当前 Plan 尚未运行并再次提交。

当前版本 Plan 已经完成调度后，再执行“接入当前项目”不会重新进入提交确认。成功终态直接打开结果解析、筛选与归档；包含失败、停止或取消任务的终态直接打开任务和日志。判断按 Plan revision 隔离，修改 Plan 后不会被旧版本终态阻止；最新一次提交若在调度接受前失败，也不会被更早的成功运行掩盖。

“项目关键入口”的右上角状态与当前 Plan 生命周期一致：校验、预演、提交和运行期间显示当前阶段，运行结束后显示“结果待处理”或“任务需处理”，不会因为服务器配置或输出规则后来变化而重新显示“可提交”或“待补齐”。状态行与唯一下一步使用同一运行阶段，已结束 Plan 优先进入结果或任务处理。

如果 VS Code 重载后运行 operation 记录暂时缺失，项目入口会使用当前 Plan revision 对应的调度任务终态恢复流程：全部正常完成进入结果，存在失败、停止或取消进入任务和日志。调度状态中的 `normal_completed` 会按完成处理，`manual_interrupted_completed` 会按需人工复核的停止处理；旧 revision 或旧时间的任务不会阻止修改后的 Plan 重新运行。

接入流程只在当前 Plan 尚无运行记录且已经具备可运行条件时主动检测 Hub/Worker。已有运行中的任务会立即进入任务或提交进度，已结束运行会立即进入结果或日志，不会先等待一次与当前操作无关的端点检测；服务器离线时仍可快速查看已同步到本地的状态和结果入口。

当前 Plan 尚未运行时，接入流程会复用 60 秒内已经通过的 Hub 和全部启用 Worker 当前项目检测状态，不会连续点击时重复探测。检测超时、服务器配置变化、任一端点未知或失效、版本不兼容、项目目录不匹配时都会重新检测；探测异常会清除旧成功状态，不能用过期结果误判为可运行。Hub 的文件 API 不可用但控制端点正常时仍按既有兼容规则视为可运行。

一键配置中的缺失会话、缺少 Worker、SimpleSFTP 目标不完整和 Agent 准备冲突提示统一使用“打开服务器设置”，并直接定位到对应区域。流程内添加 Worker 时不会再额外弹出成功通知，避免与下一步提示重叠；从服务器面板单独添加 Worker 时仍保留成功通知。

项目因离线结果包进入离线状态时，“恢复在线连接”会清除当前项目的离线覆盖并继续接入；仅当 `simpleExperiment.connectionMode` 本身设置为 `offline_import` 时才打开连接设置。连接模式、隧道端口、token 或服务器参数在 VS Code 设置中修改后会立即重载客户端和面板状态；从离线设置切回 Xshell 实时隧道后可直接继续接入当前项目，无需重载窗口。

同一 Plan 已有 accepted、submitted、queued、running 或 testing 状态的运行操作或任务时，所有运行入口都会禁用并改为“查看运行进度”。Extension 后端会在确认窗口、代码上传和远端预演前再次门禁，避免重复点击产生重复实验；批量运行也会列出仍活跃的 Plan 并整批停止。

同一路径下如果是旧 Plan revision 仍在运行，当前版本也会被保护性阻止提交，避免共享远端项目目录和代码同步影响旧任务；入口会明确标为“旧版本运行中”，并提供“查看运行进度”，不会把旧任务伪装成当前 revision 的任务。旧任务仍可正常监控、停止、重试、解析或归档，当前 revision 的终态和结果不被改写。

提交确认窗口会同时显示 Plan、模式、任务数、配置、Worker 和预期结果位置。优先显示 Plan 自己声明的 `paper.result_csv`、`expectedResults` 或解析出的输出候选；Plan 未直接声明时显示 `experiments/simple_project.yaml` 的接入候选。`{output_dir}` 会明确说明为每个任务的实际任务输出目录；固定相对路径按 Plan 原样保留并相对于远端项目执行目录解析，避免实验完成后才发现结果落盘位置错误。

运行进度按 Plan 组织，展开 Plan 就地查看任务与日志。旧 revision 的任务仍可查看和处理，不再提供独立全局任务页及当前版本与全部任务切换。异常任务的重试、停止、转移、日志和解析入口保留在 Plan 内任务卡；超过 20 条时可展开该 Plan 内的其余任务。完整 operation 历史保留在“高级：完整操作记录”。实验记录的当前 Plan 与全部记录切换及详情保持不变。

Plan 内任务卡中的 `queued`、`running`、`testing`、`completed`、`failed`、`stalled`、`stopped` 和 `cancelled` 会显示为中文状态；悬停仍可查看 Agent 返回的原始状态，便于排查兼容状态，不影响筛选、重试和归档判断。

运行结束但输出契约缺少文件时，项目入口会显示具体缺失文件。没有 `experiments/simple_project.yaml` 时生成模板；已有接入配置时直接打开原文件，修改后可用“修复后重新运行”重新同步、校验、预演并提交当前 Plan，不会反复覆盖模板。PPT 目标路径只写入当前项目的 `simple_cluster/ui/ppt_plot_config.json`，新项目不会继承应用级或其他项目的演示文稿路径。

Plan 工作台与项目入口读取同一个当前 Plan 运行时契约状态。尚未检查时显示“待检查”，契约检查中显示“检查中”，缺失真实输出时显示“运行缺失”，契约完整但结果尚未重新读取时显示“待重新解析”；这些状态会替代普通“可运行”按钮，避免同一 Plan 同时出现互相冲突的提示。

输出契约检查不仅确认 `metrics_summary.csv`、`env_snapshot.json` 和 `config_snapshot.yaml` 存在，还会用当前项目的列映射、指标别名和解析规则实际读取 `metrics_summary.csv`。文件存在但没有数值指标时检查失败，并在项目入口、Plan 工作台和操作详情中显示具体不可解析文件，避免“契约完整 → 重新解析 → 仍为空”的循环。

不可解析的 CSV、JSON、TXT、LOG 或 OUT 文件会在 Plan 工作台和操作详情中逐项显示文件名与真实解析原因，例如未找到数值指标、列映射错误或数值格式错误，并可直接“查看文件”。插件只接受当前 Plan 最近一次输出契约检查返回的项目内路径，通过 Hub 的 Xshell 本地隧道下载不超过 5 MB 的只读副本；下载前强制显示当前 Plan、远端来源和项目内本地副本位置，确认后才写入 `simple_cluster/downloads/result_inspection/` 并打开。本入口不会把远端路径交给本地文件打开命令，也不通过 SFTP 读取结果。

结果页分区缓存必须把当前 `planFileInput` 和 operation 列表作为预依赖，并把最新输出契约检查与分析产物路径写入渲染签名。切换 Plan，或完成输出检查、异常诊断、配置恢复、case 级解析、PPT 绘图契约等操作后，结果页应立即显示当前 Plan 的真实状态和新文件路径，不得继续沿用上一 Plan 或操作前的按钮状态。

所有由 SimpleExperiment 发起的项目代码和 Agent runtime SFTP 上传都会先经过强制路径确认窗口，窗口展示服务器账号、完整预期远端目录，并逐条展示预期远端文件位置和文件总数。Agent 准备及独立写入自启动命令的最终强确认窗口还会逐个展示本地 `.xsh`、固定 `.simple-backup` 备份、runtime 远端文件与 Agent 项目工作目录；即使对应远端路径已经选择过“不再提醒”，最终操作确认仍保留这些预期文件位置。操作前也可在“设置 -> 服务器”直接核对每台服务器计算后的“当前项目代码”和“Agent runtime”位置；编辑“项目父目录”时这两个位置会实时展开并标记为未保存预览，保存服务器配置后才会成为上传与 Agent 启动的正式位置。未打开本地项目时不会使用扩展进程目录生成伪项目名：设置页只显示可确定的 Agent runtime，代码位置明确等待打开目标项目。项目父目录不要包含当前项目名或 `simple_agent`；插件会自动追加项目名并管理同级 runtime。路径末级等于当前项目名时，可在警告窗口一键改为上一级父目录，避免形成重复目录。向导输入、设置保存、共享 SFTP 配置、Agent 自启动和上传前共用这些规则。“项目关键入口”的“上传位置”会显示当前项目摘要。上述上传和忽略规则操作确认前不会更新对应 SimpleSFTP 共享目标或显示上传已开始；取消后不会留下误导性的运行中状态。用户可仅确认本次，也可选择此后不再提醒完全相同的路径；免提醒记录只对当前本地项目、服务器、账号、端口和全部关联路径的组合生效，位置变化后自动恢复询问。需要重新核对时，可在“设置 -> 服务器”的“上传路径提醒”中点击“恢复提醒”；该操作只清除当前项目的免提醒记录，不修改服务器配置、SimpleSFTP 配置或远端文件。SFTP 忽略规则配置也经过同一路径门禁。

1. 同步本地最新代码到 Hub
2. 同步到本次参与运行的 Worker
3. 校验代码指纹
4. 全部成功后再启动计划

运行和批量运行的强确认窗口会同时列出 Hub 汇总目录、每个执行 Worker 的真实项目目录，以及由 Plan 输出候选拼接出的预期结果文件模板。Worker 行表示真实运行生成位置，Hub 行仅表示产物同步后的预期汇总位置。“检查同步清单”不会传输文件；是否已经到达 Hub 仍以实际文件同步流程和“三方一致校验”结果为准，避免把未同步结果误判为已汇总。

运行 Plan、Debug 首跑、复现实验或运行全部计划时，活跃任务重复提交检查仍优先执行；通过后才检查 SimpleSFTP。依赖未就绪时会先显示安装说明，不会先弹出包含远端路径的运行确认窗口。

### 检测全部

检测目标：

- Hub 本地隧道是否连通
- Worker 本地隧道是否连通
- Agent API 是否可达
- Hub / Worker Agent 版本是否匹配
- Hub / Worker Agent 当前 `projectRoot` 是否与本工作区应使用的远端项目目录一致

切换本地项目后，旧项目 Agent 即使端口仍可达也不会通过检测。目录缺失或不一致时，单独校验、单独预演、运行、复现和运行全部计划均会阻断；点击“准备 Agent 并启动”可重写当前项目的 Xshell 自启动命令、启动 Agent 并重新检测，避免把新 Plan 发到旧项目目录。

### 刷新数据

刷新只重新拉取本地隧道已连接端点的状态，不会新增任何直连远程访问路径。

## 项目自动接入与实验输出捕获

新建或修改研究项目前，先阅读 [docs/plugin-project-contract.md](docs/plugin-project-contract.md)。该文档定义工作区结构、Plan/config、输出接口、标准结果 schema、快照文件、Xshell/SFTP 路径边界、Debug 隔离和 API 使用的硬性要求。

插件目标不是强制项目按固定代码结构重写，而是自动生成一层轻量接入模板，由用户把模型输出映射到统一结果契约。入口在“实验准备”卡片：

多配置项目会扫描常见的 `configs/`、`config/`、`conf/`、`cfg/` 和 `experiments/config(s)/` 布局及根目录常见配置文件，并优先把文件名或子目录中明确包含 `smoke`、`sanity`、`debug`、`quick`、`tiny`、`mini`、`small` 或 `toy` 的配置标为“推荐首跑”，其次才考虑明确的 `base` 或 `default` 配置。配置选择器会直接展示静态读取到的 epoch、step、iteration 和训练样本限制，并区分“小规模参数”“需核对规模”和“未预读规模”；只预读前 24 个高优先级配置，选择后仍会在创建 Plan 前再次检查。普通配置目录名本身不构成推荐依据，避免按字母顺序把完整训练配置误标为推荐。

同一优先级也用于项目配置摘要的 80 文件读取预算。即使项目包含大量配置，首跑候选仍会优先进入参数预览和项目关键入口，不会因文件名排序靠后而被截断。
配置参数预览会把 YAML、JSON、Python、单值、对象和列表等内部类型显示为中文标签；悬停仍可查看原始类型，打开动作明确写为“打开配置文件”，避免新项目误以为需要打开内部 config 对象。

- `生成 Plan 模板`：根据当前工作区的 `configs`、`train.py`、`test.py` 生成可编辑计划。
- `生成输出接入模板`：写入 `experiments/simple_adapter/`、`experiments/simple_project.yaml`、`simple_cluster/contracts/output_contract_guide.md`，并保留 `simple_cluster/templates/` 兼容副本。

多入口项目的选择列表会直接展示每个高优先级脚本可静态生成的命令，并标出未识别的配置参数、结果参数和位置参数。为避免大型项目首跑变慢，只预读前 12 个入口且始终包含推荐入口；最终选中的脚本仍会在命令确认中再次检查。

最终结果文件输入框会说明建议路径的来源：固定结果参数、输出重定向和 `{result_csv}` 属于命令中的明确证据；只有输出目录时，标准结果文件名属于静态推断；完全未识别结果参数时才使用项目级默认路径。包含推断的建议会明确要求核对，最终摘要再次列出结果依据。

运行模式选择列表会直接展示已发现的训练和评估入口。只有训练入口时推荐“仅训练”，只有评估入口时推荐“仅评估”，两者齐全时推荐“训练并评估”；缺失所选阶段入口时明确标记“需手动命令”，不会把未发现脚本误装成可直接运行。

`生成 Plan 模板` 采用插件调度主格式：`suite / base_config / mode / seeds / paper / runner / naming / cases`。存在多个训练或评估入口时必须先明确选择，不会静默使用扫描到的第一个脚本。生成建议前会静态读取入口中的 `argparse.add_argument`、`click.option` 与 `typer.Option` 声明，只加入脚本真实声明的 config、seed、output、result、case、suite 和 worker 参数；不会导入或执行项目代码，也不会再向所有脚本强行注入一组假定参数。未识别的位置参数、配置参数或结果参数会直接显示在命令确认提示中，必须由用户确认或补齐。若入口命令要求 `{config}` 但项目未发现配置，必须先创建并选择真实配置；命令完全不使用配置时，插件会生成一个真实的最小 YAML 以满足调度契约，不再写入不存在的占位路径。确认评估命令后还会单独确认该命令实际生成的最终结果文件；插件会从用户最终填写的结果参数、输出目录或重定向路径重新推断，不再沿用修改命令前的初始建议。写入前会显示最终确认摘要，包括 Plan 路径、1 case × 1 seed 的任务数、基础配置、训练/评估入口、完整命令、结果路径，以及从配置中静态读取的 epoch、step、iteration 和训练样本限制。文件名或参数没有明确小规模线索时会显示警告；该检查只用于防止误启动完整训练，不会把静态线索当作实验已经安全或成功的证据。确认的项目内相对结果路径会同时写入 `paper.result_csv` 和首个 case 的 `expectedResults`；case 还会显式写入与原调度默认值完全一致的 `outputDir`。因此提交确认、调度工作目录、输出契约检查和结果解析读取同一组路径，后续增加 case 或 seed 时也能直接看到每个任务的目录模板。绝对路径、越界路径和不支持的扩展名会被阻止。手写或外部导入的计划可以继续使用 `experiments`，但建议把每个实验迁移成 `cases` 条目，并把随机种子统一放入顶层 `seeds`。调度 runtime 会同时识别当前实验条目第一层的 `case`、`name`、`id`，即使这些字段不是列表项第一行也能作为 case 名登记；`expectedResults` 内部的 `id` 不会被误当成实验 case，YAML flow map 写法也可识别。没有真实 case 时，插件不会为了凑 case 去全文件扫描 `id/name`，因此结果对象里的 `id` 只会作为结果说明。调度 runtime 允许 case 级覆盖 `base_config`、`config`、`outputDir/output_dir` 和 `runner` 命令，也支持顶层或 case 级 `command` 简写。case 级 `command` 会覆盖顶层训练命令；同一 case 内显式 `train_command` 或 `runner.train_command` 优先于 `command`。case 级 `base_config/config` 字符串、输出目录和 runner 命令都可以使用 `{suite}`、`{case}`、`{seed}`、`{config}`、`{base_config_path}`、`{resultCsv}` 等模板变量。这样同一个计划中可以混合多个配置文件、多个输出目录和不同训练命令，不会把所有实验错误套用顶层配置。本地 Plan 门禁与 Scheduler 使用相同配置来源规则，顶层内联配置、case 级配置文件和 case 级内联配置不会再被误报为缺少 `base_config/config`；界面会明确显示“Plan 内联配置”或“case 级配置”，不会拿项目扫描到的其他配置冒充当前 Plan 配置。

新建指标 Plan 时可选择“训练并评估”“仅训练”或“仅评估”。`train_test` 要求训练和评估命令，`train` 只要求训练命令，`test` 只要求评估命令。mode 省略时由 Hub、Dry-run、Scheduler 和 Worker 根据实际命令推断；两个阶段命令都存在时为 `train_test`。不会执行推断模式之外的入口。

文件名中的 `smoke`、`debug`、`tiny` 只作为提示，不会单独解除规模警告；只有可静态确认的小 epoch、step、iteration 或样本限制才会降低警告级别。

“实验准备”可在“正式运行”和 `Debug` 间切换。`Debug` 只提交首个任务，实时返回控制台状态，并把日志与产物隔离到 `simple_cluster/debug_runs/`；它不会进入结果解析、归档、统计、论文或 PPT 流程。Debug 成功后，任务页下一步会直接提供“打开 Debug 日志”和“正式运行”，先复核日志与输出，再提交完整 Plan；失败、停止或取消时直接进入失败日志复核，不自动重试。已有正式运行、旧任务和历史结果的生命周期不受 Debug 状态影响。

入口命令使用 `{result_csv}` 但没有提供固定结果文件时，引导默认建议 `{output_dir}/metrics_summary.csv` 或对应 JSON/TXT/LOG 文件，而不是项目级共享 CSV。矩阵 Plan 生成器和预置项目模板也使用同一 per-job 路径。首个单任务行为不变；以后增加 case 或 seed 时，每个任务仍写入自己的 job 输出目录，避免并发覆盖和跨任务结果混合。命令已经明确固定文件时继续尊重原路径，并在最终确认窗口要求用户核对。

运行实验前，Extension 与 Scheduler 都检查 Plan 的输出契约。指标实验继续要求可解析的结果接口，可选择 `run_wrapper`、显式 adapter 调用或 TensorBoard。通用命令 Plan 可以省略配置文件和指标接口，但必须声明 `runner.outputs`；Scheduler 检查路径边界、输入存在性，并在命令成功后确认声明的产物已经生成。通用产物不会自动变成指标或论文证据。省略 `mode` 时按实际训练/评估命令推断；未声明 seeds 时使用一个 seed `42` 和 `baseline` case。

运行门禁在 UI 和 Extension 中使用同一组中文检查项，避免按钮看似可用但后台被阻断：

- `接入配置`：指标采集需要存在 `experiments/simple_project.yaml`、插件生成的接入配置，或当前 Plan 中的可解析输出声明；通用任务使用 `runner.outputs` 即可调度。
- `计划输出`：指标 Plan 需要声明可解析候选；通用 Plan 需要声明 `runner.outputs`。单独 `output_dir` 不算产物声明。
- `候选结果规则`：需要至少一种候选 CSV / JSON / 控制台日志 / 文本 summary / `metricRegex` 捕获规则。
- `标准结果契约`：推荐使用 `metrics_summary.csv`、`metrics_case.csv` 或输出接入模板；`artifact_manifest.json`、`env_snapshot.json`、`config_snapshot.yaml` 只作为运行与环境证据，不能单独充当实验结果。
- `解析预览`：只表示已有结果是否能解析出指标。首次运行尚无结果时，只要当前 Plan 或接入规则已经声明可解析结果位置，就不会因缺少预览而阻断。

硬阻断条件是：缺少 `接入配置 / 计划输出`，缺少候选或契约声明，或 Scheduler 输出接口报告未找到 wrapper / adapter call / TensorBoard scalar 任一验证通道。TensorBoard 路线要求远端 Python 能导入 `tensorboard`；任务结束后 Scheduler 会用其 EventAccumulator 读取每个 tag 的最终 scalar，写入任务目录的 `tensorboard_scalars.csv`，仅在任务目录没有 `metrics_summary.csv` 时生成标准结果文件，并补齐快照。不会向项目级共享结果表追加 scalar 行。Dry-run 成功后会删除本次 worker 临时输入；超过 24 小时的同名 runtime worker 临时文件也会按精确文件名清理，不会扫描或删除其他路径。

如果门禁失败，错误会按缺失项给出中文修复动作：生成 `experiments/simple_project.yaml`、补候选 CSV / JSON / 控制台日志 / 文本日志 / 正则规则、让测试代码输出 `metrics_summary.csv`，或保存规则后刷新识别并查看解析预览。

运行完成后的输出契约检查以当前 Plan 为边界，接受 Plan 声明、任务登记或同一输出目录中可解析的 CSV、JSON、TXT、LOG、OUT；`metrics_summary.csv` 是推荐规范，不是唯一有效格式。至少一个候选文件必须包含数值指标，并同时存在 `env_snapshot.json` 与 `config_snapshot.yaml`。状态 JSON、manifest、jobs 和插件内部状态文件不会充当有效结果；其他 Plan 的结果或快照也不会补齐当前 Plan。相同排除规则同时用于项目扫描、Plan 门禁、接入规则和生成的 result writer；旧接入配置中的无效候选会显示为已忽略，不会让项目错误显示为可运行。

推荐接入顺序：

1. 打开项目后先看“实验准备 > 项目接入”的自动识别结果。
2. 如果训练入口、测试入口、配置、候选结果或项目风格线索不足，点击 `生成 Plan 模板`。
3. 如果输出捕获规则不足，点击 `生成输出接入模板`。
4. 在“分类指标与输出捕获配置”中确认 `candidateCsv`、`candidateJson`、`consoleLogs`、`textLogs`、`metricRegex`、`csvColumnMapping` 和 `metricAliases`。
5. 点击 `保存接入规则`，让规则写入 `experiments/simple_project.yaml`。
6. 在“项目关键入口”核对当前 Plan 或接入规则给出的真实结果位置并确认运行门禁；已有结果时再检查解析预览，首次运行无需先生成结果。

自动识别会扫描常见入口、配置和轻量结果目录。配置中如果出现 `result_csv`、`results_csv`、`metrics_csv`、`summary_csv`、`output_csv`、`result_json`、`metrics_json`、`summary_txt`、`log_file`、`output_dir`、`result_dir`、`results_dir`、`work_dir`、`workdir`、`save_dir`、`log_dir` 等字段，插件会推断候选结果文件。轻量目录会覆盖 `experiments/results`、`work_dirs`、`outputs`、`runs`、`logs`、`results`、`test_results` 和 `lightning_logs`，但不会扫描 `datasets`、`checkpoints`、`weights` 等大目录。常见 `metrics.csv`、`scores.csv`、`classification_report.csv`、`summary.txt`、`stdout.log`、`output.out` 也会作为候选输出。JSON 结果支持 `results/records/runs/items` 记录数组、嵌套 `dimensions/metadata/config/run` 维度、嵌套指标对象，以及 `{name, value}`、`{metric, score}` 形式的指标列表；本地预览和 Hub Agent 使用相同规则，没有数值指标的 JSON 不会被误判为可解析结果。分类框架常见的 `Trainer`、`LightningModule`、`classification_report`、`acc@1`、`acc@5`、`roc-auc`、`pr-auc`、`matthews_corrcoef` 和 `cohen_kappa` 会被识别为结果线索或指标别名。

生成物说明：

- `experiments/simple_project.yaml`：项目接入配置，记录入口命令模板、结果文件、控制台解析和工厂模式 hook，可以随项目代码提交。
- `experiments/simple_adapter/result_writer.py`：标准结果写入和 CSV / 控制台输出归一化。
- `experiments/simple_adapter/run_wrapper.py`：不改训练代码时使用，负责执行原训练或测试命令、捕获 stdout / stderr、生成 `metrics_summary.csv`。
- `experiments/simple_adapter/collect_results.py`：对已有实验目录做结果收集。
- `experiments/simple_adapter/console_parser.py`：集中维护控制台指标正则。
- `experiments/simple_adapter/factory_hooks.py`：面向使用 builder / registry / factory 写法的研究项目，提供最小 hook 示例。
- `paper/claims.md`：论文 claim 证据清单模板，用于“检查论文证据”按钮和结果证据工作台。

这些模板随 VSIX 打包在 `dist/templates/project-adapter/` 中。安装插件后，即使当前打开的是任意实验项目，生成模板也不依赖插件源码仓库路径。

当前默认接入策略以分类任务为主，分割任务作为兼容场景保留。`experiments/simple_project.yaml` 会写入 `taskType: classification`、`primaryMetric: AUC`、`secondaryMetrics`、`classificationMetrics` 和 `segmentationMetrics`。后续结果解析预览、论文表格和质量门禁会优先围绕分类指标组织；偶尔需要分割实验时，`Dice`、`DSC`、`IoU`、`HD95`、`ASD` 仍会被扫描和校验。Hub Agent 的结果 runtime 会读取这些策略，按分类指标优先排序，自动把 `val_auc`、`test_f1`、`best_acc` 等常见前后缀归一到标准指标。
项目接入规则摘要和详情会把 `classification`、`segmentation`、`regression`、`detection` 等内部任务类型显示为“分类”“分割”“回归”“目标检测”；配置编辑器仍保留原始值，未知类型原样显示。

### 推荐输出契约

结果分析、质量门禁、统计检验和论文表格优先读取标准轻量文件：

- `metrics_summary.csv`：主指标长表，至少包含 `experiment_id`、`suite`、`method`、`dataset`、`split`、`seed`、`metric`、`value`。
- `metrics_case.csv`：可选 case 级结果，用于失败样本、病例级统计、配对检验。
- `env_snapshot.json`：Python、Torch、CUDA、Git commit、启动命令等环境快照。
- `config_snapshot.yaml`：本次实验实际配置快照。
- `artifact_manifest.json`：产物清单。checkpoint、权重、大数据不默认下载到本机，只在 manifest 中记录。

### 手动实验运行记录器

未通过 Hub scheduler 启动的手动实验也可以进入证据链。使用统一命令 `simpleex run`：

```powershell
simpleex run --name baseline --seed 1 --config configs/a.yaml -- python train.py --config configs/a.yaml --seed 1
```

`simpleex run` 会在当前项目写入 `experiments/runs/<run_id>/`：

- `command.txt`
- `stdout.log`
- `stderr.log`
- `env_snapshot.json`
- `config_snapshot.yaml`
- `artifact_manifest.json`
- `metrics_summary.csv`，当 stdout/stderr 中能捕获 `AUC: 0.932 accuracy: 89.5% F1=0.88` 这类指标时自动生成。

这些文件可被 `parse-results`、`check-claim-evidence`、`export-paper-table` 和 PPT 绘图契约识别。手动命令仍在本机当前工作区执行；远端实验应继续通过计划和 Agent 调度，不要用 CLI 绕过集群边界。

### 任务结束、中断与结果权威

插件必须区分三类任务终态：

- 正常结束：训练或测试进程收到明确 exit code，Worker / Hub 记录为正常 `completed` 或 `failed`。
- 手动中断：用户主动点击停止。停止原因分为“代码有误或实验无价值”和“模型已收敛无需继续跑”。这两类都视为用户确认的完成态，但必须保留 `manualInterrupted`、`interruptionKind` 和停止说明，后续由用户按普通实验记录审核是否解析、归档或删除。
- 被动中断：Worker/Agent 断线、服务器重启、系统杀进程、GPU 抢占、OOM 后未收到用户手动停止意图等。被动中断不应直接当作最终失败结果；scheduler 应把任务放回 queued / polling 计划等待重跑，清理该次 attempt 的无用临时衍生文件，并增加下一轮调度等待时间，避免连续把服务器挤爆。

为了防止脏分析，真正进入论文统计、论文表格、claim 证据和 PPT 绘图契约的结果必须来自已归档结果。每个 Plan 会生成 `results_preview_all.csv`，保留全部解析记录供人工比较；`results_effective_archived.csv` 只保留已归档记录，是统计和归档包使用的有效 CSV。人工审核不会替代归档，未归档结果只作为待审核或排除线索显示。“打开完整预览”和“打开有效结果”使用独立结果文件入口，不会把 CSV 误选为当前 Plan；远端文件会先显示当前 Plan、远端来源和预期本地只读副本位置，再通过 Hub 的受限轻量下载接口打开，本地已有文件时可选择直接打开。旧版单 Plan 摘要若有可靠且匹配的顶层 `planFile`，未标记 Plan 的结果行继承该归属；没有可靠顶层 `planFile` 的混合摘要只保留带当前 Plan 标记的结果行，并重新计算预览、有效和待审核数量。任何显式属于其他 Plan 的行都会被排除；发生混合过滤时，CSV、质量门禁、统计、claim、论文表与 PPT 路径全部隐藏，必须重新解析当前 Plan 后才能作为分析证据。

结果工作台入口使用“数据集画像”“检查点清理预案”“统计结果”“论文表格”“样本级结果”和“异常原因”等中文标签；悬停和数据属性仍保留原始字段名，便于排查兼容问题。

当 Plan 的已知任务均已结束且至少一条结果已归档为有效结果时，可以归档为 `experiments/plans/_archived/<plan>__archive/` 包；只有待审核或排除记录时会阻止归档 Plan。任务终态判断与任务页一致，`error`、`stalled`、`cancelled`、`canceled` 等异常终态不会被误判为仍在运行而永久阻塞归档。归档还必须具备当前 Plan 的完整预览 CSV 和有效结果 CSV；缺失时按钮直接提示重新解析。确认窗口会列出归档包位置、证据来源以及每个远端来源到包内 `evidence/` 的预期位置。Hub 在线时，插件在确认后把当前 Plan 的最新轻量 CSV、JSON、Markdown 和文本证据只读下载到 staging 包，全部成功后才迁移 Plan 和独占配置；任一证据缺失、越界、超限或下载失败都会清理 staging 并保留原 Plan。离线或旧 Agent 模式只使用本地已有证据，缺文件时阻止归档。`archive_manifest.json` 的 `evidenceSource` 会记录来源模式、Plan 和单文件上限，远端实验产物不会被删除。包内包含 `plan.yaml`、Plan 引用的配置副本、项目依赖环境清单、入口脚本与 CLI 参数快照、有效结果 CSV、完整预览 CSV、统计和证据文件及 `archive_manifest.json`。配置收集同时识别普通 YAML 字段、inline flow map、YAML/JSON/Python 配置，以及 runner 命令中 `--config`、`--config-file`、`--config-path`、`--base-config`、`--cfg` 和 Hydra 风格 `config=` 的固定项目内路径；注释、模板变量和内联配置对象不会被误当作配置文件。固定命令配置会参与运行前存在性检查、独占/共享判断、归档复制和恢复路径改写，避免归档后命令继续指向已迁移的旧文件。环境快照覆盖当前项目可识别的 `environment.yml`、`requirements*.txt`、`pyproject.toml`、Pipfile、Poetry、uv 和 `requirements/` 清单，不包含 `.env`、凭据、数据集或模型权重。`parameters/cli_parameters.json` 会识别直接脚本和 `python -m package.module` 入口，并递归静态检查其项目内 Python import，避免把间接定义在 options/parser 模块中的 argparse 参数漏掉；仅入口及包含 CLI 证据的源码会复制到 `parameters/entries/`，扫描有文件数和字节预算且不会导入或执行项目代码。快照记录 argparse、Click、Typer 参数、parser 与子命令构造声明、完整关键字表达式、显式默认值、框架隐式默认值、`default_factory`、`argument_default`、按声明顺序生效的 `set_defaults`、`dest`、`const`、`envvar`、类型、choices、required、action 和 nargs；位置参数 `nargs="*"`、`argparse.ZERO_OR_MORE`、`argparse.REMAINDER`、`argparse.OPTIONAL`、`argparse.SUPPRESS`、子命令 selector、Click 成对布尔 flag 和子 parser 默认值会保留，同名的子命令参数不会被去重丢失，可识别的参数组会继承所属 parser 的默认设置，注释和 docstring 内的示例声明不会误计。动态参数名、`**kwargs`、动态默认表达式、parser parents、namespace 默认值、非标准 prefix、链式参数组、Typer 普通函数或 Annotated 签名、导入别名装饰器、Click 便捷装饰器和源码扫描预算警告会记入待复核计数，并在归档卡显示“参数待复核”，不得把静态快照当作完整运行时证据。Plan 内联参数仍以 `plan.yaml` 为准，配置默认值仍以归档配置为准，待复核项必须结合归档结果中的 `config_snapshot.yaml` 或 `command.txt` 佐证。归档会迁移仅被该 Plan 引用的配置文件，以及本地模式下该 Plan 独有的 `simple_cluster/results/by_plan/` 结果和分析文件；仍被活动 Plan 引用的配置及项目级环境清单会保留原位置。`archive_manifest.json` 会列出迁移和保留项。未纳入有效结果的记录会写入 manifest 的 `excludedResults`，不会污染最终结果；大体积运行产物继续由既有 Hub/Worker 归档保存。

归档卡的“恢复新版本”始终生成独立版本 `experiments/plans/_restored/<plan>__vN.yaml`，并把关联配置、环境清单和参数资料复制到 `experiments/restored_assets/<restored-plan>/`。恢复前强窗口会展示新 Plan、恢复资产目录、`__restored_vN` 输出命名空间，以及静态推断出的预期结果文件位置。插件会改写该版本 Plan 的所有标量配置引用，包括 flow map 内的 case 配置和 Python 配置；同时为输出目录、固定 CSV/JSON/TXT/LOG/MD 结果路径、结果列表和命令内固定输出参数加入版本命名空间。恢复完成后自动切换到 Plan 工作台，版本标签、环境快照、参数快照和“校验并提交运行”入口会一起显示，不再强制跳转打开 YAML。该目录参与正常代码同步，Hub 与 Worker 能收到重跑所需配置。旧版 `simple_cluster/restored_configs/` 引用属于不会上传的本地状态目录，运行前会被明确阻断，必须从归档卡重新恢复。每个版本的结果按完整 Plan 路径写入独立 `simple_cluster/results/by_plan/` 范围，恢复记录写入 `simple_cluster/plan_restores/`，因此同一逻辑 Plan 的历史结果和重跑结果不会混合，也不会覆盖旧版本的固定输出文件。

Plan 卡会提前显示“归档条件”。任务未结束、没有解析结果或没有已归档有效结果时，归档按钮直接禁用并给出修复原因，与后端归档门禁保持一致。

归档时会额外生成 `evidence/result_selection.json`。该文件完整保存当前 Plan 每条结果的取舍状态、来源和关键维度，不受 `archive_manifest.json` 内 200 条兼容预览上限影响，也不会混入其他 Plan。强窗口、Plan 卡和归档卡分别显示有效结果与未纳入结果数量；未纳入记录不会进入有效 CSV、统计、论文表或 PPT，但可在归档卡点击“结果取舍”复核。

### Checkpoint 管理

Checkpoint 清理只先生成 dry-run 预案，不直接删除文件。Hub/Worker Agent 的 `plan-checkpoint-retention` action 会读取 `artifact_manifest.json`、`checkpoint_manifest.json`、paper freeze、manual review 和运行状态，输出：

- `simple_cluster/checkpoints/delete_plan.json`
- `simple_cluster/checkpoints/retention_report.md`

保留策略包含 `keep best/latest/topK`、`minAgeDays`、`protectPaperReady`、`protectRunning`、`protectFrozen`。删除候选必须同时满足“路径位于项目安全范围内”和“路径来自 manifest 声明”。不在 manifest 内、跨项目、指向源码或凭据的路径会被跳过。

### Dataset Inspector

Dataset Inspector 是轻量画像，不做重型全量索引，也不会把数据集下载到本机。`inspect-dataset` action 默认检查项目内 CSV/split 文件，输出：

- `simple_cluster/datasets/profile.json`
- `simple_cluster/datasets/profile.md`
- `simple_cluster/datasets/leakage_report.csv`

MVP 支持 class 分布、split 分布、`patient_id` / `case_id` 泄漏、文件存在性检查和缺失字段提示。它复用 case-level 语义：`case_id` 表示样本或病例键，`patient_id` 表示病人级防泄漏键。缺少 `patient_id` 时会给 warning，而不是假装已经完成病人级检查。

### 实验配置反推器

已有 run 目录缺少原始 plan 时，可以在“结果与归档 / 实验记录详情 / 配置文件”区域点击“反推配置”或“恢复 Plan”。Agent action：

- `infer-config-from-run`：只读取 run 目录、日志、manifest、snapshot 和结果索引，输出字段置信度与中文建议，不执行命令。
- `recover-plan-from-run`：在 `simple_cluster/plans/recovered/` 写入可编辑、可重新运行的 plan/config 建议。

输出文件：

- `simple_cluster/plans/recovered/<run_id>.yaml`
- `simple_cluster/plans/recovered/<run_id>.json`
- `simple_cluster/plans/recovered/<run_id>.report.md`

反推会尝试识别 `run id`、`suite`、`case`、`method`、`dataset`、`split`、`fold`、`seed`、train/test command、config path、output dir、result csv/json/log、Worker/GPU、Git commit、code fingerprint 和 env/package snapshot。缺关键证据时会标记 `missing`、`low_confidence` 或 `needs_user_input`，例如提示“缺少 seed，建议从 log 或 config_snapshot.yaml 补齐”。

### 结果异常定位器

单条结果可以点击“异常诊断”或“对比最优配置”。Agent action：

- `diagnose-result-anomaly`：对当前 run/result 按指标、日志、配置、环境和输出契约排序可解释原因。
- `compare-with-best-config`：从同 `suite/dataset/split/metric` 的 result registry 中找最优 run，读取双方 `config_snapshot.yaml` 或反推配置结果，做结构化配置差异。

输出文件：

- `simple_cluster/results/anomaly/<result_id>.json`
- `simple_cluster/results/anomaly/<result_id>.md`
- `simple_cluster/results/anomaly/<result_id>.config_diff.json`

异常规则包括：主指标低于同组最优阈值、低于同组均值超过 N 个 std、lower-is-better 指标异常升高、结果缺失或解析失败、日志包含 NaN/OOM/Traceback/CUDA error/missing file/shape mismatch、关键配置与最优 run 差异明显。如果找不到同组最优，报告会明确标记“不可直接比较”，不会强行给结论。

### PPT 绘图插件输出契约

给 `D:\GitRepo\my_ppt_app` 的稳定机器可读契约见 `docs/output-contract-for-plotting.md`。核心输出包括：

- `simple_cluster/results/result_registry.json`
- `simple_cluster/results/statistics.json`
- `paper/tables/simple_results_table.csv`
- `simple_cluster/results/case_level_index.json`
- `simple_cluster/datasets/profile.json`

稳定字段覆盖 `method`、`dataset`、`split`、`fold`、`seed`、`metric`、`value`、`mean`、`std`、`ci`、`pValue`、`adjustedPValue`、`significant`、`case_id`、`patient_id`、`subgroup`、`error_type`。PPT 插件应读取这些轻量 JSON/CSV，不应扫描原始数据集或 checkpoint 目录。

SCI 绘图默认使用最终聚合结果，而不是单个 seed 原始结果。数值图优先读取 `simple_cluster/results/statistics.json` 中的 `mean/std/ci`，其次读取 `paper/tables/simple_results_table.csv` 长表；`result_registry.json` 和单个 `experiments/results/*.csv` 只用于发现、追踪和审计。若用户从单条结果路径旁点击“聚合绘图”，请求仍会带上 `selectedResultId/runKey/archiveKey` 上下文，但 `sourcePaths` 会指向最终聚合统计文件。缺少统计文件时，插件会提示先运行“统计”或“导出论文表格”，不会把单个 seed 直接画成论文图。

点击“绘图到 PPT”时，集群插件只发现轻量结果文件、生成请求审计并调用本机 RoughPptAddin automation server；不会在 VS Code 内绘图，也不会连接 Zotero 或读取 Zotero DB。调用前的强制确认窗口会列出当前 Plan/revision、最终结果源、绘图契约、目标 PPT、本地请求审计目录、图类型和样式；执行绘图请求时会在 `simple_cluster/results/ppt_plot_requests/` 写入轻量 JSON 请求和响应审计，提交通知会直接提供“打开请求审计”和“打开响应审计”，且只允许打开当前项目内文件。取消时不会调用 PPT 插件、写请求审计或显示已提交。可只确认本次，也可对当前项目的完全相同 PPT 目标关闭后续提醒；目标路径变化后自动恢复询问，记录保存在 `simple_cluster/ui/ppt_path_confirmations.json`，可在“设置 -> 服务器 -> PPT 路径提醒”中恢复。Zotero 图片、配色或引用上下文只能由 PPT 插件在 PowerPoint 侧间接消费。automation discovery 固定为 `%LOCALAPPDATA%\RoughPptAddin\automation.json` 和 `%LOCALAPPDATA%\RoughPptAddin\automation.token`，endpoint 会归一化为根地址，调用顺序固定为 `GET /health` 后 `POST /api/simple-experiment/plot`，且 endpoint 必须是 `127.0.0.1` 或 `localhost`。`target.presentationPath` 为空表示新建 PPT，非空表示在该 PPT 追加新页。`sourcePaths` 只允许 JSON、CSV、Markdown、TeX 等轻量文件；缺少分析文件只提示缺文件，不扫描 raw dataset、checkpoint、权重或大日志。Markdown 源有同名 JSON 时优先发送 JSON，否则发送 `markdownSummary` 生成摘要页。

PPT automation 只在结果绘图阶段检测，不参与新项目接入、实验运行、结果解析或归档门禁。结果页会核验 discovery 与 health 的 `schemaVersion=1`、令牌和本机 endpoint，并区分 PowerPoint 未启动、令牌缺失或失效、版本不兼容及 HTTP 409 忙碌；状态异常时禁用绘图并只提供启动 PowerPoint、重新检测或查看修复说明中的一个动作。真实 PowerPoint 插入行为仍标记为 `needs field verification`。

结果工作台只会启用当前 Plan 已由结果摘要或成功 operation 证明存在的 PPT 来源。统计、论文表格、绘图契约、case level、异常报告和恢复报告未生成时，对应按钮保持禁用且状态显示“等待分析文件”；不会再用固定占位路径伪装成可绘图。切换 Plan 后不会沿用上一 Plan 的分析文件入口。

结果闭环的唯一下一步按实际顺序推进：质量门禁、统计、论文证据、论文表格、PPT 绘图契约、绘图到 PPT。论文证据存在 `unsupported` 或 `needs experiment` 时不会重复执行同一个检查，而是直接打开 `paper/claims.md` 供修正证据引用或标记待补实验；保存后从结果操作重新执行“检查论文证据”。论文表格生成后会继续引导导出绘图契约，不再停在无意义的“刷新结果”。

统计输出会写入 `simple_cluster/results/statistics.json`。只纳入已归档结果，人工审核不能替代归档；统计按 `suite/method/dataset/split` 分组，并在 `seed/fold/case` 等重复实验维度上聚合。每个指标至少包含 `n`、`value`、`mean`、`std`、`median`、`ci/ci95`、`best` 和 higher/lower 方向；当两个方法在相同 `dataset/split/fold/seed/case` 上有共享样本时，会额外生成配对比较摘要、胜负平计数和无 scipy 环境下的近似 `pValueApprox`。该近似值用于运维预览，正式论文统计仍建议在导出的结果上复核。

### 论文 claim 证据链

Hub runtime 会在解析结果、点击“检查论文证据”和导出论文表格时检查 `paper/claims.md`，并写入 `simple_cluster/results/claim_evidence.json`。每条 claim 需要显式关联到 `experiments/runs/`、`experiments/results.csv`、`experiments/results/*.csv` 或可识别的 run/result key；无法关联时会标记为 `unsupported` 或 `needs experiment`，不会在 UI 中显示为已完成。

推荐写法：

```markdown
- AUC 达到 0.91，证据 experiments/results/metrics.csv
- 消融实验证明模块 A 有效，evidence: experiments/runs/ablation_a
- 外部数据集显著提升，needs experiment
```

结果证据工作台会显示 claim 总数、已支持数、`unsupported` 数、`needs experiment` 数和证据文件路径。该检查是本地/Hub 侧轻量文本与结果索引扫描，不会触发额外远端通信。

### CSV 怎么获取

模板会优先使用已经存在的 CSV，不要求项目一开始就完全按插件 schema 输出。

默认扫描位置：

- `metrics_summary.csv`
- `results.csv`
- `work_dirs/results.csv`
- `experiments/results/*.csv`
- `test_results/summary.csv`
- `test_results/detailed_metrics.csv`

如果 CSV 已经是 `metric,value` 长表，模板会直接归一化。当前默认优先面向分类任务，常见宽表列名包含 `AUC`、`AUROC`、`ROC_AUC`、`AUPRC`、`average_precision`、`accuracy`、`top1_accuracy`、`top5_accuracy`、`F1`、`macro_f1`、`weighted_f1`、`precision`、`recall`、`sensitivity`、`specificity`、`balanced_accuracy`、`MCC`、`kappa`、`ECE`、`brier`、`log_loss`、`loss` 时，会展开为 `metrics_summary.csv` 长表。常见训练脚本里的 `val_auc`、`test_auc`、`best_auc`、`val_acc`、`test_f1`、`val_loss`、`train_loss`、`macro_auc` 等前缀或后缀写法也会自动归一到标准分类指标，并保留能识别出的 `train / val / test / external` split。分割指标仍保留为附带兼容，例如 `Dice`、`DSC`、`IoU`、`HD95`、`ASD`。已有项目中的 `work_dirs/results.csv`、`experiments/results/<group>.csv` 可以通过这种方式接入。

额外 CSV 可以由项目代码显式传入：

```python
from simple_cluster.templates.simple_output_adapter import collect_outputs

collect_outputs(
    output_dir="work_dirs/run_001",
    context={
        "experiment_id": "run_001",
        "suite": "ablation",
        "method": "ours",
        "dataset": "VinDr",
        "split": "test",
        "seed": 42,
    },
    extra_csv_paths=["work_dirs/results.csv", "experiments/results/ablation.csv"],
)
```

### 只有控制台输出怎么获取

Worker Agent / scheduler 会把运行命令的 stdout、stderr 和日志尾部保存为轻量日志，用于 UI 展示和归档。若某个项目暂时只打印指标，不写 CSV，可以在训练或测试结束时把 stdout/stderr 文本传给模板：

```python
collect_outputs(
    output_dir="work_dirs/run_001",
    context={"experiment_id": "run_001", "suite": "smoke", "dataset": "demo", "split": "test", "seed": 42},
    stdout_text="AUC: 0.932 accuracy: 89.5% F1=0.88 loss=0.13",
)
```

默认正则会优先捕获分类指标，如 `accuracy`、`top1`、`top5`、`AUC`、`AUROC`、`ROC_AUC`、`AUPRC`、`average_precision`、`F1`、`macro_f1`、`weighted_f1`、`precision`、`recall`、`sensitivity`、`specificity`、`balanced_accuracy`、`MCC`、`kappa`、`loss`、`log_loss`、`ECE`、`brier`。日志里出现 `val_auc=0.93`、`test_acc: 89.5%`、`best_f1=0.88`、`train_loss=0.13` 这类写法也会识别。分割指标 `Dice`、`DSC`、`IoU`、`HD95`、`ASD` 仍可识别。更复杂的日志格式应在生成的 adapter 中修改 `METRIC_PATTERN` 或新增自定义 parser。

### 工厂模式接入

如果项目已经使用 builder、registry 或 adapter 工厂模式，建议不要把插件逻辑混入模型、trainer 或数据集主体代码。推荐新增一层输出 adapter：

```python
from simple_cluster.templates.simple_output_adapter import DefaultDeepLearningAdapter, register_adapter

@register_adapter("multimodal")
class ProjectOutputAdapter(DefaultDeepLearningAdapter):
    def collect(self, output_dir, context=None, stdout_text="", stderr_text=""):
        context = dict(context or {})
        context.setdefault("results_csv", "work_dirs/results.csv")
        return super().collect(output_dir, context=context, stdout_text=stdout_text, stderr_text=stderr_text)
```

训练或测试结束后只调用：

```python
from simple_cluster.templates.simple_output_adapter import collect_outputs

collect_outputs(
    output_dir=cfg.test.output_dir,
    context={"experiment_id": run_id, "suite": suite, "dataset": dataset, "split": "test", "seed": seed},
    adapter="multimodal",
)
```

这样插件负责结果解析、质量门禁、统计分析和论文表格；项目仍负责模型、训练、测试和原始输出。

### 在 UI 中调整分类指标和捕获规则

“实验准备”的“项目自动接入工作台”提供“分类指标与输出捕获配置”。这里可以直接配置：

- 任务类型与主指标，默认 `classification` 和 `AUC`。
- 分类指标池，例如 `accuracy`、`F1`、`AUPRC`、`precision`、`recall`、`specificity`、`balanced_accuracy`、`loss`。
- 分割兼容指标，例如 `Dice`、`DSC`、`IoU`、`HD95`、`ASD`。
- 候选 CSV、候选 JSON、控制台日志、summary 文本、CSV 列映射和指标别名。

点击“保存接入规则”只会写回本地轻量配置 `experiments/simple_project.yaml`，不会修改训练代码，不会发起远程连接。保存后插件会重新识别项目并刷新结果解析预览。后续一键运行或代码同步时，该配置会随项目代码通过 `SimpleSFTP` 同步到 Hub/Worker。

如果项目还没有 `experiments/simple_project.yaml`，插件会先从 `configs/**/*.yaml`、`configs/**/*.json`、`configs/**/*.py`、`metrics` 配置、`result_csv/results_csv`、`experiments/common.py`、`experiments/collect_results.py`、`experiments/run_plan.py`、`comparison_methods/registry.py` 等线索推断分类指标和结果捕获路径。Python 配置只做静态读取，不导入模块、不执行配置代码。推断结果会显示在“自动推断线索”里，用户确认后再点击“保存接入规则”固化为本地配置。

## 常见问题

### `agent_version_mismatch`

处理顺序：

1. 部署最新版 Agent 到全部服务器
2. 重启对应 Hub / Worker Agent 会话
3. 再次检测全部

### Worker 长期 queued

优先检查：

1. Worker availability 是否过期
2. `allowedGpuIds` 是否把可用卡排除了
3. `maxConcurrentGpus` 是否过小
4. Worker uplink 是否断开
5. Hub 本地 cache 是否长期没有更新

### 删除或归档没有实时变化

这类操作应看 Worker 实时事件通道，而不是 SFTP。若没有变化，先检查：

1. Worker 隧道是否连通
2. Worker Agent 是否在线
3. Worker 事件流是否正常
4. Hub 是否收到终态

## 目录约定

每台服务器只配置一个“项目父目录”，插件自动派生：

```text
<项目父目录>/simple_agent
<项目父目录>/<当前 VS Code 工作区名>
```

其中：

- `simple_agent`：Agent 安装、日志、状态缓存目录
- `<当前 VS Code 工作区名>`：项目代码目录

常见路径：

```text
<项目父目录>/simple_agent/logs
<项目父目录>/simple_agent/state/projects/<项目名.项目路径哈希>
<项目父目录>/simple_agent/simple_cluster/runtime
```

### Agent cache 与项目态边界

Agent cache 是 Agent 为实时服务临时维护的运行缓存，不是实验结果，也不是项目证据。默认位置：

```text
<项目父目录>/simple_agent/state/projects/<项目名.项目路径哈希>
```

也可以由远端环境变量 `SIMPLE_EXPERIMENT_AGENT_STATE_DIR` 指向其他目录；插件自动写入 Xshell 启动命令时默认不设置这个变量，交给 Agent runtime 按项目路径生成命名空间。默认路径带项目命名空间，同一台服务器同一个 `simple_agent` runtime 被多个项目复用时，不会共享事件 journal、snapshot 或 Worker command queue。这里保存：

- 实时事件 journal，例如 `events.jsonl` 和 `seq.txt`
- GPU snapshot、Worker task snapshot、Worker availability cache
- Worker command queue 和 command result
- 上传分片临时文件
- Agent PID、lock、version、session、health snapshot

这些文件可以随 Agent 重启、清理或迁移而丢失。不要把它们当作实验证据、结果索引或项目归档同步。

项目态文件必须保存在当前项目目录内，随项目代码一起保留和迁移。典型位置：

```text
<项目父目录>/<当前 VS Code 工作区名>/experiments/
<项目父目录>/<当前 VS Code 工作区名>/work_dirs/
<项目父目录>/<当前 VS Code 工作区名>/results/
<项目父目录>/<当前 VS Code 工作区名>/simple_cluster/
```

这里保存：

- plan 文件和归档 plan
- 实验输出、日志、`metrics_summary.csv`、结果 CSV/JSON/TXT
- `simple_cluster/results/summary.json` 和 `result_registry.json`
- `simple_cluster/archive_state.json`、`archive_manifests/`
- 删除墓碑 `deleted_experiments.jsonl`、`deleted_scheduler_rows.jsonl`
- scheduler project state 和日志 `simple_cluster/tmp/cluster_scheduler/`
- debug bundle、output contract report、论文表格导出

切换项目时只应同步项目目录；Agent cache 只用于实时状态恢复。清理 Agent cache 不应删除实验结果，删除项目态文件必须通过任务区删除、归档区删除或文件传输流程执行。

## 离线导入

隧道暂时不可用时，可以通过命令或面板导入 offline bundle JSON 或导出的离线目录。导入后插件切换到 `offline_import`，不会访问网络，也不会尝试 SSH/SCP/RSYNC。

离线导入只写入当前项目目录 `simple_cluster/ui/offline_bundle.json`，并会同步恢复 bundle 内的 `results_summary.json` 到结果面板。不写全局服务器配置。为避免大型诊断包拖慢 Webview：

- `audit_tail.jsonl` 只保存行数、字节数和末尾预览，不保存完整长文本。
- `cluster_snapshot.json` 中的长任务、实验记录和 operation 列表会按预算保留前部或最近窗口，并记录总量和省略数量。
- `results_summary.json`、`diagnostics.json`、`quality_gate.json`、`paper_table.json` 会按数组、对象和字符串预算压缩后进入插件状态。
- 完整离线源仍保留在用户选择的本地 bundle 文件或目录中；需要全文日志或完整结果表时应直接打开源文件。

## 构建与验证

```powershell
npm run typecheck
npm test -- --test-reporter=dot
npm run build
```

生成可分发的离线安装包：

```powershell
npm run package:public
```

产物位于 `release/SimpleExperiment-<版本>/`，其中包含 SimpleSFTP、SimpleExperiment、离线安装脚本和独立配置说明。执行 `install-public-release.ps1` 会先安装并核验两个公开扩展，再移除旧的 `simple-local.simple-sftp-manager` 与 `simple-local.simple-experiment`，避免新旧版本同时注册相同命令和面板；其它扩展不会被修改。安装后先重载已打开的 VS Code 窗口，再从命令面板运行“SimpleExperiment：打开配置说明”，进入一键配置或插件面板。

旧扩展卸载后，尚未重载的 VS Code extension host 仍可暂时保留旧私有版状态栏对象，因此会与新版 `SimpleSFTP` 同时出现。执行 `Developer: Reload Window` 后旧对象才会释放；扩展列表只保留公开版时，无需删除项目配置或任务文件。

如果新版 SimpleSFTP 已可用但旧版扩展仍安装，SimpleExperiment 首次启动会单独提示旧版来源，并可直接打开旧版扩展管理；该提示不阻断新插件或已有任务。卸载旧版后重载窗口，界面只保留新版按钮。选择“不再提示”只关闭这条迁移提示，不会关闭运行、上传或路径确认门禁。

## 兼容行为速查

- 编辑项目父目录时，末级与当前项目名相同的重复目录警告窗口可一键改为上一级父目录。
- 切换工作区目录会清空上一项目的 Plan 选择、任务选择、结果摘要和操作内存状态，再从新项目的状态文件重新加载。
- 旧项目尚未完成的项目状态文件回读、检测或实时回调都会被丢弃；旧项目尚未完成的项目状态文件回读、检测、快照或实时回调不会写入新项目。
- 未打开本地项目时不会使用扩展进程目录生成伪项目名；先打开目标本地项目后才显示代码上传位置。
- 所有由 SimpleExperiment 发起的项目代码和 Agent runtime SFTP 上传都会先经过强制路径确认窗口。
- 确认记录保存在 `simple_cluster/ui/remote_path_confirmations.json`；取消窗口不会上传远端文件，也不会留下运行中状态。
- 操作确认前不会更新对应 SimpleSFTP 共享目标、修改 `.xsh` 或显示上传已开始。
- 运行确认窗口同样显示“核验代码指纹”，内部字段名保持兼容。
- 手动保存 Hub 或 Worker 后会显示最终代码与 runtime 位置；配置完整后可直接继续“准备 Agent 并启动”。
- 高级命令在命令面板默认隐藏，但面板内原按钮和直接命令 ID 不变。

---

## 运行进度（execution）与操作历史三角存储

### 1. collapsed 折叠状态迁移：tasks / operations 合并为 execution

面板折叠状态 `uiLayout.collapsed` 的 section key 已从旧的 `tasks` 与 `operations` 两个独立键合并为单一
`execution` 键。迁移点：

- 旧默认折叠：`tasks: false, operations: true`。
- 新默认折叠：保留 `tasks` / `operations` 仅用于兼容回读，真正生效的折叠键是 `execution`。
- 所有 section 路由、引用签名、资源树跳转都已做 `execution || tasks || operations` 别名兼容，旧配置读到的
  `tasks` / `operations` 会被归一化进 `execution`，不会丢失折叠偏好。

相关代码：`src/extension.ts:263`（默认 `collapsed` 定义，仍含 `tasks` / `operations` 兼容键）；
`src/ui/PanelHtml.ts:1340`（`<section data-section="execution">` 新分区）；
`src/ui/PanelHtml.ts:2648`、`2671-2673`、`2673`（`execution || tasks || operations` 别名兼容）。

### 2. 操作历史三角存储：localOperations / realtime.operations / events.jsonl

操作进度来源有三份，各自职责不同，不能互相替代：

- `localOperations`：本机 extension 进程内存 + 持久化的操作记录（含本机发起、手动控制、提交证据），是唯一
  权威的本机端操作视图，按 `operationId` 索引。
- `realtime.operations`：Worker / Hub Agent 经 SSE / WebSocket 实时推送上来的操作终态，落盘为
  `realtimeState.operations`；渲染时与本机 `localOperations`、快照、离线覆盖按优先级合并
  （`firstNonEmptyRecord(realtime.operations, snapshot.operations, offline.operations)`）。
- `events.jsonl`：Agent 在远端把每条操作 / 任务事件追加写入的本地 JSONL 日志（Hub 与 Worker 各一份），是远端
  不可变审计源，用于重放、调试包与兜底重建 `realtime.operations`。

三者关系：本机优先读 `localOperations`；实时终态来自 `realtime.operations`；远端真相来自 `events.jsonl`。
排查操作进度不一致时，先对 `localOperations` 与 `realtime.operations` 是否对齐，必要时回放
`events.jsonl` 确认 Agent 侧真实事件。

相关代码：`src/extension.ts:725`（localOperations 定义）、`:1822` 及 `:2909`（写入与压缩）；
`src/ui/WebviewRenderState.ts:45`（realtime.operations 合并优先级）；
`src/clusterAgentRuntime.ts:912`、`:1047`（events.jsonl 追加与回放）；
`src/clusterSchedulerRuntime.ts:1638`、`:1735`（Scheduler 侧 events.jsonl）。
