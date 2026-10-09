# 插件实验曲线页面与日志目录

GPU 状态卡片的“打开曲线”会打开插件本机页面。标量曲线由插件直接解析 Worker 的 TensorBoard event 文件并按 seed 汇总；图像、直方图、网络图等内容在同一页面的“图像 · 直方图 · 网络图”标签内显示。进入该标签时才启动该服务器上的原生 TensorBoard 进程。浏览器只访问插件本机 API；插件经已有 Agent 隧道访问 Worker。

## 新实验的目录契约

Plan 位于项目根目录的 `experiments/plans/**/*.yaml`，能被当前插件调度器解析为 `suite`、`case`、`seed` 和相对项目根目录的 `output_dir`。每个 seed 必须拥有独立的 `output_dir`。`output_dir` 必须位于插件配置的 `simpleExperiment.tensorboard.logdir` 下；该配置应为相对项目根目录的目录，默认 `work_dirs`。插件在对应目录的 `tb_logs/` 下寻找 `events.out.tfevents.*`：

```text
<项目根目录>/
  experiments/plans/comparison/example.yaml
  work_dirs/<suite>/<case>_seed42/tb_logs/events.out.tfevents.*
  work_dirs/<suite>/<case>_seed43/tb_logs/events.out.tfevents.*
```

实际目录名可以不同；**Plan 展开后的 `output_dir` 才是新实验的权威位置**。同一个 case 的不同 seed 不可写进同一个目录。多个 Worker 必须使用相同的 Plan 路径、case 名和 seed 标识，才能跨服务器求均值。event 文件必须是 TensorBoard TFRecord Event 格式，标量支持旧的 `simple_value` 与新的数值 `tensor` 编码。遇到不支持的编码会在页面报告文件名。

历史 event 文件若无法匹配 Plan，只扫描所配置的日志目录，最多遍历 5000 个目录且最多向下六层。若历史日志放在 `runs/`，请把 `simpleExperiment.tensorboard.logdir` 设为 `runs`。只有运行目录末尾含 `_seed42`、`-seed42`、`seed_42` 等明确 seed 后缀时，才允许聚合。没有可信 seed 标识的日志只作为原始曲线展示。位于 case 目录直接下方的 `tb_logs/` 若有 seed 子目录，会视为项目预先写出的均值并跳过，避免重复求均值。请勿把其他汇总日志伪装成 seed 目录。

页面按 Plan → case → 指标组织。首次打开只查询目录；点击 case 将它设为主图，自动列出并打开该 case 的**全部指标图**。其他 case 的“加入对比”按钮只叠加同名指标的均值曲线，最多可同时加入 19 个，加上主图共 20 个；按钮可再次点击移除，也可清空全部对比。左侧搜索框可按 Plan 或 case 名过滤，“仅看已选”只显示主图和已加入对比的 case。拖动侧栏右边界可调整宽度，也可用方向键调整；宽度在本机浏览器保存。长名称会分行，seed 数单独显示。

滚动到可见区域时才批量读取对应曲线，折叠的图不再轮询。默认只画按完全相同 step 对齐的跨 seed 均值，显示 `n/计划 seed 数`；可在设置中启用 seed 明细、样本标准差误差带。每张图都能独立调整平滑程度，并显示或隐藏均值与各 seed 的最大值点、最小值点。均值点用圆形、seed 点用三角形；红色代表最大值，蓝色代表最小值。平滑采用 [TensorBoard 当前折线图的去偏指数移动平均](https://github.com/tensorflow/tensorboard/blob/master/tensorboard/components/vz_line_chart2/line-chart.ts)。平滑均值用粗实线显示，启用平滑时原始均值用细虚线显示；标准差阴影始终以原始均值为中心，单 seed 或缺失的 step 不画阴影。所有曲线先画阴影再画线，防止后面的阴影遮住先画的线。平滑仅影响绘制，极值仍从原始数据计算。悬停可查看原始均值、平滑值、样本标准差、参与 seed 数及各 seed 原值。缺失、非有限值和离线 Worker 不计入对应 step；不会插值。每个 seed 的 `tb_logs/` 只读取最新的 event 文件；中断重跑时请覆盖、截短或重建该文件，或者创建更新的 event 文件，不要把旧运行继续附加在同一文件后面。页面按文件位置增量读取，并在文件重建时清除该文件缓存。

页面设置可指定每行显示 1–6 张曲线；窄窗口会自动减少列数。每张图的“单行显示”按钮可让该图铺满一行，布局会按浏览器本地偏好保存。图例中的“217 个 step · 末步 1/5 seed”表示这条曲线有 217 个不同的 step，**最后一个 step** 仅有 1 个有效 seed 值，而该 Plan 预期有 5 个 seed；它不代表整条曲线始终只有 1 个 seed。每个 step 的实际参与数可悬停查看。

图表底部悬停详情使用紧凑对比表，每个 case 占一行，列出 step、均值、平滑值、样本标准差、参与 seed 数及各 seed 原值。极值点显示“极值”，无法聚合的历史单 seed 曲线显示“原值”。case 和 step 列按当前内容收紧，其余宽度分给均值等数值列。每个 seed 有固定的独立列，蓝色加粗表头标明 seed 编号；同一步缺少该 seed 时显示“—”，因此不同 case 的同一 seed 始终纵向对齐。窄卡片保留 case、step、均值和参与 seed 数，平滑、标准差及各 seed 原值列会按宽度隐藏。表格不设内部纵向滚动。悬停表格行可查看完整字段和精度，或把该图切换成单行显示查看更多列。

浏览器页只经插件本机 API 和已配置的 Agent 隧道读取标量，不需要额外的远端曲线端口。插件重载后，已打开的页面会重试本机连接，并在服务恢复时继续刷新可见曲线；原生内容标签也会重新连接。页面授权在本机安全存储的密钥下跨插件重载保持有效，最长 30 天，活跃使用时自动续期。升级到支持此功能的版本前打开的旧标签没有可恢复的签名授权，需要从 GPU 状态重新打开一次。若本机 API 端口被其他进程长期占用而无法沿用原端口，旧标签也需要重新打开；插件会优先等待并复用原端口。

若未安装远端 TensorBoard，标量页仍可工作；图像、直方图、网络图标签需要远端训练环境中的 TensorBoard 包。该标签复用原有 tmux 启动和 Agent 隧道代理。标量解析不调用 TensorBoard Python 包或项目均值脚本；event 文件格式未来若改变，插件会报告不支持，而非假定兼容。
