# 通用 wrapper 结果链路与紧凑详情

本批目标：保留既有端点与四态原始 CSV，校验 SHA256、运行/attempt/case/seed/Worker/来源及同一 checkpoint；完整三种子才正式发布，缺失或失败保留旧完整结果，未完成运行只预览。使用既有 Simple API 补收 DPL 已有文件，不重训、不改 MultiModal 模型。

范围补充：默认读取 wrapper 的 `artifact_manifest.json` 和任务已记录的产物清单，收集所有声明的结果类型。CSV/TSV 按相对输出类型、数据集、方法合并，表头取并集，保留未知列、空值、不可计算原因。JSON/JSONL 原结构收录；YAML、文本和未知二进制原样保留并建索引。没有端点 CSV 的 wrapper 也可发布完整结构化产物包，不臆造科学统计。权重继续走既有完整产物同步，不进入指标解析器。四态只是一种可识别的增强校验 schema，不作为其它项目的接入要求；`distributedResults: true` 本身也不会强制要求四态文件。

合并视图增加 `simple_run_id`、`simple_attempt`、`simple_case`、`simple_seed`、`simple_worker`、来源路径与 SHA256。原始文件不改列、不改字节；每份原文件旁保存 `.provenance.json`。原有映射路径继续有效，各 attempt 单独留存。通用收集不把预测值、计数或任意数字列当成科学统计；端点统计继续使用既有结果接口。轻量结果接收维持 4 MiB 单文件/批次上限，超限或不安全路径明确拒绝正式发布；大文件和权重仍由产物同步处理。

- [x] 读取插件/复现项目约束及 Git 状态；原有两个 dirty `.pyc` 不进入提交。
- [x] 现场：SimpleExperiment 0.5.238、SimpleSFTP 0.2.59；DPL 已发布运行 klf0vx 为 6/6，新运行 ia4ase 为 5/6。通过 SimpleSFTP inventory/memoryOnly 读取旧完整运行样本，端点与四态文件存在。
- [x] 回归真实 memoryOnly → 校验 → 保真持久化 → 同世代端点/四态事务发布；涵盖 A→B、缺文件、哈希错误、种子缺失、幂等及回滚。
- [x] 已有映射路径保存原文及稳定 provenance；每个 attempt 独立，不删除历史，不补零、不另写科学统计。队列补充 hash/同步回执后仍幂等。
- [x] 集成两种同步按钮及本地结果重建；本地读取复用持久化映射、按字节处理二进制；未完成运行独立预览；持久化内容不进入大体积 Panel state。
- [x] 详情按钮并排、减少间距，窄屏自然换行。
- [x] 串行相关测试、build、vm.Script、VSIX 校验。
- [x] Simple API 实际补收并直接核对本地文件 SHA256、job_dir/runId、端点/四态 checkpoint；代码验证与现场验证分开记录。
- [x] 0.5.239 补丁版本、打包、安装一次；VS Code 安装版本与 `simpleex` 入口已核对。当前批次提交及 origin/master 同步以 Git 记录为准。

## 现场补收

通过 `scripts/recover-wrapper-results.js` 复用生产的发现、接收、校验、汇总及事务发布代码，传输调用现场 SimpleSFTP API；没有调用训练或修改模型。补收开始时最新运行已经由 5/6 变为 6/6。

- `distributed-plan-1791341503882-klf0vx`：6 个 job，attempt 4，84 个 wrapper 原始结果文件；nwpu3/nwpu2 各 42 个。全部本地 SHA256、job_dir/runId/来源及 checkpoint 已核对。
- `distributed-plan-1791348830907-ia4ase`：6 个 job，attempt 5，84 个原始文件；nwpu3 56 个、nwpu2 28 个。全部本地 SHA256、job_dir/runId/来源及 checkpoint 已核对。正式端点与四态以该运行发布，旧 attempt 的原始证据保留。
- 文件类型包含端点、四态、病例明细、预测、训练曲线、manifest、环境与配置快照；不只补收四态 CSV。
- 当前结果证据入口：复现项目 `simple_cluster/results/project_table_registry.json` 的 `plans["experiments/plans/comparison/dpl.yaml"].wrapperEvidence`；每份源文件有 SHA256 和本地映射路径。
- 重复补收最新 B 后缺失、待指标、跳过均为 0；本地再次核对 A/B 合计 168 份原始文件 SHA256，各运行 6 份四态 CSV。BUS 与 PAD 的三种子正式端点和通用四态合并视图均绑定 B；A 的原始文件仍在。
- 当前四态合并视图：`experiments/results/{bus_cot_lesion|pad_ufes_20}/methods/dpl/wrapper/dpl__2cbc63c3/test_results_four_state_metrics.csv__519807c4.csv`；保留全部原字段及 `simple_*` 来源列。

## 代码验证

串行执行 12 个相关单文件测试，共 150 项通过；build 的 Webview 脚本健康检查另外 1 项通过。新增通用链路 15 项涵盖原要求及非四态 wrapper、自定义端点名、无端点包、TSV 含逗号/引号/换行、JSONL 身份冲突、本地二进制读取、后台端点刷新保护。使用每文件 20 秒的 `node --test --test-force-exit --test-timeout 20000`，没有并行测试进程。

