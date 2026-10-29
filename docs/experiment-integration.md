# 实验项目最小接入指南 · AI 执行契约

> **给 AI 的首要入口。** 先完整阅读本页，再读 [MultiModal 最佳实践](multimodal-integration-best-practice.md)。配置说明顶部和插件 **设置 → 最小实验接入指南 · 交给 AI** 均提供入口；点击 **复制接入任务给 AI**，可复制任务提示词、这两份完整指南的链接和验收要求，然后粘贴到目标项目的 AI 会话。

“最小”指尽量少改项目代码，不限制说明的详细程度。本指南面向不同语言、框架和任务类型；AI 必须核实实际接口，不能承诺所有未知项目原样套用后都能运行。没有证据的能力标记“未验证”，不能用模板语法通过代替真实训练、真实文件查询或科学结论核验。

阅读路线：第 0 节先确定职责和接入级别；第 1–9 节选择已有入口或轻量适配模板；第 10–18 节补齐进度、TensorBoard、结果语义、故障处理与验收。MultiModal 的源码出处和项目专用边界单列在最佳实践中，不能把它的分类指标、数据协议和服务器设置变成所有项目的要求。

## 0. AI 开工协议

### 0.1 先读取，不先生成脚手架

核对当前工作区规范根目录、Git 状态、AGENTS.md、README、依赖声明和项目约束。找到实际训练/评估/预处理入口及配置加载位置，读参数解析代码和结果写入代码。已有本机结果只能辅助理解格式，不修改它们，也不把历史成功当作当前命令已验证。

先向任务记录输出下面的映射；缺失项用“未知/待确认”，不要填猜测值：

| 要核对的内容 | AI 应记录的事实 |
| --- | --- |
| 执行入口 | 真实文件/模块/可执行程序、参数名、退出码传播方式 |
| 工作目录 | 哪个目录能正确导入模块、读取相对路径 |
| 配置 | 实际加载器、文件类型、CLI 覆盖优先级，生成配置是否真的被消费 |
| 随机性 | seed 参数如何进入框架/采样器；不支持 seed 时如何诚实记录 |
| 输入 | 各 Worker 上已有数据/权重位置；哪些属于同步范围 |
| 产物 | 每 job 的独立目录、checkpoint、日志、指标文件，是否存在共享追加写 |
| 指标 | 名称、单位、方向、split/endpoint、聚合单位、缺失值语义 |
| 运行界面 | 普通日志、tmux 进度、TensorBoard 是否已支持；哪些只是可选增强 |
| 依赖 | 用户选择的科研环境与项目依赖；不通过 Agent 是否能 import torch 判断科研环境 |
| 操作授权 | 本轮是否只改本机源码、是否允许同步/预演/调试/正式训练，是否涉及旧产物 |

### 0.2 选择接入级别

| 级别 | 必须实现 | 不要求 |
| --- | --- | --- |
| A：通用命令 | 非交互前台命令、真实退出码、独立声明产物、安全路径 | 模型、epoch、TensorBoard、科研指标 |
| B：结果汇总 | A + 每 job 的真实 CSV/受支持结果文件、身份及维度映射 | 项目采用 MultiModal 的文件全集或论文协议 |
| C：可观察训练 | B + 可识别进度、干净日志、按 job 隔离的曲线；按需选择增强 | 进度 100% 就被认定任务完成、强制使用 Rich 或 PyTorch |

先把 A 做通，再加 B/C。用户只要执行预处理命令时，不生成空的 metrics_case.csv，不安装训练框架，不虚构 epoch。项目已有正确输出时，只改 PLAN 或列映射，不额外包一层相同功能。

### 0.3 必须保留的边界

- 项目维护自己的模型、数据、训练和指标；插件维护连接、调度、任务身份、窗口、传输与最终产物核实。不要在项目里重写第二套 Scheduler/SFTP/UI。
- 所有正式实验运行与服务器文件操作走当前 SimpleExperiment / SimpleSFTP API。每次调用先读匹配工作区/实例的 discovery 与 capabilities/OpenAPI，使用实际工作流和参数；统一 CLI 是 `simpleex-mac`，不猜固定端口或旧方法名。
- 有 PLAN 和配置后先校验、预演，再按明确授权调试或运行。完整校验可能包含代码同步及目录准备，是有写入的流程；“只读接入审查”不能偷偷启动它。
- 真实训练、传输、覆盖及删除按当前授权执行。不能因本文给出模板就自动设置 confirm/pathConfirmed；危险操作保留精确目标与所需确认。
- 不修改正在运行任务的输出、原生 manifest、旧结果或身份；不因断线自动重跑。命令失败、部分结果和未验证状态必须如实交付。
- 接入验收检查接口正确性，不把“已完成”“CSV 存在”或曲线正常当作论文结论成立。项目特有科学检查由消费项目显式执行。

