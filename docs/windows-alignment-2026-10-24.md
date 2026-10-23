# Mac 085 同步与验收边界

本轮候选为 Experiment Mac 0.5.316 与 SimpleSFTP Mac 0.2.103。Windows 业务权威固定为 Experiment 0.5.403（c30d607f1b63d224e8a65ab94371d86b4dd81c0d）与 SimpleSFTP 0.2.107（fc962236210ca692397dd58eefbefd0bf108f85a）。

同步范围包含机器级 GPU 单源采集、请求绑定准入、项目/程序/机器状态/产物四根保护、独立隔离重跑审核与批次账本、精确 busy 拒绝和系统 Python 查找。保留 Mac 独立身份、preview 静态索引、POSIX 大小写与合法尾空格、独立认证、系统 OpenSSH、Termius 手动备用、共享更新租约和 Darwin 句柄证明。

原两仓未提交成果已逐文件冻结并保留在原目录。主会话接手后的修改位于独立 fix/mac-sync-085 工作树。原始 Windows 四树、三方冲突、所有历史失败与返修证据保留在外部 .mac-align-085 目录；430 项旧指纹不替代新候选验收。当前源码指纹记录见 scripts/windows-source-baseline.json，指纹只证明字节关系。

最终测试域由原 180 项发布门禁、新增及修改测试的反向影响、SimpleSFTP 全部套件组成，共 483 个唯一文件。原执行入口与新增清单 scripts/mac-release-regressions.json 共用同一执行函数，逐文件串行，Node 20 秒、Python 子进程 10 秒。Windows 必验在真实 Windows 执行；浏览器主题与收包在宿主验收；其他运行时仅隔离替身。最终验收尚未完成，不以历史通过、宽限探针或 skip 宣称本版通过。

冷构建无需忽略目录中的旧模板；缺失 checksum 从当前编译字节生成。运行入口直接使用已跟踪的模板函数，用户 Markdown 只生成最小证据模板或在线指南链接；发行包仅保留运行闭包、资源、法律通知和工具链强制根 README。

M5、OpenSSH 和 libproc 的 macOS 真机验收尚未执行；Linux 和 Windows 替身不能证明真机体验。全程禁止业务服务器连接、真实训练/传输/清理、远端部署和开发机安装；原完整目标保持 paused。必需门禁和实际归档全部通过后才发布原配套 preview。
