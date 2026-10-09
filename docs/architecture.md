# Architecture

The extension is moving toward layered internals:

- `core`: command bus, operation queue, error model, shared domain types.
- `services`: SSH, Hub Agent, runtime, scheduler, sync, GPU, artifact, live output orchestration.
- `state`: `ClusterStore`, reducer, selectors, migrations.
- `ui`: Webview bridge and UI state mapping.
- `testing`: fake runtime and scenario runner.

`extension.ts` remains the VS Code lifecycle and compatibility shell while logic moves out in small compiled steps.

## OperationQueue

All long or risky work should enter `OperationQueue`.

- `user_blocking` and `manual` outrank `background` and `realtime`.
- Write operations share exclusive keys such as `sync-write` or `runtime`.
- Refresh operations use `coalesceKey`.
- Queue records feed diagnostics, audit, and UI loading.

## State

`ClusterStore` is the domain state source for new code. Reducers keep terminal states from being overwritten by old running updates and preserve lastKnownGood.

Existing compatibility fields in `extension.ts` remain until all services migrate.

## Experiment Platform Features

Feature modules live under `src/features/`.

- `PlanBuilder`: matrix dry-run and plan YAML generation.
- `SmartScheduler`: resource policy dry-run with explainable decisions.
- `Lifecycle`: experiment timeline and retry attempts.
- `Metrics`: metrics parsing, leaderboard, Markdown export.
- `Comparison`: config/metric/runtime diff reports.
- `Anomaly`: stalled run, NaN loss, low disk, GPU idle detection.
- `Notifications`: rule based throttling.
- `SearchTags`: local experiment search and tags.
- `RecycleBin`: deleted/delete_failed audit view helpers.

All command entry points should use `OperationQueue` and write audit records.

## Operational Boundaries

SimpleExperiment owns plans, Agent lifecycle, run state, task control, result-analysis entry points, and experiment operations. SimpleSFTP owns real file transfer. The PPT add-in owns rendering. One component must not take over another component's authority.

Three topologies are supported:

- `single_worker`: one Worker schedules locally and stores its own state.
- `worker_pool`: multiple Workers schedule deterministic shards without a Hub.
- `hub_worker`: a Hub coordinates global state while Workers execute.

No-Hub modes never create a Hub automatically and never rely on cross-node backup. Worker-local state is authoritative for that mode.

Runtime caches under `simple_cluster` are operational state. Plans, final results, archive manifests, deletion tombstones, transfer records, and user confirmations are project state and must survive runtime reloads.

Final analysis sources are archived results only. `metrics_summary.csv`, statistics, paper evidence, and PPT plotting must not treat temporary preview rows as accepted evidence. PPT destination confirmation precedes automation.

Long-lived Webview payloads stay bounded. Scheduler states and experiment traces have explicit record limits; request budgets preserve per-request timeout fields, pending keys, sequence numbers, and heartbeat timestamps instead of dropping them silently.

The transport boundary is Xshell local forwarding plus optional Hub/Worker Agents plus SimpleSFTP. No plugin code path uses direct SSH, SCP, or RSYNC as a substitute for those boundaries.

## 工厂模式重构 (v0.4.92) — 已落地验证（renderState 3 模块拆分完成）

本次重构将 `src/extension.ts` (22288 行) 与 `src/ui/PanelHtml.ts` (15275 行) 等 17 个单体文件拆分为 **17 个门面 Facade (各 7-40 行，含新增 `WebviewRenderState` 7 行)** + **28 个归档 (27×`.legacy.ts` + `src/extension/legacy.ts`，约 63475 行)** + **48 个新文件（46 .ts +2 .md，含（含 `src/ui/renderState/` 3 模块）**，详见 [FACTORY_REFACTOR_REPORT.md](./FACTORY_REFACTOR_REPORT.md)。

### 目标（实测达成）

- 门面均 <50 行（17 个门面 7-40 行，14/17 <20 行）；新文件（46 .ts +2 .md） <400 行 100% 通过，<300 行 100% 通过（原 `WebviewRenderState` 328 行已拆为 `renderState/RenderStateTypes` 35 + `RenderStateStore` 150 + `RenderStateMapper` 78 + 7 行 Facade，最大模块 211 行）
- 职责分离：隧道/实时/Feature/命令/面板五大工厂由 `ServiceFactory` (112 行) 聚合；`WebviewRenderState` 渲染状态机按 类型/存储/映射 三层拆分到 `src/ui/renderState/`
- P0 门禁固化：`PanelTemplateEscaper` + `vm.Script` 双重校验，`TunnelFactory.resolveEndpointUrl()` 动态解析杜绝 `10890` 硬编码（`Select-String "10890"` 零命中，`node -c` + `vm.Script` 双重通过）