目标是让现有项目按真实命令运行，声明独立产物，并在需要时输出可读取的指标。插件不会自动理解所有项目的配置、数据语义和指标口径。先选择最小路径；没有指标的任务也能作为通用命令管理，不必为接入而重写训练框架。

服务器配置与操作流程见 [完整使用说明](simple-experiment-setup.md)，约束见 [项目契约](plugin-project-contract.md)。本页所有模块名、命令参数和路径都是模板，须替换成项目已有的真实入口；示例不构成实验结果证据。

## 1. 三种接法

| 项目现状 | 最小改动 | 结果 |
| --- | --- | --- |
| 已有可非交互执行的命令和输出文件 | 新建一个 PLAN，写真实命令、输入、独立输出 | 可排队、监控、停止和核实声明产物；不要求论文指标 |
| 已有 CSV/JSON 指标 | 在 PLAN 指定实际结果路径，必要时配置列映射 | 不必改模型；插件核实运行与结果文件后汇总 |
| 指标只在函数返回值、控制台或自定义文件中 | 加一个轻量入口/适配函数，把真实指标写为每 job 独立 CSV | 模型、损失、数据处理保持项目自己的实现 |

无论哪种，都需要：准确的执行环境、各 Worker 可访问的输入、非交互命令、独立输出路径、正确退出码。失败时不要吞异常后返回 0。

项目命令不限 Python。Rscript、Julia、编译后的 C/C++ 程序或其他非交互工具都可以替换进 runner 命令；插件运行辅助设施仍需要 Python。非 Python 项目同样先采用通用产物声明，需要表格时再把真实输出转换为可读取的 CSV/JSON，不要求重写原算法。

## 2. 最小目录

~~~text
my_project/
  configs/                      # 需要配置文件时使用
  models/                       # 已有模型代码，无需照搬此目录名
  trainers/                     # 已有训练/评估逻辑
  experiments/
    plans/
      smoke.yaml                # 必需的 PLAN
    simple_adapter/
      entry.py                  # 仅在原项目不能直接提供结果时添加
  tools/                        # 已有通用工具命令
  work_dirs/                    # 各 job 独立产物
  requirements.txt              # 或 environment.yml / pyproject.toml
~~~

已有项目保留自己的模块组织。不要把整套业务代码塞进顶层入口，不创建散落的临时训练脚本，也不要求新项目创建历史 `experiments/simple_project.yaml`。

## 3. 路径 A：仅用 PLAN 管理现成命令

假设项目已有 `tools/build_artifact.py --output <file>`，脚本会创建真实输出文件：

~~~yaml
# experiments/plans/build_artifact.yaml
suite: build_artifact
mode: train
seeds: [42]
naming:
  output_dir: "work_dirs/{suite}/{case}/seed_{seed}"
runner:
  working_directory: "."
  train_command: 'python tools/build_artifact.py --output "{output_dir}/model.bin"'
  inputs:
    - data/manifest.json
  outputs:
    - "{output_dir}/model.bin"
  collect_metrics: false
cases:
  - name: baseline
~~~

替换为实际命令；不使用 `data/manifest.json` 的项目应删掉该示例输入或改成真实输入。`train` 在这里表示一个执行阶段，不要求命令必须训练神经网络。输出尚未生成或路径不安全时不能当作成功。没有指标时，不会自动生成有意义的统计表。

## 4. 路径 B：现有程序已经输出指标 CSV

假设真实入口支持 config、seed、output-dir 与 result-csv，且会把指标写入指定文件：

~~~yaml
# experiments/plans/baseline.yaml
suite: baseline
mode: train_test
base_config: configs/baseline.yaml
seeds: [42, 43, 44]
naming:
  output_dir: "work_dirs/{suite}/{case}/seed_{seed}"
paper:
  result_csv: "{output_dir}/metrics.csv"
runner:
  train_command: 'python train.py --config "{config}" --seed {seed} --output-dir "{output_dir}"'
  test_command: 'python test.py --config "{config}" --seed {seed} --output-dir "{output_dir}" --result-csv "{result_csv}"'
  outputs:
    - "{output_dir}/metrics.csv"
cases:
  - name: baseline
expectedResults:
  - "{output_dir}/metrics.csv"
~~~

这些 CLI 参数不是插件强制参数。原项目用 `--cfg`、`--save-dir` 或 `--csv`，就在命令模板中对应替换；原程序不会因为 PLAN 写了某个参数就自动支持它。只评估已有权重可用 `mode: test` 和真实测试命令，只训练可用 `mode: train`。

最小指标表推荐长表形式：

~~~csv
case,seed,dataset,method,metric,value
~~~

数据行必须写本次实际计算值。不同 seed 与 case 的 CSV 互不共享，禁止所有任务并发追加同一个最终大表。数据集、方法等列按项目需要提供；字段名称不同可在“项目输出接入”中配置 CSV 列映射及指标别名。已有宽表（例如 accuracy、loss 列）也可走相应项目解析规则，不必为了插件改变科研指标定义。

