# Xshell 隧道全功能手动验收

本清单用于确认插件只通过 `127.0.0.1:<localForwardPort>` 访问 Hub Agent，不直接连接 Hub 或 Worker。

## 前置条件

- 已安装 Xshell。
- Hub 和需要直连的 Worker 已配置 `.xsh` 本地隧道会话。
- Hub 上已启动 Agent：

```bash
python simple_cluster/runtime/cluster_agent.py serve --host 127.0.0.1 --port 18765 --mode realtime
```

## 验收步骤

1. 配置 Xshell
   - 操作：在插件中运行“配置 Xshell 会话文件”，优先选择已保存的 `.xsh` 会话；没有合适条目时填写 `Xshell.exe`、服务器 IP/域名、登录用户名、SSH 端口号、本地端口、服务器上的 Agent 端口。
   - 预期结果：命令预览显示 `127.0.0.1:<localForwardPort>:127.0.0.1:<remoteAgentPort>`。
   - 相关 API：无。
   - 失败检查：确认 exe 路径、端口范围、服务器 IP/域名、登录用户名、Xshell 登录别名。

2. 启动隧道并检测
   - 操作：点击“启动 Xshell”，确认命令预览后运行“检测隧道”。
   - 预期结果：本地端口打开，`/api/health` 正常，`/api/capabilities` 正常。
   - 相关 API：`GET /api/health`、`GET /api/capabilities`。
   - 失败检查：确认 Xshell 会话是否显示认证错误，Hub Agent 是否启动，token 是否正确。

3. 实时 GPU 和 scheduler
   - 操作：运行“重启实时流”，观察 GPU 和 scheduler 状态。
   - 预期结果：WebSocket 或 SSE 事件更新 UI；断开后降级 snapshot，不触发 SSH。
   - 相关 API：`WS /api/events`、`GET /api/events/sse`、`GET /api/snapshot`。
   - 失败检查：查看 capabilities 中 realtime 能力。

4. 运行和停止实验
   - 操作：触发 run plan，再触发 stop experiment。
   - 预期结果：UI 绑定 operationId，进度来自 Hub Agent 事件。
   - 相关 API：`POST /api/actions/run-plan`、`POST /api/actions/stop-experiment`。
   - 失败检查：确认 actions capability 可用。

5. 结果解析与下载 CSV
   - 操作：运行 parse results，下载结果 CSV。
   - 预期结果：解析完成事件到达，CSV 通过文件 API 下载。
   - 相关 API：`POST /api/actions/parse-results`、`GET /api/files/download`。
   - 失败检查：确认 safe path 在 `results` 或 `experiments` 下。

6. 上传 preset
   - 操作：上传一个 JSON preset。
   - 预期结果：chunk upload 完成，sha256 校验通过。
   - 相关 API：`POST /api/files/upload-init`、`POST /api/files/upload-chunk`、`POST /api/files/upload-complete`。
   - 失败检查：确认文件大小、safe path、覆盖策略。

7. 归档、同步、删除
   - 操作：分别触发 archive、sync、delete。
   - 预期结果：插件只发送 action request，实际文件处理由 Hub Agent 完成。
   - 相关 API：`POST /api/actions/archive-artifacts`、`POST /api/actions/sync-artifacts`、`POST /api/actions/delete-artifacts`。
   - 失败检查：查看 Hub Agent audit 和 diagnostics。

8. 自检和 debug bundle
   - 操作：运行 self-check，生成并下载 debug bundle。
   - 预期结果：诊断信息不包含 token、密码、passphrase、私钥全路径。
   - 相关 API：`POST /api/actions/self-check`、`POST /api/actions/create-debug-bundle`、`GET /api/files/download`。
   - 失败检查：Agent 版本过旧时升级 Hub Agent。

9. 质量门禁、统计、论文表格、case-level 分析
   - 操作：依次触发 quality gate、statistics、paper table、case analysis。
   - 预期结果：按钮按 capability 启用；缺失接口时显示“需要升级 Hub Agent”。
   - 相关 API：`POST /api/actions/run-quality-gate`、`POST /api/actions/run-statistics`、`POST /api/actions/export-paper-table`、`POST /api/actions/parse-case-level`。
   - 失败检查：确认 `/api/capabilities` 中对应 action 为 true。

10. 离线导入
    - 操作：关闭 Xshell 隧道，导入 offline bundle。
    - 预期结果：插件不访问网络，离线结果仍可查看。
    - 相关 API：无。
    - 失败检查：确认 bundle JSON 格式。

11. 关闭 Xshell 后确认无回退
    - 操作：关闭隧道后运行检测和手动刷新。
    - 预期结果：只提示修复 Xshell 本地隧道或使用离线导入，不出现 direct SSH fallback。
    - 相关 API：仅尝试 `127.0.0.1:<localForwardPort>`。
    - 失败检查：运行 `npm run test:no-direct-ssh` 和 `npm run test:tunnel-migration`。