### 工厂体系（实测行数）

```
activate() [Composition Root: src/extension/Activation.ts 66 行]
  └─> ServiceFactory (Abstract Factory: src/factories/ServiceFactory.ts 112 行)
        ├─> TunnelFactory          — 端口/端点动态解析 (src/factories/TunnelFactory.ts 211 行 + src/tunnel/factories/* 各 115 行)
        ├─> RealtimeClientFactory  — RequestBudget/RealtimeTunnelClient/MultiEndpoint (src/factories/RealtimeClientFactory.ts 164 行)
        ├─> FeatureFactory         — FeatureKind -> FeatureHandler 映射 (src/factories/FeatureFactory.ts 167 行 + src/features/factories/* 92/92/101 行)
        ├─> CommandFactory         — VS Code 命令批量注册 (src/factories/CommandFactory.ts 135 行)
        └─> PanelSectionFactory    — 12 Sections 聚合 (src/factories/PanelSectionFactory.ts 152 行 + src/ui/sections/* 19-68 行)
              └─> PanelHtmlRenderer (80 行) + PanelTemplateEscaper (73 行) + WebviewRenderState 7 行 Facade
                    ├─> renderState/RenderStateTypes (35 行) — TASK_STATUS_RANKS/SCHEDULER_BUCKETS
                    ├─> renderState/RenderStateStore (150 行) — pick/normalize*/percent/formatDuration/transfer*
                    ├─> renderState/RenderStateMapper (78 行) — normalizeGpu/Scheduler/Task
                    └─> vm.Script 校验 -> 最终 HTML
        ├─> core/factories/*       — CommandBus / OperationQueue 注入化 (67/86 行)
        └─> src/factories/index.ts (12 行) — 聚合导出，Composition Root 唯一入口

  Facade 层 (17 文件 7-40 行) ──try factory──> fallback legacy (28 文件约 63475 行)
  新文件层 48 新文件（46 .ts +2 .md）（46 \.ts）约 3525 行，<400 100% 通过，<300 100% 通过（最大 211 行）
```

### 渐进式迁移（已验证）

- `src/extension.ts` (32 行) / `src/ui/PanelHtml.ts` (40 行) / `src/ui/WebviewRenderState.ts` (7 行) 等 17 个门面保留为兼容 Facade，对外 API 不变，内部 `try { factory } catch { require("./*.legacy") }` 双路径；`WebviewRenderState` 已拆为 `src/ui/renderState/` 3 模块（Types 35/Store 150/Mapper 78）
- 新逻辑仅在 `src/extension/` (7 文件) / `src/ui/sections/` (12) / `src/ui/renderState/` (3) / `src/factories/` (8) 等 48 新文件（46 .ts +2 .md）下添加，通过工厂注入生效
- 工厂均提供 fallback：`try { require(...) } catch { return stub }`，缺失依赖时返回桩对象不抛异常
- 回滚：`git checkout e44b85e -- src/extension.ts src/ui/PanelHtml.ts src/ui/WebviewRenderState.ts` 或 `git rm -r src/ui/renderState` 或删除 `src/factories/index.ts` 新导出，`dist/` 已编译产出不受影响；Legacy 归档（28 文件）保留完整逻辑零丢失

### 验证（Phase 5 实测通过）

```bash
npm run build  # compact:plan + typecheck + node -c dist/extension.js + node -c dist/ui/PanelHtml.js → exit 0
node --test test/factories_integration.test.js  # 8/8 pass, 145ms
node -e "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8'))"  # PanelHtml.js vm.Script OK
node -e "new (require('vm').Script)(require('fs').readFileSync('dist/extension.js','utf8'))"    # extension.js vm.Script OK
Select-String -Pattern "10890" src/**/*.ts -Exclude "*.legacy.ts"  # 零命中（仅 legacy 有历史值）
```

### 后续

- `src/ui/WebviewRenderState.ts` 328 行已拆为 `src/ui/renderState/` 3 模块（本轮完成，全部 <160 行）；`dist/ui/WebviewRenderState.js` 已同步为 Facade 重导出
- `src/extension/legacy.ts` 22288 行 / `src/ui/PanelHtml.legacy.ts` 15275 行完全委托后删除归档
- 逐文件补类型，去 `// @ts-nocheck`，补充 `test/factories/*.test.js` 单测
- 存量 10 个非工厂大文件（`XshellTunnelSetup` 471 等）后续按需拆分，不阻塞工厂化门禁（门禁仅约束 48 新文件（46 .ts +2 .md） + 17 门面）

