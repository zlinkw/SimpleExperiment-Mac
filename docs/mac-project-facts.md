# Mac 项目事实

- 本仓库从已提交的 SimpleExperiment 源码 `8934ed8b80fe96981a0f8deb1c0481039e9c1568` 初始化。原项目工作区的未提交 Python 缓存没有复制。
- 配套仓库从 SimpleSFTP 提交 `d2b7d20f0d5649c783f4f9d15bc5d9427bee6b13` 初始化。
- 目标仓库为公开的 `zlinkw/SimpleExperiment-Mac`、`zlinkw/SimpleSFTP-Mac`，分支均为 `master`。Windows 源项目保持独立。
- 本地开发设备为 Windows；支持目标为 Apple Silicon、macOS 26 及以上。M5、24 GB、macOS 27.0 真机验收尚未执行，不能用本地测试替代。
- 首版仅 preview。两组件与 release.json 放在 SimpleExperiment-Mac 同一个 GitHub Release。无需 GitHub Actions，不接入 zlinkw.shop。
- 三种拓扑及实验 Plan 和业务 API 契约保持兼容。PPT 自动绘图、Dev Containers、Intel Mac 不属于首版验收。
- 完整复制的旧源码和文档仅是迁移基线，旧安装、发布、更新源和 Windows 说明不能作为 Mac 交付指令。正式发布只使用新的 release:prepare / release:publish。
