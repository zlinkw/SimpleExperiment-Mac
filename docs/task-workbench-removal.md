# 遗留全局任务工作台移除

范围：legacy 与 factory 运行监控、提交导航、相关测试和产品说明。
保护：两个既有 pyc 修改、实验记录 scope 与共享详情样式、重复提交保护。

- [x] 读取约束与 Git 状态。
- [x] 移除全局任务 DOM、scope、详情渲染及专属样式。
- [x] 保留 Plan 任务操作与批量选择，提供 Plan 内超过 20 条任务的入口。
- [x] 更新并逐项执行回归测试，包含真实 Plan 渲染的 25 任务状态。
- [x] build、Webview 脚本验证、版本打包安装；VS Code 与 simpleex 均核对为 0.5.187。
- [x] 审查 diff 与上游状态；仅本轮文件进入提交范围。

验证：6 个 features 目标文件及 taskCompact、operationControlsScope、webviewStateShape、taskActionLayout、resourceAnchorResolution、planSelectorStatus 均逐文件通过。修复测试中已有的选择器 sandbox 依赖与过时产品文案断言。生产源码遗留全局任务契约搜索零命中。build 与额外 vm.Script 已通过，版本提升为 0.5.187。

额外回归：traceRowsForPlanScopeCache 与 experimentTraceBudget 通过；taskSelectionDerivedCache 原有字符长度断言不覆盖完整日志选择分支，改为精确分支断言。90 任务状态验证末尾任务状态及日志变化会刷新签名。legacy 与 factory 开关的实际 HTML 和内嵌脚本检查通过。安装后请用户自行重载窗口做真实 Worker 手工验收。