## 5. 路径 C：添加一个轻量 Python 入口

原项目只需暴露一个可调用入口，或在这里调用现成 API。下面保存为 `experiments/simple_adapter/entry.py`；唯一需要按项目改写的业务部分标在注释中。不要在此复制模型训练实现。

~~~python
import argparse
import csv
import math
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--case", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--result-csv", required=True)
    args = parser.parse_args()
    output = Path(args.output_dir)
    result = Path(args.result_csv)
    output.mkdir(parents=True, exist_ok=True)

    # 按项目改写这两行；让真实入口接收 seed、配置和独立输出目录。
    from your_package.runner import run_experiment
    metrics = run_experiment(config=args.config, seed=args.seed, output_dir=output)

    if not isinstance(metrics, dict) or not metrics:
        raise ValueError("项目入口必须返回非空的真实指标字典")
    rows = []
    for name, value in metrics.items():
        number = float(value)
        if not math.isfinite(number):
            raise ValueError(f"指标不是有限数值: {name}")
        rows.append({"case": args.case, "seed": args.seed,
                     "metric": str(name), "value": number})
    result.parent.mkdir(parents=True, exist_ok=True)
    with result.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=["case", "seed", "metric", "value"])
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()
~~~

入口用模块方式启动，确保项目根目录可导入 `your_package`；这不是可原样运行的第三方包名，必须替换。随机性控制、checkpoint 选取和真正计算指标都由 `run_experiment` 或原项目完成，适配器不应填默认分数、捕获所有异常后宣称成功，也不能复用旧结果文件冒充本次输出。

对应的单阶段 PLAN：

~~~yaml
# experiments/plans/adapted.yaml
suite: adapted
mode: train
base_config: configs/baseline.yaml
seeds: [42, 43, 44]
naming:
  output_dir: "work_dirs/{suite}/{case}/seed_{seed}"
paper:
  result_csv: "{output_dir}/metrics.csv"
runner:
  train_command: 'python -m experiments.simple_adapter.entry --config "{config}" --seed {seed} --case "{case}" --output-dir "{output_dir}" --result-csv "{result_csv}"'
  outputs:
    - "{output_dir}/metrics.csv"
cases:
  - name: baseline
expectedResults:
  - "{output_dir}/metrics.csv"
~~~

如果原项目需要训练后再单独评估，拆成 train_command/test_command；如果只要保存预处理产物，用路径 A，不要硬塞空指标。指标文件在训练阶段生成也可按声明读取，不要求所有项目必须有单独 test.py。

## 6. case、seed 与配置差异

`cases` 和 `seeds` 展开为独立 job。基础配置由 `base_config` 指定，每个 case 可用 `config` 换文件，或使用支持的 `overrides` 点分键修改生成的配置快照。项目必须真正读取 `{config}`；若忽略它，PLAN 展开并不意味着参数已经应用。

~~~yaml
cases:
  - name: model_a
    overrides:
      model.name: model_a
  - name: model_b
    overrides:
      model.name: model_b
~~~

可以先单 case、单 seed、极少步数验证命令与输出，再扩大正式批次。不同服务器目录不同的输入，通过项目自己的配置映射处理，不靠插件猜数据集位置。

## 7. 模板变量、目录与 GPU

常用命令变量：`{config}` / `{config_path}`、`{suite}`、`{case}`、`{seed}`、`{index}`、`{output_dir}` / `{outputDir}`、`{result_csv}` / `{resultCsv}`、`{working_directory}` / `{workingDirectory}`、`{worker_id}`、`{gpu_ids}`、`{plan_file}`、`{job_name}`、`{experiment_name}`、`{python}`、`{checkpoint}`。具体来源与适用阶段以校验、预演为准；未列出的变量不能当成自动替换变量使用。

- 文件模板需要 shell 引号时加引号；不要把密码、token 和私钥内容嵌进命令。
- `runner.working_directory` 默认为项目根目录。新模板优先用 `.`，减少模块导入和相对路径歧义。
- `output_dir` 与 `result_csv` 是 PLAN 声明的项目内路径；新任务按声明执行，不默认改成 attempts 子目录。
- 不手工覆盖插件设置的 GPU 可见性，也不把另一张物理卡硬编码进项目。命令里的多 GPU 训练参数仍须与实际支持方式一致。
- 前台运行真实进程，不在结尾加 `&`、nohup 或 exec bash，不后台脱离 tmux。
- 由插件管理最终运行身份与 artifact manifest。项目可声明自己的附加产物，但不应伪造 commandId、退出码和完成事实。

## 8. 第一次实际接入的操作顺序

