# Runtime And Agent

Remote runtime lives under:

- `simple_cluster/runtime/manifest.json`
- `simple_cluster/runtime/cluster_scheduler.py`
- `simple_cluster/runtime/cluster_agent.py`
- `simple_cluster/runtime/worker_probe.py`
- `simple_cluster/runtime/backups/<timestamp>/`

Deploy flow:

1. Inspect manifest.
2. Compare runtime version and SHA256.
3. Backup old runtime.
4. Atomic upload new runtime.
5. Verify hashes.
6. Restart Agent when needed.
7. Roll back on failed deploy.

Agent stream is the realtime path. Snapshot and journal are recovery paths.

`cluster_agent.py` 只使用 Python 标准库。`cluster_scheduler.py` 需要当前系统 Python 或指定 Conda 环境安装 `PyYAML`。Agent 在 Plan 校验、预演、正式调度和 Worker 任务启动前调用 scheduler 的结构化依赖检查；缺失时返回执行环境、模块名和安装命令，不启动任务。
