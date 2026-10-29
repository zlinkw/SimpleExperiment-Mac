# Windows 0.5.440 增量同步

本轮用户要求“win又更新了，同步更新到master”。GitHub master 与稳定 Release v0.5.440 均核实为 c6005169d6298d7713c653b34f909268de505bae，在前次 0.5.438 后新增两个提交：Worker 指引与 Hub 退役文档、AI 接入任务和 MultiModal 实践。Windows SFTP 仍为 0.2.117 / 7c136f209bf0fee8a1f98eebdececc02afca02bf，无新增提交，因此 Mac SFTP 0.2.105 不改源码或版号。

Mac Experiment 升至 0.5.319，package、lock 与 runtime 一致。通过旧 Windows、当前 Mac、新 Windows 三方增量合并共同源码与相关测试；仅解决 Mac 平台参数、系统 OpenSSH / Termius 提示、扩展命名空间、simpleex-mac 与在线指南 URL 差异。保留 Mac 认证、Application Support、preview 更新、Darwin 路径/句柄和共同 Worker 调度；不导入 Windows 安装、发布或运行环境设置。设置页新增指南入口和复制任务沿用原 copyText 命令。

构建与 npm run package 退出 0，350 模块 / 2 入口闭包通过；单文件串行原 20 秒上限不变。影响域 12 个文件退出 0、59 项通过，另有构建内置面板脚本 9 项通过；无超时或跳过。首次 serverManagementSchedulerInputs 失败为新增文案仍含 Xshell，已纠正 Mac 提示并复验通过，原始失败日志保留。编译及渲染后 Mac 脚本另以 vm.Script 解析。复用前轮未变范围的证据，不声称本轮全仓重跑或真机通过。

候选包：D:/GitRepo/.worktrees/mac-sync-440/artifacts/simple-experiment-mac-0.5.319-darwin-arm64.vsix，2456226 字节，SHA256 b49a9baad4091e2750e4be20ef012c6e09d8a494c381f00a2184b9f3d54d3744。本轮不发布 Release、不更新 preview 索引、不安装扩展；在线配套仍为 preview-v0.5.318。完整日志与逐文件真实退出码保存在 D:/GitRepo/.worktrees/mac-sync-440/evidence/。不做额外包后验收，不操作真实服务器或科研数据。

当前范围为源码同步、必要自动检查、候选打包和正常快进同步 master；提交及本地/远端一致性以实际 Git 记录为准。完整目标模式继续暂停，M5/macOS、真实 SSH 认证、libproc、Extension Host 重载与实际传输流程仍未验收。本段替代下方旧批次的当前状态描述，下方历史证据保留。

---

# Windows 0.5.438 最小 Mac 适配

2026-10-29 从 GitHub 核实并冻结 Windows Experiment 0.5.438，提交 c1245215557d0860306190a900b60f685a7881be，正式标签 v0.5.438。配套 Windows SimpleSFTP 0.2.117，提交 7c136f209bf0fee8a1f98eebdececc02afca02bf。Mac 工作副本从刚 fetch 的 origin/master 创建，未使用原目录的未提交候选。

用户允许舍弃历史过度适配后重做。共同业务采用上述 Windows 源码，保留 GPU 内存准入、低流量查询、窗口与项目隔离、结果读取恢复、代码上传交接、输出隔离恢复及原入口。Linux Agent、Scheduler 与 tmux 任务生命周期恢复 Windows 实现和 `simpleExperiment` 结果协议字段，不再为 Mac 改写服务端业务协议。面板 CSS 恢复 Windows 样式，不保留旧的独立调色改写。

平台差异限于 Mac 扩展身份、命令和配置命名空间、Application Support 发现与租约路径、POSIX 文件身份、系统 OpenSSH 和配套认证、Termius 手动指引、Darwin 文件句柄检查、静态 preview 更新与 darwin-arm64 包入口。后台隧道复用新版共同管理器及项目切换取消保护，Mac 仅注入 `/usr/bin/ssh` 与独立认证。

本次不恢复历史完整目标模式，不连接业务服务器，不运行科研实验，不进行实际传输或删除，不安装 Windows 开发机上的 Mac 扩展，也不自动发布 GitHub Release。原目录清理与候选源码适配分开；原索引及未提交文件尚保留。

开发检查采用单文件串行 Node 测试，单文件 20 秒、Python 子进程原有上限保持。构建和编译及渲染后面板脚本的 vm.Script 必须通过。检查记录保存在本轮外部工作目录。Mac M5、真实 SSH 认证、libproc 与 Extension Host 行为尚需真实 Mac 验证，Windows 替身不得冒充真机通过。

候选版号为 Experiment Mac 0.5.318 与 SFTP Mac 0.2.105，分别递增一个补丁版本；Windows 参考版号保持 0.5.438 / 0.2.117，不混同发行通道。

本机完成两仓构建、Experiment 运行闭包 350 模块 / 2 入口、编译与渲染后 Mac 面板的 3 份脚本解析、698 个源码指纹及源码缺口检查。恢复共同隧道后，旧 Mac 转发器与生成 Python 所用的 GPU 模块 JS 不属于安装时依赖，打包只排除这两份编译 JS，源码和生成 Python 均保留。

组合回归记录位于 D:/GitRepo/.worktrees/mac-sync-438/evidence/combined-summary.json，覆盖当前保留的 138 个套件，全部退出 0，共 1578 项通过、1 项既有平台跳过。SFTP test/stagedSlotLifecycle.test.js 曾在版号修正后的复验触发 20 秒上限。2026-10-29 用户明确授权按原上限复验一次；确认 Windows 无残留测试、WSL 发行版已停止后，只准备原有 WSL 环境，保持测试和生产代码不变，单文件复验退出 0、16328 毫秒、无 skip。首次超时、先前版本断言失败及全部修复前日志均保留。当前证据为同任务组合覆盖，不冒充一次新的全量运行。Windows 稳定 Release 与真实运行插件专属测试不导入 Mac 验证范围；本轮误导入的历史无关测试保留在各工作副本 clean_dir，不删除既有 Mac 测试。

候选包已生成，未安装、未发布：D:/GitRepo/.worktrees/mac-sync-438/artifacts/simple-experiment-mac-0.5.318-darwin-arm64.vsix，SHA256 1e8301250451bf079c12837b9ef40e3d3fadb0c58cc08e2848fecd07175affe2；simple-sftp-mac-0.2.105-darwin-arm64.vsix，SHA256 4ac070ed6f4c4a7a47bfba17f39b88cd90907077ef785f676159e84ab544a399。打包器自身检查通过，未额外进行独立包验收。

当前状态：本轮限定范围的本机适配、规定自动检查和候选打包完成。源码提交与远端同步以 Git 记录及 D:/GitRepo/.worktrees/mac-sync-438/evidence/delivery-receipt.json 为准，不等于 GitHub Release 已发布。原工作目录及原索引保持未动。真机 Mac 认证、libproc、窗口重载与实际服务器流程仍待用户环境。