1. 本机识别项目，填写真实训练/评估命令和输出接入规则。
2. 配置并检查全部启用 Worker；由用户准备相应环境、数据与必要权重。
3. 将 PLAN、入口、配置与小输入纳入代码同步范围；检查大数据没有被误选。
4. 通过插件进行 PLAN 校验和预演，核对 job 数、展开参数、路径与服务器。
5. 先调试，再确认正式运行。正式实验使用 SimpleExperiment 工作流/API，不绕过插件直接启动脚本。
6. 查看实际窗口日志与退出码，主动查询产物；整批未结束时也可点击更新结果汇总。
7. 确认每个结果来自当前精确 job，检查是否有未知、冲突、失败或不完整项，再由科研项目做科学有效性判断。

## 9. 常见最小修改

| 原项目问题 | 最小处理 |
| --- | --- |
| 固定写 `results.csv` | 加结果路径参数，或把现有配置中的结果路径设为 `{result_csv}` |
| 所有 seed 写同一工作目录 | 接收独立 output-dir，PLAN 路径包含 suite/case/seed |
| 只打印指标 | 用现有日志解析规则；格式不稳定时在计算位置返回字典并用轻量入口写 CSV |
| argparse 参数名不同 | 只改 PLAN 命令中的参数名，不修改模型逻辑 |
| 输出 TensorBoard | 配置已有 scalar 接入规则；事件文件不等于所有科学指标都已正确解释 |
| 需要用户按键或输入密码 | 改为非交互命令；认证由系统密钥/ssh-agent或支持的插件流程处理 |
| 失败仍返回 0 | 保留异常或传播实际子进程退出码 |
| 想重跑覆盖旧文件 | 先走精确产物审核与两次确认，不在入口里自动删整个输出根目录 |

不存在能保证“任何项目零修改且自动理解所有指标”的模板。本页把改动限制在命令、配置和结果边界；项目特有数据协议、训练依赖、分布式策略和科学结论仍由项目负责。

## 10. 对插件友好的完整产物布局

这是推荐增强布局，按实际任务选择。除 PLAN 明确声明并确实需要的文件外，不要求所有任务凑齐下列文件。

~~~text
work_dirs/<suite>/<case>/seed_<seed>/
  config_snapshot.yaml          # 可选：本次真实生效配置，脱敏
  env_snapshot.json             # 可选：真实解释器/包版本；未检查的不填通过
  stdout.log                    # 可选：普通文本输出，保留真实异常
  stderr.log
  metrics_summary.csv           # 推荐：每 job、每指标一行
  metrics_case.csv              # 可选：逐样本预测，不混进主指标汇总
  training_curve.csv            # 可选：长期曲线的轻量导出
  prediction_index.csv          # 可选：大预测文件的索引
  tb_logs/
    events.out.tfevents.*       # 可选：该 job 独享的 TensorBoard events
  checkpoints/                 # 项目自己管理选择策略
  test_results/
    job_metrics.csv            # 项目已有正式结果可继续作为 paper.result_csv
    <endpoint>/predictions.csv
~~~

`paper.result_csv` 只指向本项目真正用于汇总的文件，不因为示例同时出现两个文件就各收一遍。`metrics_summary.csv` 和 `test_results/job_metrics.csv` 可以分别服务兼容工具与当前 PLAN；AI 应明确哪一个是本轮权威输入，核对两者语义一致并避免重复统计。

原生最终 `artifact_manifest.json` 及 commandId/runId 身份属于插件运行协议。新适配器不自行创建、覆盖或伪造它，也不新建 attempt/任务锁/退出码兜底文件。已有项目的历史标准 writer 可能也写同名文件，需按该项目与当前协议核实，不能直接照抄。项目的额外业务清单应使用自己的文件名并声明用途。

配置快照应是真正消费的配置，而非事后读取已改变的 base_config。环境快照是可选诊断，不自动全量导入依赖、扫描数据集或安装包。不得将 token、密码、私钥、患者标识或不应公开的数据写入快照/日志。

## 11. tmux 与普通文本进度契约

### 11.1 运行方式

实际命令以前台进程运行，插件负责 tmux 窗口、remain-on-exit、pane_dead 和真实退出码。项目不要创建第二层 tmux 会话，不追加 `&`、nohup、daemon 或命令结束后的 `exec bash`。子进程 wrapper 必须并行消费 stdout/stderr，等待真实子进程退出并传播非零状态；不能只读一个管道而让另一个塞满。

优先让 Python 入口使用 `python -u` 或项目级 `PYTHONUNBUFFERED=1`，普通文本输出使用 UTF-8 和及时 flush。不要修改用户全局 shell 或 CUDA 配置。进程长时间预处理时可以输出真实阶段信息；没有新进度时不要打印假心跳冒充训练正在推进。

### 11.2 当前 CLI 可识别的推荐文本

下面是**格式示例，不是实验结果**。它对应当前插件 `src/cli/runtime.ts#parseTrainingProgress` 的已支持形态：

~~~text
Epoch 3/100 [Train] 40% 4/10
  当前 loss 0.1250
  lr 1.00e-03   显存 2.0 GiB
