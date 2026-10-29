# MultiModal 插件友好接入最佳实践

本页供 AI 提取可复用接口设计，与 [AI 最小接入指南](experiment-integration.md) 配合使用。它是**按当前源码核实的实践说明**，不是整套 MultiModal 的通用化复制包，也不是重新运行实验后的科学有效性证明。

核对日期：2026-10-29。来源是当前使用的 `MultiModal` 项目，源码提交 [`b80e455cfec266ae4c17fc55ce8794b9b3fe8551`](https://github.com/zlinkw/MultiModal/tree/b80e455cfec266ae4c17fc55ce8794b9b3fe8551)。核对时本地 HEAD 与 origin/master 一致；本轮只读训练、适配器和 PLAN 源码，没有修改该项目、结果表或进行远端运行。用户正在产生的结果文件不作为本页的示例数值。

## 1. 最值得迁移的设计

| MultiModal 的做法 | 对插件的帮助 | 迁移到其他项目时怎么做 |
| --- | --- | --- |
| PLAN 明确传 config/output-dir/case/seed/result-csv | 展开命令与真实执行输入一致，可按 job 追踪 | 对应自己的真实参数名，不强制重命名现有 CLI |
| wrapper 运行实际前台子进程并传播退出码 | 异常不被一层 shell 的成功掩盖 | 需要捕获才加 wrapper，原入口已满足时不重复包装 |
| 同时消费 stdout/stderr，UTF-8、非缓冲 | 避免管道互锁，异常可及时查看 | 保留真实错误和阶段输出，不用“异常时 return 0”兜底 |
| Rich 进度与普通文件日志分离 | tmux 可读，日志没有大量控制帧 | 优先保留普通文本；完整 Rich 分流是可选增强 |
| 每 job 独立工作目录、CSV、tb_logs | 不同 seed/case 不争写，跨服务器容易核对 | 独立目录是边界，不要求相同目录名和分类协议 |
| 多评估端点有 eval_protocol，run_key 也区分协议 | 不把不同测试条件当作同一个分数 | 保留本项目真实维度，并核对当前汇总入口实际分组 |
| 每轮验证后 flush，入口 finally close writer | 中途刷新能看到已落盘曲线 | 用项目已有 writer；不为非 PyTorch 项目引入 Torch |
| 标准长表与逐样本明细分开 | 最终指标、病例预测和曲线各自有语义 | 不强制没有逐样本预测的任务生成空明细 |
| 配置/环境快照和 checkpoint 线索 | 便于解释实际执行条件 | 脱敏、真实、按需；不把辅助快照当成运行授权 |

## 2. 已核实的源码入口

所有链接固定到上述提交，避免项目后续改动后误称仍逐字一致。历史说明文件的措辞可能落后于插件；优先读实际生产者及当前插件契约。

| 源码 | 核对内容 |
| --- | --- |
| [AGENTS.md](https://github.com/zlinkw/MultiModal/blob/b80e455cfec266ae4c17fc55ce8794b9b3fe8551/AGENTS.md) | 该项目强制使用 wrapper 的本地规则；它不是所有项目的全局要求 |
| [image_only PLAN](https://github.com/zlinkw/MultiModal/blob/b80e455cfec266ae4c17fc55ce8794b9b3fe8551/experiments/plans/comparison/image_only.yaml) | case/seed 展开、train_test、独立声明路径与结果清单 |
| [aoept PLAN](https://github.com/zlinkw/MultiModal/blob/b80e455cfec266ae4c17fc55ce8794b9b3fe8551/experiments/plans/comparison/aoept.yaml) | 另一方法沿用同一接入边界，而非复制调度逻辑 |
| [run_wrapper.py](https://github.com/zlinkw/MultiModal/blob/b80e455cfec266ae4c17fc55ce8794b9b3fe8551/experiments/simple_adapter/run_wrapper.py) | 前台子进程、双管道、UTF-8、进度帧剥离、退出码与现有结果保留 |
| [terminal_progress.py](https://github.com/zlinkw/MultiModal/blob/b80e455cfec266ae4c17fc55ce8794b9b3fe8551/utils/terminal_progress.py) | TrainingDashboard、TerminalProgress、窄屏布局与私有 Rich 帧 |
| [logger.py](https://github.com/zlinkw/MultiModal/blob/b80e455cfec266ae4c17fc55ce8794b9b3fe8551/utils/logger.py) | 终端/文件过滤分流、SummaryWriter、flush/close |
| [multimodal_trainer.py](https://github.com/zlinkw/MultiModal/blob/b80e455cfec266ae4c17fc55ce8794b9b3fe8551/trainers/multimodal_trainer.py) | 双进度面板、实际 epoch 完成日志、多端点标量 |
| [base_trainer.py](https://github.com/zlinkw/MultiModal/blob/b80e455cfec266ae4c17fc55ce8794b9b3fe8551/trainers/base_trainer.py) | 单端点 Loss/train、Loss/val、Metric/<name> 与验证后 flush |
| [train.py](https://github.com/zlinkw/MultiModal/blob/b80e455cfec266ae4c17fc55ce8794b9b3fe8551/train.py) | `<save_dir>/tb_logs`、真实训练入口与 finally close |
| [test.py](https://github.com/zlinkw/MultiModal/blob/b80e455cfec266ae4c17fc55ce8794b9b3fe8551/test.py) | --result-csv、真实评估结果、标准输出 writer、多端点分离 |
| [result_writer.py](https://github.com/zlinkw/MultiModal/blob/b80e455cfec266ae4c17fc55ce8794b9b3fe8551/experiments/simple_adapter/result_writer.py) | 指标长表、样本明细、可选曲线/预测索引、快照 |
| [common.py](https://github.com/zlinkw/MultiModal/blob/b80e455cfec266ae4c17fc55ce8794b9b3fe8551/experiments/common.py) | 项目结果字段、真实维度及写入工具 |

## 3. PLAN：保持薄，把所有可变参数交给真实入口

当前 image_only PLAN 的两个阶段调用相同 wrapper：

~~~text
python -m experiments.simple_adapter.run_wrapper --force-progress --output-dir {output_dir} --config {config} -- python train.py --config {config} --output-dir {output_dir} --case {case} --seed {seed}
python -m experiments.simple_adapter.run_wrapper --force-progress --output-dir {output_dir} --config {config} -- python test.py --config {config} --output-dir {output_dir} --case {case} --seed {seed} --result-csv {result_csv}
~~~

这些是该提交的源码形式，**不是其他项目可直接执行的通用命令**。跨项目使用时改成原项目真实参数，并给可能含空格的变量加 shell 引号；如果没有 wrapper、训练脚本或这些参数，就不能原样复制。

可迁移的结构：

- `mode: train_test` 明确两个阶段；case 与 seeds `[42, 43, 44]` 展开为独立 job。
- `naming.sweep_dir` 与 `job_name: '{index}_{case}_seed{seed}'` 共同给出独立输出。
- `paper.result_csv: '{output_dir}/test_results/job_metrics.csv'` 明确最终读取的逐 job 文件。
- `runner.result_path_policy: declared` 保持声明路径，不另套 attempt 目录。
- `expectedResults` 对应确实由这个项目生成的文件，不用一个空占位文件骗过完整性判断。
- 数据集选择、协议和方法差异写在配置/overrides，PLAN 不实现训练算法或服务器调度。

该项目声明了 main_all_low_quality、supplemental_clean 等质量评估产物和清单。其他项目不能照抄它的 expectedResults、数据路径或 `protocol_readiness` 后假定已经支持；没有生产者的声明只会制造缺产物。

## 4. tmux：训练与验证面板、普通日志各司其职

`TrainingDashboard` 为训练和验证分别保留一条进度条，详情显示 loss/lr、best epoch 等；会按终端宽度收缩。`TerminalProgress` 可显示 batch 数、百分比、ETA、速度及可用时的显存。模型仍通过原 trainer 训练，显示层不实现另一套调度。

trainer 在验证完成后还输出普通行：`Epoch N: Val Loss = ...`。logger 可将“已经在 Rich 中显示”的内容从重复终端输出中排除，同时将验证完成记录写入文件；异常仍应保留自己的真实输出通道。

这套显示有两点特别适合借鉴：

1. 训练/验证阶段各自清楚，不把验证阶段的 batch 当成训练阶段的 batch。
2. 即使终端窗口窄、Rich 重绘被捕获，仍保留普通 epoch 完成线索用于历史诊断。

但当前插件的 CLI 只识别已知布局。MultiModal 的某些窄屏/dashboard 行可能只显示 Train/Val 和 batch，没有可解析 epoch；此时插件应保留未知，而不是拼接旧 epoch。新项目若希望解析更稳，使用 [推荐完整文本格式](experiment-integration.md#112-当前-cli-可识别的推荐文本)，不能宣称所有 Rich 布局都会自动支持。

## 5. wrapper：为什么进度不会污染日志

MultiModal 的 `run_wrapped_command` 设置本次子进程的 UTF-8、非缓冲与进度开关；同时读取两个管道，普通行同步写终端和普通日志。`_ProgressOutput` 给 Rich 控制输出加私有帧边界，wrapper 剥离边界后只把对应控制内容转给终端，避免它们写进 stdout.log/stderr.log。

这不是插件要求所有项目采用的帧协议。`MULTIMODAL_PROGRESS_FRAMED`、`MULTIMODAL_PROGRESS_BAR`、`MULTIMODAL_PROGRESS_WIDTH` 及私有 marker 必须与该项目整套流处理配对。单独复制 Rich 输出类会把控制帧写进日志；单独复制 wrapper 又可能没有对应生产者。

wrapper 还涉及项目自己的线程配置、启动引导、nvJitLink 环境处理和质量输出检查。它们的存在不代表插件应该管理所有科研依赖。其他项目不应为最小接入复制这些规则；优先保留自己的环境和命令边界。

wrapper 的返回码来自真实子进程；不能因为后来写了 CSV 或 report 就把失败改成成功。当前实现会优先保留已存在的结构化结果，避免从日志重新解析覆盖正确数据。新项目应先使用真实结果生产者，只在缺失结构化接口时增加适配。

## 6. TensorBoard：逐 job 路径、稳定 tags、验证后 flush

`train.py` 为本次 save_dir 创建 `tb_logs`，通过 `TensorboardLogger` 封装 SummaryWriter。基础 trainer 使用 `Loss/train`、`Loss/val`、`Metric/<metric>`；多模态 trainer 使用 `Loss/val/<endpoint>` 与 `Metric/<endpoint>/<metric>` 区分验证端点。step 使用真实 epoch。

验证阶段完成后调用 flush，训练入口在 finally 中 close。可复用的不是文件名本身，而是：

- 一个 job/seed 独享 event 目录。
- tag 语义和大小写稳定，端点不混写。
- step 在同一条曲线中保持同一含义。
- 中途需要读取时，生产者已主动 flush；结束/异常时有 close。
- 曲线服务于运行可观察性，最终表格仍使用真实选定 checkpoint 的评估输出。

其他框架无需迁移为 PyTorch。写已有兼容 event 文件即可；配置插件实际能够发现的日志目录，不要求运行一个常驻 TensorBoard 网页服务才能完成任务。插件读取多 seed 曲线时，每个 step 的有效 seed 数可能不同，不应补 0 伪造齐全曲线。

## 7. 结果长表：身份、端点和指标分开

`result_writer.py` 的 summary 核心字段包括 experiment_id、suite、method、dataset、split、eval_protocol、seed、metric、value、unit、higher_is_better、epoch/step、case、run_id/run_key 等；还保留 encoder 和项目协议元数据。`attempt_id` 仅为历史行保留，不能据此给新任务创建 attempt。

`default_run_key` 会在缺少显式 run_key 时将 eval_protocol 纳入项目逻辑键，帮助同一实验的多个评估协议分开。这是项目解析辅助，不是伪造插件 commandId/runId 的许可；不同插件读取入口的归并维度仍须实际核对。

`test.py` 生成逐 job 的正式结果并调用标准 writer；`metrics_case.csv` 存样本预测，`metrics_summary.csv` 存汇总指标，两者不互相替代。可选 training_curve、prediction_index 和 checkpoint/配置线索按项目需要生成。

特别注意缺失值：当前 writer 只把有限数值写入标准 summary；无法定义的原始指标另有 undefined_metrics 记录，不会自动填 0。其他项目应保留缺失原因并让表格明确缺指标，不能因为字段齐全就把无法定义的 AUC、损失或生成质量分数当成零分。

分类指标、质量评估端点、patient_id、encoder 元数据及论文表格名称都是 MultiModal 的业务语义。分割项目不需要复制 AUC，非医疗项目不需要编造 patient_id。当前插件部分路径只消费特定维度；附加列存在不证明排行榜会自动按它分组。

## 8. 目录和身份的可迁移边界

MultiModal 自己的 result_writer 会生成项目标准 artifact_manifest、env/config snapshot 等历史契约文件。新项目**不应无条件复制这套 writer**：当前原生运行协议的最终 manifest、commandId/runId、完成事实由插件负责。要采用已有 writer 时先核对与当前协议的整合方式，避免同名文件互相覆盖。

独立 `paper.result_csv` + 真实轻量 CSV 足以作为新项目结果边界的起点。项目额外快照清单可以采用自有名称。不要建立新的完成状态文件、运行锁、PID 兜底或 attempts 目录，也不从一个报告文件推断任务真的退出。

本机代码范围、Worker 间产物范围与本地最终汇总范围是三个概念。迁移时不要把 MultiModal 的大数据位置、权重位置、远端父目录或服务器 ID 写入新项目；同步与路径应来自用户当前项目配置。

## 9. 给 AI 的迁移次序

1. 读目标项目实际入口与约束，建立参数/配置/输出/指标映射；不先复制 MultiModal 目录。
2. 创建一个 case、一个 seed 的可审核 PLAN，尽量直接复用真实命令。
3. 项目能输出 CSV 时只绑定路径和列；不能时加轻量结果边界，不重写算法。
4. 增加普通文本阶段/epoch 信息；有需求再迁移 Rich 双面板与完整分流。
5. 已有 event writer 就采用逐 job 目录和明确 tags；没有则将 TensorBoard 列为可选增强。
6. 给每个 expectedResults 找到真实生产者；核对多端点、缺失值和分组不会合并错。
7. 先静态检查，获准后通过实时插件工作流校验/预演，再进行小规模调试和真实结果核实。
8. 交付已验证阶段、未验证项及用户下一步，不把本页“最佳实践”标签当作无需验证的保证。

## 10. 本页不作为通用要求的内容

`experiments/simple_project.yaml`、强制 `--force-progress`、完整 wrapper、特定双 CSV、MultiModal 的分类/质量规则、resultPathValidator、论文归档审核、CPU/CUDA 引导和模型工厂钩子，都只按该项目实际需要保留。插件不应为所有消费项目自动执行这些科研检查，也不因没有它们而否定一个合法通用命令。

有用的共同边界是：真实可执行命令、独立路径、真实退出、明确指标、可读进度与日志、可选曲线、插件身份核实和用户授权。迁移这些边界，再按目标项目自身语义选择其余部分。
