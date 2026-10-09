# Job 日志入口合并

目标：运行进度内各 job 仅保留“跳转到日志”，点击后展开 TMUX 区域、选择该 Worker 的真实任务窗口标签。移除该位置的训练/终端日志按钮与内联预览；其他日志入口继续保留。不停止任务、不操作远端 tmux 生命周期、不创建日志副本。

- [x] 读取 AGENTS、项目约束及 Git 状态，保护两个原有 dirty `.pyc`。
- [x] 核对 Agent 的 tmux list 已含真实窗口 target、commandId、outputDir；不能按 GPU、case/seed 猜窗口。
- [x] 回归：单按钮、两次运行复用同 GPU、同名任务在不同 Worker、未派发、历史窗口关闭、延迟/旧回复、多次点击与主动切换。commandId 单独变化也刷新按钮身份。
- [x] 使用现有列表/捕获协议，仅显式点击跳转；列表异步回复只选标签，不再次滚动。窗口已关闭或连接失败明确提示，不展示其他任务日志。显式点击仅读取对应 Worker，不等待其他 Worker 的旧轮询。
- [x] 有界单个选择和 20 秒等待定时器；取消、完成和超时清理定时器，无新增文件缓存。
- [x] 串行相关测试，build 与实际生成脚本的 vm.Script 校验。
- [x] 递增补丁版本、package、校验 VSIX，安装一次后核对版本/入口；安装后停止 Panel/API 操作。
- [x] scoped commit、普通 fast-forward 推送并核对 origin/master，工作区只保留原有两个 `.pyc`；本批提交可通过该文档的 Git 历史定位。

真实点击与服务器日志验收需用户重载后完成，本轮不发送远端操作。

## 验证记录

基线：master `13a9df57`，源代码和已安装版本 0.5.237；本批目标版本 0.5.238。

- 16 个测试文件逐文件串行，82 项通过：jobTmuxLogNavigation（8）、distributedRerunAndWorkerDelta（8）、tmuxPaneSwitch（2）、tmuxTaskTabCloseClick（1）、tmuxWorkerAndRichLog（5）、tmuxClearTaskTabsClick（2）、executionCompactOverview（16）、executionHistoryControls（3）、planWorkerAndTmuxRouting（3）、workflowAutoScrollDisabled（3）、webviewButtonsHandled（1）、navigationPathConsistency（3）、actionLifecycle（9）、panelWebviewScriptHealth（1）、panelStateProjection（5）、panelRenderHealth（12）。命令均为 `node --test --test-force-exit --test-timeout 20000 <单个文件>`。
- `npm run package`：build/typecheck、运行时生成、语法检查、Panel 脚本健康测试、VSIX runtime closure 均通过。
- 显式 `vm.Script`：两个编译模块及实际 HTML 的两个脚本均通过。
- VSIX：198 个发布文件逐项 SHA256 对比通过，189 个运行模块闭包完整，不包含 `.pyc`。
- `npm run install:latest` 仅执行一次，VS Code 已安装 0.5.238。安装目录的 189 个运行模块与本地 SHA256 一致，buildId 为 `739879355724ae38cf5cabcde8aeb223206d7aad403aeba6d3cbb3b499fa1709`；`simpleex --help` 正常，CLI 链接指向当前仓库。