~~~

- `3/100` 是当前训练循环的 epoch/总 epoch；`4/10` 是本 epoch 完成 batch/总 batch。
- `40%` 是本 epoch 内的 batch 百分比，不能写成整个训练流程百分比。
- 上述示例的当前训练循环进度约为 `(3 - 1 + 4/10) / 100 = 2.4%`；不包含预处理、之后的验证/测试、同步和产物核实。
- loss、lr、显存来自真实运行值；未知时可省略或写 `--`，不能为填满界面而填 0。lr 用科学计数法可匹配当前解析；进程显存文本仅用于展示，不代替插件独立 GPU 预算。
- 多阶段循环应标明阶段，不把另一个阶段的旧 epoch 混进当前 batch。`Test ...` 等测试进度不应被解释成训练总体进度。

最简可移植进度函数如下，可放进已有 `utils/` 模块，在现有训练循环中按需调用。调用频率由项目选择，避免把每 batch 的大对象/预测内容刷入日志。

~~~python
def report_progress(epoch, max_epoch, completed, total, *, loss=None):
    if max_epoch <= 0 or total <= 0:
        print(f"[Train] epoch={epoch} completed_batches={completed}", flush=True)
        return
    percent = 100.0 * min(max(completed, 0), total) / total
    print(f"Epoch {epoch}/{max_epoch} [Train] {percent:.1f}% {completed}/{total}",
          flush=True)
    if loss is not None:
        print(f"  当前 loss {float(loss):.6f}", flush=True)
~~~

不要为了符合例子重写模型循环；在已有进度输出中补上稳定的 epoch/总数和 batch/总数即可。未知总 batch 的流式任务不能假设长度，保留真实计数并允许 percent 未知。

### 11.3 epoch 完成日志

MultiModal 还保留普通完成行，例如格式 `Epoch N: Val Loss = <真实数值>, ...`。当前 CLI 可在读取实际 job_config 的总 epoch 后计算已完成循环比例；没有可信总数时保留 epoch/loss，percent 为 null。它是可选增强，不应要求非训练任务打印 epoch。

Rich/tqdm 的任意自定义布局并不保证都能解析。当前只支持已知宽/窄布局及上述文本；窄屏若只剩 Train + batch 而没有 epoch，缺失 epoch 就应保持未知。建议关键阶段保留普通完成行，避免终端重绘、窗口宽度变化后丢失全部可读线索。

进度条 100%、最后一行出现 done、控制台打印 success，都不是原生任务完成授权。项目不能伪造插件保留的 runtime 完成标记；完成仍由实际退出、声明产物及最终协议核实决定。

## 12. Rich 界面与干净日志的分工

推荐“终端可视化 + 普通文本事件 + 结构化指标”三条职责分开：

| 通道 | 内容 | 避免 |
| --- | --- | --- |
| tmux 终端 | 当前阶段、epoch/batch、loss、速度、可选显存 | 无限增长的重绘帧写入永久日志 |
| stdout/stderr / train.log | 启动参数、阶段变化、epoch 完成、异常堆栈、真实退出线索 | 过滤掉错误、缓冲到训练结束才可见 |
| CSV / TensorBoard | 真实数值、明确维度、可复核 step | 从彩色终端截图反推正式指标 |

MultiModal 的私有 Rich 帧由 `utils/terminal_progress.py` 与 `run_wrapper.py` **成对**编码/解码，控制帧只进入终端，不进入普通日志。其 `MULTIMODAL_*` 变量、字节帧标记、Torch 依赖和 CPU/CUDA 启动逻辑不是插件公开协议。新项目不要只复制其中一个类，也不要向 stdout 随便写私有控制帧。

已有 Rich 项目可沿用原框架的 TTY/非 TTY 设置；普通项目优先使用第 11 节文本即可。只有用户需要同等终端体验时才移植完整的进度与流处理边界，且保留原来所有异常输出。日志分流和限量输出不能缩减实际执行检查。

## 13. TensorBoard 标量契约

### 13.1 目录与 tag

每 job 使用自己的 `<output_dir>/tb_logs`，不要所有 seed 共用一个 event 目录。沿用项目已有 events 目录也可以，但须落在正确 job 作用域并让当前插件能够定位。浏览传统 TensorBoard 与插件读取 scalar 曲线是不同入口，启动网页服务不是写出 events 的前提。

MultiModal 当前使用的 tag 约定：

| tag | step | 语义 |
| --- | --- | --- |
| `Loss/train` | epoch | 本 epoch 按项目定义聚合后的训练 loss |
| `Loss/val` | epoch | 单端点项目的验证 loss |
| `Metric/<metric>` | epoch | 单端点项目的验证指标 |
| `Loss/val/<endpoint>` | epoch | 多端点验证 loss |
| `Metric/<endpoint>/<metric>` | epoch | 多端点验证指标，端点不混合 |

