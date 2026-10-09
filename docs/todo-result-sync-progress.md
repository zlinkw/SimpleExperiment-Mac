# 结果同步阶段与清单收口

基线：SimpleExperiment 0.5.221，SimpleSFTP 0.2.49。保留两个原有 dirty `.pyc`。不取消当前同步，不重发未知请求，不修改历史产物或并发保护。

## 现场证据

2026-10-05 的当前 API 已核对为 0.5.221 / 0.2.49。通知显示上一批 306/306 路径、本批 1 秒时，SimpleSFTP 仍有 `sync.projectInventory` 正在 hashing，已处理 4,239 文件 / 3,340,776,703 bytes；用户随后确认等待后进入后续阶段。因此不能将该通知判定为死锁，也不能将“本批 1 秒”解释为整次同步耗时。

另有前两代实例遗留的两个 SIGTERM outcomeUnknown 回执，当前请求随后仍记录此保护错误。这些回执没有远端退出证明，本轮不清除或假装成功；此问题与通知阶段滞后分开验收。

## TODO

- [x] 回归复现：清单批完成后，目录发现/重建等待的通知仍停留上一批；SSE/轮询未将真实进度转发给调用方。新增两项集成回归失败，20 个 job 的旧实现实际查询 64 次；真实事件回调回归同样失败。
- [x] 以当前 operationId 绑定的有界进度回调转发真实阶段、文件数、处理字节和步骤耗时；停止后不再通知，通知异常不影响传输。SSE 不可用时已有 500 ms 轮询也可转发，不增加轮询或写盘。
- [x] 重建预览、发现目录、记录镜像、传输与复核明确切换阶段，不把本批耗时显示成整体耗时。实际传输字节与处理字节分别展示，并显示总耗时。
- [x] 缺少 bulk 清单的最新 attempt 目录纳入请求级批量 inventory；保留同一运行、内容摘要、范围完整性和传输后重新核验，避免按 job 重复打开 SSH。20 job / 100 文件 fixture 从 64 次降到 4 次清单查询（含传输后新鲜核验）；禁止跨请求复用或接收 sibling attempt 路径。
- [x] 串行目标回归、build、Webview vm.Script、打包哈希门禁。21 个目标文件 / 177 用例通过；build 内联 Webview 1 用例通过，合计 178；独立 vm.Script 无异常，0.5.222 VSIX 的 187 runtime 文件逐项 SHA256 与身份一致。
- [x] 自动安装 SimpleExperiment 0.5.222 并核对 installed version 与 simpleex 入口；SimpleSFTP 维持 0.2.49。安装前 API 显示 activeTransfers=0、liveChildren=0、unknownOperations=2。安装后未再操作旧 Extension Host；实际效果需 Reload Window 后复测。
- [x] 差异与提交范围已审查，master 跟踪 origin/master 且提交前 fetch 显示二者同为 28ca7cf。交付须普通推送并再次核对；本轮提交身份由包含本文件的同批 Git 记录确定。两个原有 dirty `.pyc` 不提交。

## 验收边界

真实数据仅描述本次只读采样。网络传输耗时、最终服务器完整同步和遗留未知回执恢复不能用 fixture 代替。保留严格的退出回执及 active guard，不提高超时，不改变 payload/heartbeat。
