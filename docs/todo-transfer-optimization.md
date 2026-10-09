# 传输与校验优化

基线：SimpleExperiment `988fc160` / 0.5.220，SimpleSFTP 0.2.48。保护两个原有 `.pyc`。仅修改插件源码及本地回归，不取消、重发或访问当前远端任务；不删除历史产物，不绕过 SHA256、运行身份、租约和路径确认。

## 证据与边界

上一轮只读采样：本地最新完整运行记录 17 个 Plan / 102 个 job / 5,400 个产物路径；旧 10 KiB 参数边界折成每 Worker 68 次、三 Worker 204 次查询。随后同步进入流处理，但旧进度混用控制输出、哈希及传输字节，最后 SIGTERM 的远端结果为 outcomeUnknown。当前不把这种状态推断为传输成功或允许自动重发。

本轮覆盖：产物、代码、映射下载、工作区上传的公共 SSH/流进度；跨 Worker 的有界清单/缓存及流处理。保持两路流和现有容量限制，避免提高并发和延长超时掩盖问题。

## TODO

- [x] 复现大清单的 SSH 调用放大、控制输出误计传输字节、压缩流仅在结束时报告 wire bytes。
- [x] 新版 SimpleSFTP 以 stdin 发送有界 scope（最多 5,000 路径 / 1 MiB），Host 按能力协商；旧版保留 128 路径 / 10 KiB 兼容路径。
- [x] 清单范围匹配、SQLite 缓存读取只处理本次 scope；稳定身份继续核对 dev/ino/size/mtime/ctime，变化重哈希。
- [x] 进度明确区分清单、hash、packing、transfer、unpack、verify；压缩/解压与哈希提供有界真实进度，控制 JSON 和心跳不冒充有效字节。
- [x] UI 通知细化 Worker / 批次 / 数量及耗时，失败仍保留具体阶段与结果不确定语义。
- [x] 逐文件串行完成校验、压缩、背压、上传、下载、取消/settlement、结果版本回归；build、vm.Script 门禁。
- [x] 差异审阅、两插件打包与逐文件 hash/identity 门禁；按项目规则以 scoped commit 普通推送 origin/master。现有任务未结束前不安装/重载扩展；真实长传输耗时留待用户后续观察。

## 验收记录

1. 对当前本机 MultiModal durable queue 只读重放：17 个最新完整 Plan / 102 completed job / 5,400 个精确路径，队列 2,460,581 bytes。旧边界每 Worker 68 批，新协商边界每 Worker 2 批；三 Worker 的同范围预校验由 204 批变为 6 批。这是实际路径的本地批次计算，没有访问服务器或测量真实网络耗时。5,400 路径生产方法 fixture 也实际只调用 inventory 两次。
2. Python 内容哈希回归：81 个文件冷缓存全部读取 SHA256；暖缓存复用 81 个且 batch digestReads=0；修改 1 个文件后只重读 1 个、复用 80 个。mtime 被恢复、ctime-only 变化仍使摘要失效。120 文件缓存中仅查询 2 个及 1 个缺失路径时，cacheRows=2；空 scope 保持真实空范围，不扫描全项目。
3. 真实 Python pipe 回归在 stdin 保持打开时写入 100 bytes，EOF 前已完整转发并收到 wire=100。控制 JSON、非法负数/非安全整数遥测、哈希字节不能计入 wire；两条并行流 100+50=150，同一 relay 重复观察只算一次。receiver probe 校验解包字节、文件数与发布文件数，错误内容不替换最终文件。
4. 未变更的 artifact/publication patch 返回当前工作副本；在带租约的新磁盘读取之后跳过原子写入。20 轮 / 40 次重复确认新增 rename=0；外部业务状态仍能进入 display snapshot，真正更新、代次取消和 EPERM 保留原保护。未更换队列路径、未删除旧产物。
5. 串行目标回归：SimpleExperiment 30 文件 / 288 用例；SimpleSFTP 全部 29 测试文件 / 151 用例；主插件 build 内联 Webview script 1 用例。全部通过，共 440 用例，独立 vm.Script 无异常。新增 signature 的两个源码提取 fixture 已同步参数，未删除断言。SFTP build 首次 vsce ls 达 8 秒边界；独立检查 1.5 秒完成，随后原 build 和 package 原样通过，未修改门槛。
6. 版本交付：SimpleExperiment 0.5.221（187 runtime 哈希/身份）与 SimpleSFTP 0.2.49（16 runtime 哈希/身份）已通过只读归档门禁。SimpleSFTP 提交 `30831c1` 已普通推送并 fetch 核对 HEAD=origin/master；主插件提交身份以包含本文件的同批 Git 记录为准。两个原有 dirty `.pyc` 保留，不提交。当前安装版本与正在运行的任务未操作；安装和真实长传输测试推迟到任务结束。

## 实现依据

复用既有 SSH stdin、tar 流、gzip/pigz/zstd、Python SHA256、SQLite 和 Node pipe 背压，无新增强制工具依赖；只读压缩收益采样和断点内容验证继续沿用。准确性由文件身份、内容摘要、运行世代和完整发布共同约束；加速靠避免全历史缓存加载、重复读取、逐 job SSH、重复写盘和逐文件遥测。

- [Python buffered read1](https://docs.python.org/3/library/io.html#io.BufferedReader.read1)：短 pipe 可读取当前可用数据，持续转发无需等待 EOF。
- [SQLite limits](https://www.sqlite.org/limits.html)：范围缓存查询每批 512 路径及 root 参数，兼容旧 999 参数上限。
- [Node stream backpressure](https://nodejs.org/api/stream.html)：保持有界 pipe/drain；提高批量元数据容量不等于提高并发或无界缓冲。