这些名称是友好建议，非强制解析所有项目的唯一格式。保持大小写、层级与指标含义稳定；不要把同名 AUROC 和 average precision 混为一个 tag。验证数据与最终测试数据不能只靠相同 tag 互相覆盖。

同一 tag 的 step 应有一致语义和单调性：用 epoch 就始终用 epoch，用 optimizer step 就明确区分。恢复训练沿用真实 step；若重新开始一次正式运行，应使用经插件审核的当前 job 输出边界，不把旧 event 文件当成本次产生。不要手工改旧 events 或合并不同 seed 的写入流。

### 13.2 PyTorch 项目的小改动示例

仅对本来使用 PyTorch、且用户环境已具备 TensorBoard 的项目采用；其他语言沿用自己的 event writer，不为了显示曲线引入 Torch。

~~~python
import math
from pathlib import Path


def log_epoch(writer, epoch, train_loss, validation):
    # validation: {endpoint: {metric_name: real_numeric_value}}
    if train_loss is not None and math.isfinite(float(train_loss)):
        writer.add_scalar("Loss/train", float(train_loss), epoch)
    for endpoint, metrics in validation.items():
        for metric, value in metrics.items():
            if value is None:
                continue
            number = float(value)
            if not math.isfinite(number):
                continue
            tag = (f"Loss/val/{endpoint}" if metric == "loss"
                   else f"Metric/{endpoint}/{metric}")
            writer.add_scalar(tag, number, epoch)
    writer.flush()


def open_tensorboard_writer(output_dir):
    from torch.utils.tensorboard import SummaryWriter
    return SummaryWriter(str(Path(output_dir) / "tb_logs"))
~~~

在现有训练入口创建 writer，调用 `log_epoch`，在 `finally` 中 `writer.close()`；上述函数不启动训练、不构造虚假指标。每轮验证后 flush，便于中途读取；不要求逐 batch flush。rank 0/主进程负责写同一曲线，避免 DDP 多进程重复写。

### 13.3 曲线与最终结果不要互相替代

原始 scalar 的最后一点、最大值、最小值、best checkpoint 对应值可能完全不同。最终结果表应来自项目显式选定 checkpoint 的真实评估输出；不要默认把 TensorBoard 最后一个 scalar 变为最终测试结果。

若选择当前版本支持的 TensorBoard 结果捕获通道，需另外核对 tag 到指标的映射、目录作用域、step 选择与依赖。捕获/预览规则能解析，不等于本轮主动汇总已读取该值。用户科研环境缺少 tensorboard 时由用户管理依赖，插件不自动安装，也不把曲线功能缺失当成 Agent 进程归属不可信。

## 14. 推荐主指标长表与语义

### 14.1 文件和最小字段

优先每 job 一份长表，每行一个指标。当前主动 CSV 汇总路径直接识别 case、seed、method、dataset、split、eval_protocol、train_rate/rate_percent、metric、value 等字段或其明确列映射；job 的 case/seed 还可来自已核实声明。推荐在文件中明确写出，方便项目自身审计。

~~~csv
case,seed,method,dataset,split,eval_protocol,metric,value,unit,higher_is_better,undefined_reason
~~~

空表头示例不能作为有效指标文件。数据行填写真实计算值；不要把下面的格式说明理解为任何项目必须输出分类指标。

| 字段 | 要求 |
| --- | --- |
| `case` / `seed` | 与本次 PLAN 展开后的任务一致；不同 seed 不混入同一 job 文件 |
| `method` / `dataset` | 项目真实、稳定的名称；不要从某个文件夹名盲猜 |
| `split` | 真实 train/val/test 等划分；不能把 validation 改名 test 来套表格 |
| `eval_protocol` | 明确的端点/评估协议；同一 case 的不同端点必须可区分 |
| `metric` | 稳定语义的指标键，建议直接写最终规范名称 |
| `value` | 有限数值，无 `%`、`±`、括号注释、单位后缀或格式化千分位 |
| `unit` | 显式单位；比例 0–1 与百分数 0–100 不能混用 |
| `higher_is_better` | 项目明确给出方向；未知指标不盲目默认为越大越好 |
| `undefined_reason` | 无法定义指标时给真实原因，value 留空，不把缺失改成 0 |

`unit`、方向、fold、样本量、checkpoint、encoder、run_key 等可作为附加审计信息，但**不是每个插件汇总入口都自动按所有附加列分组**。特别是 fold、多个测试集、多个 checkpoint 或自定义条件，必须通过真实预览核对是否被保留；必要时拆成明确 case/PLAN/端点。不能写一个额外列就假定插件一定建立新维度。

长表的额外数值元数据不会被当作同一行的其他 metric；宽表则可能把非保留数值列当指标。包含 epoch、样本量、运行时长等元数据的项目优先转换成长表，避免它们意外出现在排行榜。

### 14.2 推荐的轻量写入器

