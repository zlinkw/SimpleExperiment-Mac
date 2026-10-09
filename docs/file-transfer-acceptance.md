# SimpleSFTP 文件传输验收清单

## 固定边界

- `SimpleExperiment` 不直接执行 SSH、SCP 或 RSYNC，也不使用 SFTP 传输实时状态。
- `SimpleSFTP` 负责代码、Plan、配置、Agent runtime 和用户主动选择的真实文件传输。
- GPU、日志尾部、任务状态和操作进度只通过 Xshell 本地隧道后的 Hub/Worker Agent 获取。
- 上传目标由 Hub/Worker 的“项目父目录”派生为 `<项目父目录>/<当前项目名>`，Agent runtime 位于 `<项目父目录>/simple_agent`。

## 发布前检查

1. Hub 与每个启用 Worker 都已配置 Xshell 会话和项目父目录。
2. SimpleExperiment 的“项目关键入口”显示服务器与运行门禁通过。
3. SimpleSFTP 已安装且可在命令面板看到 `SimpleSFTP：上传工作区到目标`。
4. 目标服务器目录由当前用户写入，不使用管理员账户或共享凭据。
5. `%APPDATA%/SimpleSFTP/server-profiles/servers.json` 中的 Hub/Worker 目标指向 `<项目父目录>/<当前项目名>`，不再写入旧私有扩展的 server-profiles 路径。

## 手动验收

1. 上传 Hub 代码。
   操作：在“发布与代码同步”点击“首次上传到 Hub”。
   预期：只上传轻量项目代码；远端位置为 Hub 项目父目录下自动追加当前项目名的目录。

2. 上传 Worker 代码。
   操作：点击“首次上传到 Worker”。
   预期：每个启用 Worker 的上传结果独立显示；单台失败不会伪装为全部成功。

3. 部署 Agent runtime。
   操作：点击“部署最新版 Agent”。
   预期：`cluster_agent.py` 和 `cluster_scheduler.py` 写入每台服务器的 `simple_agent/runtime`，不覆盖项目代码目录。

4. 忽略规则。
   操作：在“运行环境准备”的上传按钮下点击“设置 SFTP 忽略目录”，逐台服务器配置 SimpleSFTP 的目录规则。
   预期：插件源码清单与 SimpleSFTP 忽略规则分别生效。`data/` 中的 `.py`、`.pyi` 和命名为配置或协议的轻量 YAML、JSON 等文件可同步；`data/datasets/*.py` 也可同步。图像、数组、患者目录、特征缓存和模型权重仍被插件源码清单排除，不依赖用户额外配置忽略规则。
   上传前，插件通过 Agent 检查目标文件的 Git 状态；远端未提交或未跟踪文件会列出精确路径并要求用户逐次确认覆盖。无远端 Git 基线时，已有文件内容不同也要求确认；冲突超过 20 项则阻止批量覆盖。上传后逐个核对必需 Python 源码的 SHA256；缺失或版本不一致显示为同步失败。

5. 提交 Plan 前同步。
   操作：对小 Plan 依次执行“校验”“预演”“提交运行”。
   预期：提交前会同步代码并核验 fingerprint；缺少项目父目录、SimpleSFTP、Plan 配置或输出门禁时必须阻止运行。

6. 传输失败。
   操作：暂时配置一个不可达 Worker 后上传。
   预期：错误明确标明 Worker 和原因；Hub 与其他 Worker 的成功状态保持可见，可修正后重试。

## 不属于文件传输的操作

- 运行状态、GPU、任务日志和归档终态不应通过 SimpleSFTP 轮询。
- 结果预览、质量门禁、统计、论文表和 PPT 绘图只读取项目内轻量结果文件；不扫描数据集、checkpoint 或权重。
