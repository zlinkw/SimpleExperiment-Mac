# Plan 卡片顺序与按内容复用配置检查

当前基线：0.5.232 / 97dc903d。范围仅限提交顺序展示、配置校验复用与动态状态检查。保留两个原有 dirty `.pyc`，不操作实际运行任务，不改传输和结果语义。

## TODO

- [x] 用生产渲染代码复现两个 Plan 因进度、状态、更新时间交换位置。
- [x] 按当前提交世代的不可变提交时间升序排列；相同时间用 Plan 路径稳定排序。保留历史折叠、选择与详情。
- [x] 成功配置检查按 Plan、代码内容、适配规则、运行参数、Worker、运行环境与 runtime 身份复用；Host/Agent 各最多 32 个内存模板，不依赖时间延长。
- [x] 每次仍查询真实任务占用、Worker/GPU、已有产物与声明输入存在性；缓存禁止保存动态产物与预演结果。远端 proof 或静态依赖覆盖不足时走完整校验。
- [x] 配置未变化且远端缓存命中时直接返回新动态产物检查结果，免除重复 scheduler 启动和终态轮询；旧 Agent 安全回退。Scheduler 与 Agent 共用产物检测逻辑，读取失败不冒充空目录。
- [x] 串行目标回归、build、外层与内层 Webview 语法门禁；核对 `.pyc` 与 scoped diff。两个已有 bytecode 文件仍保持未提交；测试生成缓存不纳入交付。
- [x] 版本、打包、提交并推送 origin/master；安装一次并核对入口。安装后等待用户重载再做现场验收。

## 验证记录

UI 回归先复现 3 项失败，再修正为 15/15 通过；连续 20 个交替状态、进度、更新时间和输入顺序的快照不改变并行 Plan 卡片顺序。配置缓存回归 4/4 验证 fresh outputs、GPU 占用排除、内容/proof/环境变化、安全回退、32 项 LRU 和不存在的输入继续拦截。

29 个目标测试文件逐文件串行通过，合计 266 项；包括 preflight、历史产物重跑、真实 active guard、停止/安全重试、工作区隔离、execution UI，以及 Panel ACK/背压、projection、render health、lifetime recovery、generation guard。`npm run build` 与 `npm run package` 通过，另包含 1 项 Webview script health。额外 `vm.Script` 通过外层模块和实际生成的 2 段内层脚本。

交付版本 0.5.233；VSIX 197 个 runtime/入口/共享 helper 文件逐一与工作区 SHA256 对照通过，无 `.pyc` 入包。VSIX SHA256：`f282a444fe87ed01bd7b4fc8ef604afffa1e96b10d30a62e5d41404aa67d38d4`。代码提交 `b43d764e` 已普通 fast-forward 推送 `origin/master`，fetch 后本地/远端一致。

`npm run install:latest` 仅执行一次，成功安装 0.5.233，未 force 或降级。安装目录 196 个 runtime 文件 SHA256 一致，package 身份排除 VS Code 注入的 `__metadata` 后一致。`code --list-extensions --show-versions` 确认 SimpleExperiment 0.5.233，SimpleSFTP 仍为 0.2.59；全局 `simpleex.ps1` 与 `simpleex --help` 入口正常。安装后没有操作面板、查询运行 API、重载窗口或部署正在运行的 Worker。

现场启动耗时和 UI 长时间观察保留到重载后，不能用模拟测试声称实测提速。新 Agent 才能响应内存模板快路径；旧 Agent 继续执行完整校验，不绕过检查。部署/重启 Agent 后第一次检查仍需正常完整校验，之后同内容命中免除 scheduler/dependency 子进程和异步终态等待。
