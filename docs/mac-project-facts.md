# Mac 项目事实

- 本仓库从已提交的 SimpleExperiment 源码 `8934ed8b80fe96981a0f8deb1c0481039e9c1568` 初始化。原项目工作区的未提交 Python 缓存没有复制。
- 配套仓库从 SimpleSFTP 提交 `d2b7d20f0d5649c783f4f9d15bc5d9427bee6b13` 初始化。
- 目标仓库为公开的 `zlinkw/SimpleExperiment-Mac`、`zlinkw/SimpleSFTP-Mac`，分支均为 `master`。Windows 源项目保持独立。
- 本地开发设备为 Windows；支持目标为 Apple Silicon、macOS 26 及以上。用户2026-10-11提供M5、24 GB、macOS 27.0、VS Code 1.141的部分真机报告，验收版本.309/.97；最小启动/更新入口与检查恢复通过，在线安装/三拓扑完整科研仍待验。不能用本地测试替代真机，详见`mac-native-acceptance-2026-10-11.md`。
- 首版仅 preview。两组件与 release.json 放在 SimpleExperiment-Mac 同一个 GitHub Release。无需 GitHub Actions，不接入 zlinkw.shop。
- 三种拓扑及实验 Plan 和业务 API 契约保持兼容。PPT 自动绘图、Dev Containers、Intel Mac 不属于首版验收。
- 完整复制的旧源码和文档仅是迁移基线，旧安装、发布、更新源和 Windows 说明不能作为 Mac 交付指令。正式发布只使用新的 release:prepare / release:publish。

- 首版发布版本为 Experiment 0.5.264、SFTP 0.2.62，沿源版本递增，保持科研项目最低版本契约及已有 Agent 版本方向。初始化时的 0.1.1 从未发布。
- 当前配套公开版为[preview-v0.5.313](https://github.com/zlinkw/SimpleExperiment-Mac/releases/tag/preview-v0.5.313)：Experiment 0.5.313、SFTP 0.2.100，源码分别绑定`1be91b4248518c32d06c667b3c73c8b8d5c4b28c`与`2d5d5aced0a49621d84e5a9f00d65b22c053f2f3`。参考Windows分叉后17个提交及SFTP配套历史，功能页与方法见`windows-sync-2026-10-12.md`。本地127个目标文件（含build面板标记128）、实际VSIX消费者200项、1588/87源码快照及匿名四请求/REST0校验通过；234/28依赖闭包及面板vm通过。新增行为尚待M5，18已验证11剩余；完整目标保持paused。旧.311等产物全部保留。发布未触碰任何现有远端任务或Agent。