`npm run build`、编译后 `PanelHtml.js`/legacy 文件及渲染所得两个内层脚本的 `vm.Script` 均通过。端点均值、样本标准差、别名、数据集目录、结果事务、结果目录缓存、紧凑卡片和精确 tmux 跳转回归均通过。

`npm run package` 验证 191 个运行时模块闭包；VSIX 中新通用模块和四态校验模块均存在，package/runtime 同为 0.5.239。`npm run install:latest` 仅执行一次，已安装 `simple-local.simple-experiment@0.5.239`；`simpleex --help` 入口正常。安装后不再操作旧 Host 面板/API。

## 风险与边界

新 Host 代码安装后需要用户执行 **Developer: Reload Window**。重载后按钮实际显示、窄屏排版及长期自动刷新仍由用户观察；本轮现场补收通过复用生产 helper 的独立 API 验收入口执行，不伪装旧 Host 已运行新实现。磁盘结果发布复用现有租约、世代比较和事务入口。已发布文件身份不一致时拒绝覆盖。原始科学指标和不可计算原因原样保留，不自行生成统计结论。

## 0.5.240 兼容性与增量修复

0.5.239 的通用收集暴露两处回归。旧 Corim seed43 作业的 `undefined_metrics.csv` 中存在诊断字段 `seed=42`，但同作业四态 CSV 为 seed43，job_dir/checkpoint 正确。不能把任意附属 CSV 的同名列当成作业身份。现在仅对 canonical 指标角色、四态 schema 或明确 run/job 锚点执行作业身份校验；附属诊断字段保持原文，并另附已验证的 `simple_seed` 来源。真正的端点、四态及带运行锚点的冲突仍拒绝发布，错误明确包含期望值、实际值及来源文件。

原 SHA256 校验没有消失，但内存接收路径没有复用本机原始证据，manifest 发现还使用了占位 Plan 映射，导致重复下载。现在使用本轮远端清单的大小与 SHA256 校验本机既有映射，所有格式和 manifest 均可复用；仅缺失或不同内容进入传输请求。校验不依赖 mtime，不创建额外缓存。manifest 使用实际 Plan、运行及 Worker 映射；跨运行不借用旧证据。通知分别报告本机复用、下载差异，完成数包含验证而不会冒充网络下载数。`code_backup/` 属于代码快照，由完整产物同步处理，不进入结果解析。

现场全量发布超过原 4096 个事务目标上限。现在上限为 32768，事务日志读写同时受 32 MiB 上限保护；路径、去重、世代与注册表最后提交门禁保留。已核验且字节相同的目标不重新暂存、备份或覆盖；正式发布前再次核验复用目标。Windows 大日志共享冲突只在发生冲突时允许最多 5 秒重试，普通任务状态仍保留原短重试。最终 journal 写入失败不会把已经提交的结果误记为回滚，可由既有恢复入口完成。

完整 wrapper 恢复还会替换旧同运行的端点集合，避免旧端点别名记录虽带 runId、却没有 job_dir/checkpoint 的记录混入新汇总。真正的 Worker 部分结果刷新继续保留其既有合并策略。

### 本轮代码验证

- 串行单文件回归：通用持久化 18、指标同步 39、端到端指标 5、事务发布 13、项目表 19、队列缓存 12、暂存生命周期 4，共 110 项通过；build 的 Webview 健康检查另外 1 项通过。
- 新增覆盖：重复同步网络请求为零、相同大小/mtime 的本机污染不复用、诊断 seed 保真且 canonical seed 仍严格、旧同运行匿名端点移除、相同原件不替换、超过旧事务容量的安全预检、Windows 长共享冲突、已提交 journal 失败后恢复。
- 补丁版本递增期间曾因尚未 build 的 runtime/package 不一致触发测试保护页；完整 build 后对应指标同步 39 项已重新通过。不是以修改生产保护来修测试。
- `npm run build`、编译和两个渲染脚本的 `vm.Script` 均通过；VSIX 191 模块闭包、package/runtime 0.5.240 及不含 `.pyc` 已核对。`npm run install:latest` 只执行一次，已安装 0.5.240，`simpleex --help` 入口正常。安装后停止操作旧 Host，等待用户重载。

### 本轮实际补收验证

使用 `scripts/recover-wrapper-results.js --workspace D:/GitRepo/MultiModal --plan-prefix experiments/plans/comparison/ --publish` 复用修改后的生产 helper，通过现场 SimpleSFTP API 补收。现场 Extension Host 仍是 0.5.239，本次验证不宣称旧 Host 已加载新实现。

17 个比较 Plan 全部成功，102 个完成 job，3216 份原始结果。直接核对每份本机 SHA256、provenance 的 runId/attempt/case/seed/Worker/job_dir/来源，以及正式端点记录与同运行 wrapper checkpoint 的绑定，缺失、待指标、跳过均为 0。BUS 与 PAD 的本机 `final/final.md` 已重新发布；不重训、不修改 MultiModal 模型、不删除旧 attempt。

