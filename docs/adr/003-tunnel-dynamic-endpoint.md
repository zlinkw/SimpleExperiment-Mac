# ADR 003 — 隧道按每服务器用户配置动态解析（P0）

状态：已采纳（P0 强约束）  日期：2026-09-01  关联：AGENTS.md P0、docs/troubleshooting.md#禁止硬编码隧道端口-P0

## 背景
Xshell/SSH 隧道由用户为每台服务器独立配置（`*.xsh` 会话、`~/.ssh/config`、`settings.json` per-server `host/port/forward`），不存在全集群固定端口。历史上业务逻辑曾硬编码 `10890` 检测与 `127.0.0.1:18765` 作为唯一 Agent 地址，导致：
- 自定义端口的用户隧道不可用
- `校验 Agent 版本` 点击无反应（`worker_telemetry` 模式下 `/health` vs `/api/health` 路径不一致，前端无回调）
- GPU tmux 无法打开、job 调度静默失败（`ModuleNotFoundError: torch` 未回传到 UI）

## 决策
1. 禁止在 `src/**`/`dist/**` 业务逻辑中硬编码 `10890` 或固定 `127.0.0.1:18765` 探测；仅允许在 `docs/`/`AGENTS.md` 约束说明中出现。
2. 所有探活/校验/版本比对必须读取 `XshellRealtimeTunnelConfig`/`TunnelEndpointPortAssignment`/`TunnelEndpointConfig` 的 `localForwardHost/localForwardPort` 与 `remoteAgentHost/remoteAgentPort`，动态拼装 `baseUrl = http://${host}:${port}`。
3. `TunnelGateway.localBaseUrl`、`XshellTunnelPortProbe` 的 `base` 与 `tcpOpen` 必须用 `resolveProbeHost(config)` 动态 host；健康探测走 `fetchHealthWithFallback`（依次尝试 `/api/health` → `/health` → `/api/version`）。
4. Agent 侧兼容：`/health` 与 `/api/health`（以及 `/version`/`/api/version`）互为别名；`worker_telemetry` 模式的路由白名单必须放行健康与版本接口，避免前端 404 无回调。
5. 默认值可保留 `127.0.0.1:18765` 做兼容，但校验逻辑不得 `throw` 限制只能 `127.0.0.1`；展示层端口输入框以用户配置为准。

## 后果
- 正面：多服务器、多隧道端口场景下校验与观测链路可达；tmux live tail（`capture-pane -p`、`live_output/*.json`）经 Xshell 隧道同步到插件 UI；失败原因（`stderr.log`/`exit_code`/`snapshot`）可视。
- 负面：配置校验更宽松，需依赖 UI 提示而非硬编码拦截来引导用户修正 host/port。

## 门禁
- `Select-String -Pattern "10890" src/** dist/**` 零命中（业务逻辑）
- `npm run build`（含 `node -c dist/extension.js && node -c dist/ui/PanelHtml.js`）与 `vm.Script` 双重校验通过
- `worker_telemetry` 模式下 `GET /health` 与 `GET /api/health` 均返回 200

## 关联代码
- `src/tunnel/TunnelGateway.ts`（`normalizeHost`/`localBaseUrl`/`assertLocalhost` 解锁）
- `src/tunnel/XshellTunnelSetup.ts`（动态 `localForwardHost`/`remoteAgentHost`，校验解锁）
- `src/tunnel/XshellTunnelPortProbe.ts`（`resolveProbeBase`/`fetchHealthWithFallback`/`tcpOpen(host)`）
- `src/extension.ts`（`resolveAgentBase` + 兼容降级）
- `src/clusterAgentRuntime.ts` / `dist/runtime/cluster_agent.py`（健康别名 + 白名单）
- `docs/troubleshooting.md#禁止硬编码隧道端口-P0`
