# 按 GPU 槽位运行独立 job

项目在 `experiments/simple_project.yaml` 设置顶层 `distributedResults: true` 后，匹配 `distributed.planPrefixes` 的正式 `runPlan` 使用持久化的本机 job 队列。默认匹配 `experiments/plans/comparison/`；其他 Plan 沿用整 Plan 调度。预演使用 Agent 校验返回的 job 清单及插件当前空卡快照，在本机调用与派发相同的分配器，不再重复启动远端 dry-run。实际派发前 Agent 仍重新核对显卡。

队列记录 Plan revision、代码同步指纹、Case、seed、attempt、Worker、GPU、命令 ID、状态以及产物哈希。派发先处理旧 Plan 的就绪 job；旧 Plan 的任务已运行或完成后，新 Plan 可占用空卡。派发请求使用专用限流通道，仍遵守并发上限；Agent 在接受任务时重新检测 GPU 进程并原子保留槽位。状态不明的任务不会自动重派；用户在任务页点击恢复时，插件先向原 Worker 核实终止状态并保存已有产物，随后建立新 attempt。不同代码指纹的任务不同时运行。

每个 job 的输出使用 `原输出目录/attempts/<运行 ID>/`，重跑保留旧 attempt。项目适配器在该目录写配置、检查点和独立结果片段，并保留原始 TensorBoard 事件与日志。名称由下方契约指定。插件用 SimpleSFTP 先对小片段逐文件计算 SHA256、同步到在线 Worker 并生成非正式预览，再清点整个 job 目录、同步权重、原始曲线、日志及其余文件，逐目标核对内容。每个 job 转入成功或失败终态时立即更新预览清单，并将项目汇总模块返回的预览状态文件镜像到所有在线 Worker；成功 job 的片段和其余产物随后同步，失败 job 不进入正式指标。离线 Worker 保留待镜像状态，重连后补齐。同步使用文件清单，不执行目录删除。

每个 job 的独立输出目录必须至少包含一个 `.log` 文件；建议保存 `stdout.log` 和 `stderr.log`。插件同步并校验该目录中的日志。Agent 的 `tmp/tmux_logs/` 供运行时查看，属于各机器自己的状态，不能当作可镜像的 job 产物。

项目提供 `python -m <distributed.mergeModule> --manifest - --project-root <根目录> [--publish]`。清单通过标准输入传入，包含各 Plan 的 `expectedJobs`、`jobStates` 与已完成 job；每个完成 job 带 Case、seed、attempt、输出目录、代码指纹及 `artifacts` 相对路径到 SHA256 的映射。为了兼容现有 MultiModal 入口，仍附带配置、检查点、正式指标和四态片段的独立 SHA256 字段。模块最后一行向 stdout 输出 JSON，含非空 `outputPaths` 相对路径数组。预览调用应把 `jobStates` 和已校验片段生成小型状态文件；正式调用才生成共享表，并以临时文件加原子替换发布。Agent 在一个已具备全部所需文件的 Worker 上调用项目入口。项目入口只从当前清单的已校验 attempt 重建共享表。未完成的 Plan 不进入正式汇总；旧实验记录不导入。生成文件随后按 SHA256 镜像到其他在线 Worker。各 Worker 的原始 TensorBoard 可在运行期间独立查看；完整 Case 的均值曲线在原始事件同步后由项目入口重建。

## 新项目接入

在项目自己的 `experiments/simple_project.yaml` 中声明以下字段；插件只提供调度、清单、传输与验证，科学结果的含义和最终检验由项目模块负责：

```yaml
distributedResults: true
distributed:
  planPrefixes:
    - experiments/plans/formal/
  mergeModule: experiments.simple_adapter.distributed_results
  configPath: job_config.yaml
  checkpointPath: best_model.pth
  resultRowsPath: test_results/formal_result_rows.csv
  fourStatePath: test_results/four_state_metrics.csv
  fragmentPaths:
    - job_config.yaml
    - test_results/formal_result_rows.csv
    - test_results/four_state_metrics.csv
  requiredPaths:
    - job_config.yaml
    - best_model.pth
    - test_results/formal_result_rows.csv
    - test_results/four_state_metrics.csv
```

`fragmentPaths` 应只含较小且 job 结束后稳定的文件。`requiredPaths` 是正式发布前必须存在并完成哈希校验的文件；检查点必须列入。所有路径均相对 job 输出目录，不得为绝对路径或包含 `..`。`mergeModule` 必须是项目内可导入的 Python 模块名。项目测试应覆盖：重复回报的幂等性、缺失 seed/端点/检查点时拒绝正式发布、不同 Case 的 TensorBoard 不混合、并发完成后共享结果不丢行。未准备好独立片段和汇总模块的 Plan 不要放入 `planPrefixes`。

旧版本仍在运行时提交新代码版本，插件会保存待校验提交；旧版任务及结果同步结束后，重新核对本机代码指纹，按原提交目标同步代码、校验 Plan 并派发。排队期间再次改动本机代码会阻止自动提交，需重新提交 Plan 以固定新版本。不得绕过此保护手动上传代码到运行中的 Worker。
