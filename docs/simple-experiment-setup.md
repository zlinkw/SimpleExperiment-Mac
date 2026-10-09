# SimpleExperiment 配置说明

本文是面向新用户的完整配置流程。快速概览见仓库根目录 [README](../readme.md)。

## 前置条件

| 项目 | 要求 |
| --- | --- |
| 本机 | Windows + VS Code 1.100+ |
| 插件 | `SimpleSFTP` 和 `SimpleExperiment` 同时安装 |
| 远程 | Linux、Python 3、可写实验目录；建议有 tmux |
| Python 依赖 | 运行计划的环境安装 `PyYAML` |
| 登录 | Xshell 已保存 Hub/Worker `.xsh` 会话 |

不要把 token、密码或私钥写入项目文件。

## 配置总览

```text
准备服务器目录和 Conda
        ↓
配置 Xshell 本地隧道并保存 .xsh
        ↓
在 SimpleExperiment 设置中填写 Hub / Worker
        ↓
选择拓扑模式并检测全部
        ↓
准备 Agent 并启动
        ↓
接入本地实验项目和 Plan
        ↓
校验、预演、确认后运行
```

每个 VS Code 窗口只打开一个实验项目。多根工作区会在上传、Agent 部署和远端运行前被阻断。

接入顺序：Xshell 会话 -> SimpleExperiment 服务器目录 -> SimpleSFTP 目标 -> 准备 Agent -> 运行 Plan。

## 1. 安装插件

1. 安装最新版 `simple-local.simple-sftp`。
2. 安装最新版 `simple-local.simple-experiment`。
3. 执行 **Developer: Reload Window**。

两个插件的 Latest Release 会成对发布。面板“设置”中的配套更新入口会同时检查两者；确认后才下载并按 SimpleSFTP → SimpleExperiment 的顺序安装。

## 2. 准备远端目录和环境

示例：

```bash
mkdir -p /data/experiments
conda create -n ml-env python=3.10 -y
conda activate ml-env
python -m pip install PyYAML
tmux -V
```

目录规则：

```text
用户填写的项目父目录: /data/experiments
本地工作区名:         my_project
远端代码目录:          /data/experiments/my_project
Agent runtime:        /data/experiments/simple_agent
```

不要把 `/root`、`/tmp`、数据集目录或当前项目名填成项目父目录。

## 3. 创建 Xshell 隧道

为 Hub 和每台 Worker 分别创建已保存会话。

Hub 示例：

1. 打开 Xshell 会话属性。
2. 进入 **连接 > SSH > 隧道**。
3. 点击 **添加**。
4. 类型：**Local (Outgoing)**。
5. 源主机：`localhost`；源端口：`18765`。
6. 目标主机：`127.0.0.1`；目标端口：`18765`。
7. 保存并登录测试一次。

Worker 的本机监听端口必须不同，但远端 Agent 端口通常相同：

| 角色 | 本机监听端口 | 目标地址 |
| --- | ---: | --- |
| Hub | `18765` | `127.0.0.1:18765` |
| Worker A | `18766` | `127.0.0.1:18765` |
| Worker B | `18767` | `127.0.0.1:18765` |

检查项：

- 源和目标都只使用 loopback 地址。
- 每个端点的本机监听端口唯一。
- 尽量不复用同一个 `.xsh` 文件。
- 如果设置了 Agent token，所有 Agent 必须使用同一个值。

## 4. 填写 SimpleExperiment 服务器设置

打开单项目工作区，进入 **SimpleExperiment > 设置 > 服务器**。

如果从配置说明或错误提示进入，点击 **打开服务器设置** 会直接定位到该区域。

### Hub

| 字段 | 示例 / 说明 |
| --- | --- |
| 显示名 | `Lab-Hub` |
| Xshell 会话 | 选择 Hub 已保存的 `.xsh` |
| 本地转发端口 | `18765` |
| 远端 Agent 端口 | `18765` |
| 项目父目录 | `/data/experiments` |
| Conda 环境 | `ml-env`；留空使用系统 Python |
| tmux 前缀 | 多用户时改成短用户标识 |

### Worker

除 Hub 相似字段外，还要填写：

| 字段 | 说明 |
| --- | --- |
| 本地转发端口 | 例如 `18766`，必须唯一。 |
| 并发占卡上限 | 该 Worker 允许同时使用的 GPU 数。 |
| 允许 GPU ID | 如 `0,1,2,3`；留空不限制。 |
| Worker Conda 环境 | 可覆盖全局环境；空值或 `-` 视为未配置。 |

### 安全边界

可在 VS Code settings 中添加：

```jsonc
"simpleExperiment.remote.allowedRoots": [
  "/data/experiments"
],
"simpleExperiment.remote.deniedRoots": [
  "/root",
  "/data/experiments-forbidden"
]
```

这些路径只限制“项目父目录”，不会自动推断某台服务器的存储路径。

## 5. 选择拓扑

在服务器设置中选择一种：

| 模式 | 适用场景 |
| --- | --- |
| `single_worker` | 只有一台执行机，无 Hub。 |
| `worker_pool` | 两台以上 Worker 分片执行，无 Hub。 |
| `hub_worker` | Hub 调度汇总，至少一台 Worker 执行。 |