重复补收时 nwpu2 复用 1614 份、nwpu3 复用 1330 份、nwpu5 复用 272 份，共 3216 份；网络文件数及网络内容字节数均为 0。首次新原件补收仍需下载，清单与 SHA256 校验继续执行，不将零下载误称为零网络请求。

实机批量发布中曾遭遇 Windows journal `EPERM`；现有恢复入口完成该发布，再补充长共享冲突和终态恢复机制及回归验证。最后一次批量补收与本机核对全部通过。其它 3 个预实验 Plan 在当前权威队列中没有可核对的完成运行或已记录逐 seed CSV，仍应标为待指标，不能补零或套用比较实验结果。

## 0.5.241 同步按钮回执与重复弹窗

上一批修复了解析、增量接收与结果发布，却遗漏真实按钮外层的 `withUiCommandStatus`。收集器已发布部分有效结果并发出一次警告后，外层仍把任何缺失/跳过项判为整个操作失败，再弹一个模态错误。当前 Plan 的 `syncAllResultArtifacts` 分支还丢弃了收集报告，不能准确回传结果。

三个结果按钮现在共用收集报告分类：部分有效结果发布完成后明确返回 partial 警告及收录/缺失/跳过/待指标/预览计数；仅预览不冒充正式汇总；没有任何有效发布且存在校验错误仍为 failed。收集器已通知时外层不再重复弹窗。实际异常和取消仍走原失败/取消链路，SHA256、运行身份、完整种子及事务发布门禁未放松。当前 Plan 的报告现在直接返回到真实命令分发和终态回执。

### 代码验证

真实按钮状态封装先复现 9 项失败，命令分发确认当前 Plan 报告返回 undefined，再实施修复。串行单文件回归共 148 项通过：按钮警告/失败 13、真实分发 11、完整收集发布及按钮回执 18、指标同步 39、wrapper 保真持久化与增量 18、事务发布 13、提交预检 19、预检进度 16、tmux 终态 1。集成验证直接执行生产收集器及 `handleMessageCore` → `withUiCommandStatus`，两种按钮各发布 3 个有效 Plan，保留 1 个不可读取 Plan 的报告，每次点击只发一次警告，正常释放按钮与同步计数。网络在该回归中使用受控 API 替身，不能宣称现场 Host 已完成按钮验收。

### 实际本机证据核对

只读核对 MultiModal 已补收的 17 个比较 Plan、102 个 job、3216 份原件，全部 SHA256、provenance 的 runId/attempt/case/seed/Worker/job_dir/来源、端点与 wrapper checkpoint 绑定通过。BUS/PAD 的 `final.md` 已存在更新后的文件。本轮没有重新执行远端补收，也没有使用单元测试替代现场收集验证。现场发现文件仍报告运行 Host 为 0.5.239；安装新版后必须用户重载窗口，之后才可验证按钮在新 Host 上的实际显示。

版本 0.5.241 的打包、单次安装、安装版本与入口核对及本批 Git 同步，以本批命令结果和对应提交为准。

## 0.5.242 本地目录识别与按钮完成门禁

现场 Host 0.5.241 的结果缓存为零张表，但本机 BUS/PAD 的正式 CSV 与 Markdown 都存在。生产目录读取器在字母顺序较前的 `_shared` 中列满 2000 份原件后，直接退出数据集及 Plan 扫描，导致后面的正式总表与方法表永远不被识别。手动刷新还仅使缓存失效，不等待目录线程完成，且读取依赖面板结果区兴趣；因此三个按钮可能先报告完成，面板仍没有本地条目。

原件列表预算现在只限制原件枚举，不中断正式表和已注册 Plan 身份识别。刷新本地结果、同步服务器结果、下载指标并重新汇总均等待生产目录线程完成、更新缓存并推送本地条目后才结束；本地刷新不依赖网络同步或结果区是否展开。后台扫描与发布/恢复共用 32 MiB 事务记录上限，避免已合法发布的较大记录被读取器拒绝。原 SHA256、运行身份、完整种子及发布事务门禁保持。

### 代码验证

先复现共享原件超限后正式表消失、无结果区兴趣时刷新不读取、合法较大事务记录被拒绝。串行单文件回归共 139 项通过：目录缓存 12、完整同步 18、指标收集 39、通用持久化 18、项目表 19、失败提示 13、真实按钮分发 11、数据集目录 7、无 Hub 读取 2。两种服务器按钮集成回归直接执行生产收集器、目录线程和终态封装，完成回执发出前已缓存四张正式/方法表。本批没有执行远端补收或清理。

### 实际本机验证

使用现场 API 读取当前项目配置，执行修改后的生产本地刷新 helper，保持运行 Host 不变。MultiModal 本机识别 BUS/PAD 各 18 张表，共 36 张，17 个比较 Plan；刷新约 0.9 秒后返回 ready，推送缓存包含全部 36 张表。3216 份历史原件逐份 SHA256 前后相同，注册表发布世代未变化；本地刷新未查询服务器或启动传输。此项是实际本机目录与生产 helper 验证，不能替代安装后重载窗口的可见 UI 验收。
