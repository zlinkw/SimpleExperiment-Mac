# Mac preview 本机发布与验收

支持 Apple Silicon、macOS 26 及以上。两插件共享 SimpleExperiment-Mac 的 GitHub Release，只有 preview 通道。

## 发布

1. 修改与验证分批完成后，两仓分别提交并普通推送至 origin/master。两个工作区必须干净，不能存在未审查文件或 Actions workflow。
2. 在 SimpleExperiment-Mac 执行 `npm run release:prepare`。默认配套目录为 `../SimpleSFTP-Mac`，也可设置 `SIMPLE_SFTP_MAC_SOURCE`。脚本执行本地构建、目标测试串行、闭包与脚本校验，再打包 darwin-arm64 与生成 release.json。
   主题门禁使用本机 Chromium 无界面渲染浅色、深色及高对比主题，检测文字/背景对比。默认检测本机 Chrome 路径；其他位置可设置 `SIMPLE_MAC_THEME_BROWSER` 为已有 Chromium 可执行文件。不会启动可见浏览器或安装浏览器，缺少测试环境时 prepare 失败。
3. 在同一提交执行 `npm run release:publish`。需要发布者的 gh 登录。脚本创建 draft，上传两个 VSIX 与清单，核验附件完整集合、大小及 GitHub SHA-256 后发布 prerelease。测试用户公开下载不需要登录。
4. 产物和发布回执保留在 `release-artifacts/preview-v<版本>/`，不提交。prepare 禁止复用已有版本目录。发布过的 tag/资产不覆盖，修复必须递增版本。失败的 draft 只允许凭本地回执恢复，并逐项核验已上传资产；未识别的 draft 保留供人工检查。

两个命令不安装开发机扩展，不触发 Actions，不清理历史附件。构建检查在开发机执行；发布说明中的“本地验证”不代表 M5 上的 Extension Host 或实际网络安装验收。

## 首次安装与更新验收

从第一个 preview Release 依次下载安装 SimpleSFTP Mac、SimpleExperiment Mac。安装后重载 VS Code。独立入口“检查 preview 配套更新”不依赖服务器、Termius 或业务面板。

第一版装好后，发布更高版本的第二版。在 M5、24 GB、macOS 27.0 验证一次完整插件内更新，核对两个版本、设置保留、重载后功能。清单中两仓 sourceCommit 必须对应 origin/master 已同步提交。

## 验收状态

- 本地验证：更新协议、预发布筛选、错误源与限流、平台/hash/损坏包拒绝、重复点击、部分安装回执与补装、租约与本地传输等待有目标测试。每次 prepare 会重新执行门禁。
- M5 真机验证：尚未执行。不得把 mock 安装测试写成真实 VS Code 安装通过。
- 科研业务：仍在 mac 适配。Termius 隧道、密钥/ssh-agent/密码/私钥口令、中文和空格路径、断连恢复、三拓扑主流程需要后续本地与真机证据。

更新源不可达或限流显示“检查失败”，不会显示“已是最新”。更新期间新业务操作被阻止；已有本地传输和子进程退出证明完成后才安装，远端实验不会被更新流程停止。

GitHub 发布附件与 Actions 额度分别管理，发布附件规则参见 [GitHub Releases 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。