下面可放入 `experiments/simple_adapter/metrics.py` 或已有结果模块。它只写本 job 的新结果，不做模型计算、不伪造插件身份，不覆盖旧文件。调用方传入真实行；再次运行遇到已有文件时停止，按插件旧产物审核流程处理，不在 writer 中自动删目录。

~~~python
import csv
import math
from pathlib import Path


COLUMNS = ["case", "seed", "method", "dataset", "split", "eval_protocol",
           "metric", "value", "unit", "higher_is_better", "undefined_reason"]


def write_metrics(path, rows):
    normalized = []
    for source in rows:
        row = {key: source.get(key, "") for key in COLUMNS}
        if not str(row["metric"]).strip():
            raise ValueError("metric 必须明确")
        value = source.get("value")
        if value is None or value == "":
            if not str(row["undefined_reason"]).strip():
                raise ValueError("缺失指标必须说明 undefined_reason")
            row["value"] = ""
        else:
            if isinstance(value, bool):
                raise ValueError("布尔值不能冒充指标")
            number = float(value)
            if not math.isfinite(number):
                raise ValueError("非有限值应留空并提供原因")
            row["value"] = number
        normalized.append(row)
    if not normalized:
        raise ValueError("没有本次真实指标行")
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(normalized)
~~~

当前主动解析会跳过空白/非有限的 value，保持该项缺指标；不会自动把 undefined_reason 变成一个有分数的结果。项目需要保留未定义说明时同时输出自己的审计文件，不能宣称缺失指标已收录。

### 14.3 列映射、别名和重复值

已有字段例如 `score_name` / `score_value`，可在当前项目输出接入中明确配置：

~~~json
{
  "simpleExperimentMac.projectAdapterRules": {
    "csvColumnMapping": {
      "case": "case_name",
      "seed": "random_seed",
      "method": "model_name",
      "dataset": "dataset_name",
      "split": "split",
      "eval_protocol": "evaluation_endpoint",
      "metric": "score_name",
      "value": "score_value"
    }
  }
}
~~~

这是一段工作区设置示例，合并到已有对象，不覆盖服务器配置或其他规则。映射方向是“插件规范字段 → 原 CSV 列名”。缺失列应补充真实输出或去掉不适用映射，不造空字符串来假装维度齐全。

`metricAliases` 用于支持该规则的捕获/预览通道；不要假设所有主动汇总路径都会自动应用全部别名。最稳妥的是结果 CSV 直接输出规范指标名，并用本轮实际汇总核对。AUC/AUROC 可在项目确认同义后统一；AUPRC/AP、macro/micro F1、不同阈值 accuracy 不应未经确认合并。

同一个 case、seed、method、dataset、split、eval_protocol、metric 应有明确唯一的最终结果。多 checkpoint 或多个聚合口径不要靠重复行的先后顺序“最后一个覆盖”。每个 seed 输出单次值；重复实验的均值/标准差由正确分组的汇总产生，不让某行混填 `mean ± std` 字符串或跨端点平均。

## 15. 样本结果、曲线和大文件

- **metrics_case.csv**：逐样本/病例预测明细，使用稳定 sample_id/case_id，需要时区分 patient_id；多分类概率/logits 可存明确 JSON 数组。不是把一个样本的预测概率称为该样本 AUROC，也不把它混进主指标汇总。
- **training_curve.csv**：建议包含 case/seed、split/endpoint、epoch/step、metric/value。每条曲线明确 step 语义；记录真实值，不根据最终指标伪造历史曲线。
- **prediction_index.csv**：样本 ID、预测文件/行号及必要维度，帮助定位较大预测产物；路径不得借此越过项目边界或泄漏不应公开的原始数据。
- **checkpoint**：由项目现有策略保存和选择；日志/结果中记录实际用于评估的 checkpoint 依据。不要为了接入插件改变模型选择指标或验证协议。
- **大权重、图像、特征、数据集**：保留在用户明确配置的位置。轻量结果汇总不应隐式下载整个训练目录；原始指标也不应为了插件再同步成一套本机缓存。

这些文件是可选能力。接入分类、分割、回归、生成或无监督项目时，采样单位、指标、分组与数据隐私各自不同，AI 不复制 MultiModal 的患者/质量退化字段作为所有项目必需项。

## 16. 其他框架、GPU 与恢复