切换模式不会迁移旧任务。正式运行前至少要有一台启用的 Worker。

## 6. 准备 Agent

点击 **准备 Agent 并启动**。确认窗口会显示：

首次配置使用“准备 Agent 并启动”完成受管自启动命令、runtime 部署、会话启动和检测。

准备 Agent 前必须打开目标本地项目；插件不会把 Agent 部署到通用占位项目目录。

- 将修改的本地 `.xsh` 文件和固定备份路径；
- 每台服务器的 runtime 上传位置；
- 当前项目的最终远端代码目录；
- Hub/Worker 角色与 SSH 身份。

确认后插件会写入受管 `RemoteCommand`，通过 SimpleSFTP 上传 runtime，启动 Xshell 会话，然后检测端点。

已有非 SimpleExperiment 登录命令的 `.xsh` 不会被覆盖；需要先人工迁移该命令。

检测通过标准：

- Hub 和所有启用 Worker 可达；
- Agent 版本兼容；
- Agent 报告的项目路径等于 `<项目父目录>/<当前工作区名>`；
- Worker availability 可获取。

## 7. 接入项目

推荐结构：

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
    simple_project.yaml
  work_dirs/
```

点击 **接入当前项目** 后：

1. 选择或创建 Plan。
2. 确认训练/评估入口和命令。
3. 确认结果文件路径。
4. 缺少输出映射时生成轻量 adapter。
5. 执行检测和输出契约检查。

Plan 示例（向 MultiModal 对齐：train 仅 `--output-dir`，test 双写）：

```yaml
suite: demo
base_config: configs/smoke.yaml
mode: train_test
seeds: [0]
runner:
  train_command: python train.py --config {config} --seed {seed} --output-dir {output_dir}
  test_command: python test.py --config {config} --seed {seed} --output-dir {output_dir} --result-csv {result_csv}
naming:
  output_dir: "work_dirs/{case}/seed_{seed}"
cases:
  - name: smoke
paper:
  result_csv: experiments/results/demo.csv
# 口径说明（与主契约统一）：此处为最终大表覆盖写法（回退链第 1 级直接字段命中大表，test 经 --result-csv 追加）；
# 新手 per-job 默认写法为 `paper.result_csv: "{output_dir}/metrics_summary.csv"`（见 docs/plugin-project-contract.md “paper.result_csv 口径统一”）。
# `naming.output_dir` 优先级高于 `sweep_dir/job_name` 拼接；`cases` 中 `name:` 与 `case:` 等价归一。
expectedResults:
  - "{output_dir}/metrics_summary.csv"
  - "{output_dir}/metrics_case.csv"
  - experiments/results/demo.csv
```

标准输出：per-job 双 csv（`metrics_summary.csv` + `metrics_case.csv`）+ 双 log（`stdout.log` + `stderr.log`）+ 最终大表（`experiments/results/<method>.csv`，按实验类型命名）。试探输出先落 `tmp/`，确认后转正，不进归档。

首次接项目先使用 smoke 配置和小规模 epoch/step。

## 8. 运行和监控

1. 选择 Plan。
2. 点击 **校验并提交运行**。
3. 在强确认窗口核对：
   - 最终远端项目路径；
   - Plan 和 revision；
   - 任务数；
   - topology 和 selectedWorkers；
   - condaEnv；
   - maxConcurrentGpus；
   - 预期结果位置。
4. 确认后插件自动同步代码。
5. 自动校验和预演通过后才提交调度。
6. 在任务页查看日志、排队、失败、停止和重试。

Debug 运行会隔离到 debug 目录，不能进入正式归档、统计或 PPT 流程。

## 9. 结果处理

调度终态后：

1. 插件检查 Plan 声明的结果路径。
2. 解析完整预览结果。
3. 用户选择哪些记录归档。
4. 已归档记录才进入质量门禁、统计摘要、论文表格、claim evidence 和 PPT 绘图。

不要把临时预览 CSV 当作论文证据来源；有效结果以归档清单为准。

## 常见问题

| 问题 | 处理 |
| --- | --- |
| 本地端口未打开 | 启动对应 Xshell 会话，重新核对 Local (Outgoing) 转发。 |
| Agent 不可达 | 核对本机端口、远端端口、token 和 tmux 会话。 |
| Agent 版本不匹配 | 重新部署 runtime 后重启 Xshell/tmux，再检测全部。 |
| 项目目录不匹配 | 修改“项目父目录”，不要让末级重复出现当前项目名。 |
| 未配置 condaEnv | 在 Worker 卡片填写真实环境名；`-` 不是环境名。 |
| PyYAML 缺失 | 在实际执行环境中执行 `python -m pip install PyYAML`。 |
| SimpleSFTP 未就绪 | 安装配套版本并重载窗口。 |
| 上传慢 | 用 ignore 规则排除数据集、checkpoint、缓存和大模型文件。 |

## 支持边界

- 不内置 SSH、SCP 或 RSYNC 客户端调用。
- 不自动删除远端数据集、checkpoint、归档或结果。
- 不绕过路径确认、运行确认和 Debug 门禁。
- 不根据服务器名猜测远端根目录。
- 所有状态文件使用原子替换，并保留审计字段。