| 场景 | 接入时的具体处理 |
| --- | --- |
| Lightning/Hydra 等配置框架 | 核实真实命令、配置覆盖与 cwd；明确日志/输出根，不让框架自动改到另一个未声明目录 |
| R/Julia/C++/命令行工具 | 使用真实非交互 runner，传播退出码；通过文件边界输出 CSV/JSON，无需 Python 模型 adapter |
| CPU/无 epoch 任务 | 通用产物声明和真实阶段日志即可；是否使用 GPU 调度按实际入口支持，不能假装检测到 epoch |
| 单 job 多 GPU / DDP | 项目显式支持自己的分布式启动；先核对当前插件可表达的分配方式，不把多个 Worker 当成自动跨机 DDP |
| CUDA 可见设备 | 继承插件传入的可见性，不把物理 GPU 编号硬编码进配置；项目进程内逻辑编号与物理编号不同 |
| 多进程日志/写入 | 主进程写同一 job 的主 CSV/events；其他进程避免并发覆盖同一文件 |
| checkpoint 恢复 | 明确用户要求的真实 checkpoint、步数和输出边界，保留身份核实；未知状态不自动 resume/retry |
| 无法解释结果 | 保留原真实输出和未知原因，要求明确解析规则，不根据控制台关键词填假结果 |

## 17. AI 的验证与交付清单

### 17.1 本机可做的静态检查

在不启动科研实验、不连接服务器写入的前提下，完成：

1. PLAN/YAML/JSON/Python 等格式语法与项目既有静态检查；不为查参数而 import 会自动训练的模块。
2. 读实际 argparse/配置加载代码，逐一核对模板参数、工作目录、模块可导入性、seed/config/output/result 路径的传递。
3. 展开一个 case + 一个 seed 的预期路径，确认其他 case/seed 不会碰撞；所有 `expectedResults` 都有真实生产者。
4. 对已有格式或最小合成夹具做解析检查，明确夹具不是实验结果。检查 UTF-8、逗号/引号、0 与缺失值、多个端点和错误退出。
5. 记录已有结果、正在运行任务及用户修改保持不变。缺环境、缺数据、缺服务器能力标为未验证，不假装静态检查覆盖它们。

性能/压力测试不是最小接入的默认步骤。需要新增时先确认人数、任务规模和可接受等待，不默认追加压力训练或大规模基准。

### 17.2 获准后通过插件验证

读取当前实例与能力；按实际工作流执行校验和预演，检查全部启用 Worker、同步范围、真实环境、静态入口探针和正式目录。用户授权后再进行单 case/seed 的小规模调试，核对终端输出、真实退出码、产物和结果。没有当前授权时交付可审核源码与 PLAN，列出这一阶段尚未执行。

低流量模式下按需主动刷新。测试文件/曲线刚写出不代表最终结果已经完成；整批中途可读取已经被协议核实的 job。断线时保持未知和历史完成事实，不能通过反复清历史、重新派发或写假 manifest 消除告警。

### 17.3 交付给用户/下一位 AI 的固定摘要

~~~text
项目根目录和已读约束：
接入级别 A/B/C：
真实入口与参数映射：
修改文件及原因：
PLAN 路径、case/seed 数量、独立输出树：
正式指标文件、列映射、单位/方向、端点语义：
进度/日志/TensorBoard 的实现与可选依赖：
本机已执行检查及真实结果：
未执行的服务器校验/同步/调试/正式训练：
旧任务和产物保护结果：
用户首次运行的明确步骤及仍需授权的操作：
~~~

验收不能只写“已接入”。至少区分：命令可构造、入口已核对、语法检查通过、插件预演通过、实际任务成功、指标已核实、科研有效性已审核。未达到的阶段不得跳级标绿。

## 18. 快速排错矩阵

| 现象 | 常见事实与最小修复 |
| --- | --- |
| PLAN 参数报 unrecognized arguments | 读真实 CLI，修改命令模板，不强改模型支持猜测参数 |
| 改了 case.overrides 结果却不变 | 项目没有实际读 `{config}`，或之后被另一个配置覆盖；核对最终配置快照 |
| 单 job 的不同端点被平均了 | 检查 eval_protocol/split 及实际分组，必要时拆 case；不要仅增加一个无人消费的列 |
| 数据行存在但缺指标 | value 是否为空/非有限/百分数字符串、metric/value 映射是否正确、是否拿了错误结果路径 |
| epoch 有值但 percent 未知 | 总 epoch 或最新窄屏行不完整；提供真实完整行，不能拿旧 epoch 拼新 batch |
| 终端漂亮但日志巨大/乱码 | 控制帧未分流、TTY 判断或 UTF-8 错误；优先保留普通文本和真实异常 |
| TensorBoard 没有新曲线 | 是否写入正确 job 目录、writer 是否 flush/close、step/tag 是否一致、是否选择了正确 Worker |
| 训练成功却没有测试表 | train_test 是否真的执行评估，paper.result_csv 是否由该阶段生成，真实退出码是否被吞掉 |
| 一直等待显存估计 | 确认插件预算、采样和 PLAN 估计状态；项目打印 epoch 不会绕过独立显存观察 |
| 刷新失败就又启动一轮 | 这是错误恢复策略；保留原 commandId/完成事实并主动重查，不自动重跑 |

后续插件版本的能力表和消费项目的当前约束优先。发现本文与当前实际 API/代码冲突时，报告具体差异并停止依赖该假设的操作，不静默退回旧 Hub、固定端口或绕过插件的远程命令。
