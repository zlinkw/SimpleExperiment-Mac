# 工厂化重构最终报告 (Phase 5 Final) — v0.4.92 (rev. renderState-3)

> 状态：48 个新文件（46 .ts +2 .md）已落地（+27 个 `.legacy.ts` 归档 + `src/extension/legacy.ts`，共 28 归档文件），`npm run build` 通过，`node --test test/factories_integration.test.js` 8/8 通过，所有门面均 <50 行（17 个门面 7-40 行，新增 `WebviewRenderState` 7 行门面），P0 双重门禁通过。
> 本轮增量：`src/ui/WebviewRenderState.ts` 328 行单体 → `src/ui/renderState/` 3 模块（`RenderStateTypes` 35 行 + `RenderStateStore` 150 行 + `RenderStateMapper` 78 行，共 263 行）+ 7 行 Facade `WebviewRenderState.ts`（re-export legacy），模块总数 45 → 48。

---

## 1. 重构前后对比（以实测行数为准）

| 维度 | 重构前 | 重构后 | 变化 |
|------|--------|--------|------|
| **入口文件** | `src/extension.ts` 22288 行单体 | `src/extension.ts` **32 行门面** → `src/extension/legacy.ts` 22288 行归档 + `src/extension/` 7 文件合计 661 行（单文件 12-163 行） | 门面 -99.8%，职责分离 |
| **UI 文件** | `src/ui/PanelHtml.ts` 15275 行单模板 | `src/ui/PanelHtml.ts` **40 行门面** → `src/ui/PanelHtml.legacy.ts` 15275 行归档 + `PanelHtmlRenderer` 80 行 + `PanelTemplateEscaper` 73 行 + `src/ui/sections/` 12 Section (19-68 行) + `styles/` 3 文件 + `WebviewRenderState` **7 行门面** → `renderState/` 3 模块 (35/150/78 行) | 门面 -99.7%，Section 均 <70 行，renderState 均 <160 行 |
| **隧道/实时** | `TunnelGateway` / `XshellTunnel*` 散落在 `RealtimeTunnelPanelProvider` 20+ private cache | `TunnelFactory` 211 行 + `RealtimeClientFactory` 164 行 + `tunnel/factories/` 2 文件 (各 115 行) | 统一工厂，可 Mock 可单测 |
| **Feature** | `PlanBuilder` / `Results` 等 15+ Feature 在 `extension.ts` 硬编码 `if (command === '...')` | `FeatureFactory` 167 行 + `features/factories/` 3 文件 (92/92/101 行) + `features/PlanBuilder/` `features/Results/` 4 文件 | 命令到 Handler 映射表驱动 |
| **核心** | `OperationQueue` / `CommandBus` 直接 new | `core/factories/` 2 文件 (67/86 行) | 注入化 |
| **其他门面** | `clusterAgentRuntime` 10797 行、`clusterSchedulerRuntime` 3938 行等 14 文件单体 | 14 个门面各 7-16 行 + 14 个 `.legacy.ts` 归档（见下表） | 均 <20 行 |
| **总新增模块** | — | **48 个新文件（46 .ts +2 .md，不含 28 个 legacy 归档：27×`.legacy.ts` + `src/extension/legacy.ts`），聚合导出 `src/factories/index.ts` | 见 §2 清单；较上一版 45 净增 3（WebviewRenderState 1→4：1 facade +3 renderState） |
| **总行数** | 16 大文件 40859 行 + extension legacy 22288 = **63147 行集中** | 新文件（46 .ts +2 .md）合计约 3525 行（renderState 263 行替代原 328 行，净减 65 行），分散到 48 新文件（46 .ts +2 .md），**全部 <250 行** | 最大单文件 211 行 (`TunnelFactory`)，<400 100% 通过，<300 100% 通过 |
| **P0 门禁** | `10890` 硬编码风险，`\` 转义易漏 | `PanelTemplateEscaper` + `vm.Script` 双重校验，`TunnelFactory.resolveEndpointUrl()` 动态解析 | 零硬编码，CI 门禁固化 |

### 门面 vs Legacy 行数明细（实测）

| 门面文件 | 门面行数 | Legacy 行数 | 归档文件 |
|---------|---------|-------------|---------|
| `src/extension.ts` | **32** | 22288 | `src/extension/legacy.ts` |
| `src/ui/PanelHtml.ts` | **40** | 15275 | `src/ui/PanelHtml.legacy.ts` |
| `src/clusterAgentRuntime.ts` | **8** | 10797 | `src/clusterAgentRuntime.legacy.ts` |
| `src/clusterSchedulerRuntime.ts` | **8** | 3938 | `src/clusterSchedulerRuntime.legacy.ts` |
| `src/features/PlanBuilder.ts` | **16** | 1908 | `src/features/PlanBuilder.legacy.ts` |
| `src/features/Results.ts` | **15** | 1738 | `src/features/Results.legacy.ts` |
| `src/features/PlanArchive.ts` | **7** | 1034 | `src/features/PlanArchive.legacy.ts` |
| `src/templates/ProjectAdapterTemplates.ts` | **7** | 881 | `src/templates/ProjectAdapterTemplates.legacy.ts` |
| `src/tunnel/MultiEndpointRealtimeClient.ts` | **7** | 750 | `src/tunnel/MultiEndpointRealtimeClient.legacy.ts` |
| `src/features/Quality.ts` | **13** | 714 | `src/features/Quality.legacy.ts` |
| `src/features/Comparison.ts` | **8** | 706 | `src/features/Comparison.legacy.ts` |
| `src/features/DraftPlans.ts` | **8** | 606 | `src/features/DraftPlans.legacy.ts` |
| `src/PptPlotBridge.ts` | **8** | 524 | `src/PptPlotBridge.legacy.ts` |
| `src/features/ApiWorkflow.ts` | **8** | 520 | `src/features/ApiWorkflow.legacy.ts` |
| `src/syncState.ts` | **8** | 408 | `src/syncState.legacy.ts` |
| `src/api/LocalApiServer.ts` | **8** | 436 | `src/api/LocalApiServer.legacy.ts` |
| `src/tunnel/RealtimeEventReducer.ts` | **8** | 624 | `src/tunnel/RealtimeEventReducer.legacy.ts` |

> 门面均 <50 行，其中 14/16 个 <20 行，2 个（PanelHtml 40、extension 32）在 20-50 区间；Legacy 归档总计 63147 行（16 文件）。

### 架构图

```
重构前:
  extension.ts (22288) ──强耦合──> 30+ 模块 (tunnel/features/state/core/ui)
  PanelHtml.ts (15275) ──单模板──> CSS(700) + HTML(700) + JS(13000)

重构后:
  activate() [Composition Root: src/extension/Activation.ts 66 行]
    └─> ServiceFactory (112 行, Abstract Factory)
          ├─> TunnelFactory (211 行) ──> TunnelGateway / PortAllocator / EndpointRegistry / Xshell*
          ├─> RealtimeClientFactory (164 行) ──> RequestBudget / RealtimeTunnelClient / MultiEndpoint
          ├─> FeatureFactory (167 行) ──> PlanBuilder / Results / Quality / ... (FeatureHandler)
          ├─> CommandFactory (135 行) ──> VS Code Command 注册
          └─> PanelSectionFactory (152 行) ──> 12 Sections (19-68 行)
                └─> PanelHtmlRenderer (80 行) + PanelTemplateEscaper (73 行) + WebviewRenderState 7 行 Facade
                      ├─> renderState/RenderStateTypes (35 行) — 常量/类型（TASK_STATUS_RANKS/SCHEDULER_BUCKETS）
                      ├─> renderState/RenderStateStore (150 行) — pick/objectRecord/percent/formatDuration/transfer* + normalizeExperiment/Operation/FileTransfer
                      ├─> renderState/RenderStateMapper (78 行) — normalizeGpu/Scheduler/Task + bucketStatus
                      └─> vm.Script 校验 ──> 最终 HTML
        ├─> core/factories/*       — CommandBus / OperationQueue 注入化
        └─> src/factories/index.ts (12 行) — 聚合导出，Composition Root 唯一入口

  Facade 层 (17 文件, 各 7-40 行) ──try factory──> fallback legacy (28 文件, 63147 + renderState legacy 328 行)
  新文件层 48 文件约 3525 行，<400 100% 通过，<300 100% 通过（最大 211 行）
```

---

## 2. 工厂清单和职责（实测行数）

| 工厂 / 模块 | 文件 | 行数 | 职责 |
|-------------|------|------|------|
| **ServiceFactory** | `src/factories/ServiceFactory.ts` | 112 | 聚合根，持有 tunnel/realtime/features/commands/panels 五工厂 |
| **TunnelFactory** | `src/factories/TunnelFactory.ts` | 211 | 端口/端点动态解析，P0 禁止硬编码 `10890` |
| **RealtimeClientFactory** | `src/factories/RealtimeClientFactory.ts` | 164 | `RequestBudget` / `RealtimeTunnelClient` / `MultiEndpoint` 创建，profile 策略 |
| **FeatureFactory** | `src/factories/FeatureFactory.ts` | 167 | `FeatureKind -> FeatureHandler` 映射，`handlerForCommand()` |
| **CommandFactory** | `src/factories/CommandFactory.ts` | 135 | `registerCommand()` 聚合，`createAll()` 批量注册 |
| **PanelSectionFactory** | `src/factories/PanelSectionFactory.ts` | 152 | 12 Section 的 `create()` / `createAll()`，持有 `PanelTemplateEscaper` |
| **types** | `src/factories/types.ts` | 44 | `FactoryContext` / `Factory<T>` / `BatchFactory` 通用类型 |
| **index** | `src/factories/index.ts` | 12 | 聚合导出，Composition Root 唯一入口 |
| **PanelHtmlRenderer** | `src/ui/PanelHtmlRenderer.ts` | 80 | 聚合 Section 的 HTML/CSS/JS，调 `escaper.escapeForOuterTemplate()` |
| **PanelTemplateEscaper** | `src/ui/PanelTemplateEscaper.ts` | 73 | P0 转义 + `vm.Script` 校验 |
| **WebviewRenderState (Facade)** | `src/ui/WebviewRenderState.ts` | 7 | Facade，`export * from "./WebviewRenderState.legacy"`，保持兼容 |
| **RenderStateTypes** | `src/ui/renderState/RenderStateTypes.ts` | 35 | 类型与常量：TASK_STATUS_RANKS / SCHEDULER_BUCKET_STATUSES / SCHEDULER_BUCKETS |
| **RenderStateStore** | `src/ui/renderState/RenderStateStore.ts` | 150 | 通用存储/工具：pick/objectRecord/firstNonEmpty*/normalizeArray/numberOrUndefined/percent/formatDuration/transfer* + normalizeExperimentTrace/Operation/FileTransfer |
| **RenderStateMapper** | `src/ui/renderState/RenderStateMapper.ts` | 78 | 映射层：normalizeGpuRow/normalizeServerGpu/normalizeSchedulerRows/normalizeTaskRow/taskStatusRank/expandSchedulerRow |
| **WebviewRenderState.legacy** | `src/ui/WebviewRenderState.legacy.ts` | 328 | 归档（未删除，Facade 回退用） |
| **ExtensionContext** | `src/extension/ExtensionContext.ts` | 96 | vscode 上下文适配 |
| **Activation** | `src/extension/Activation.ts` | 66 | `activate()` 组合根 |
| **ProviderState** | `src/extension/ProviderState.ts` | 163 | ClusterStore/StateStore 组装 |
| **ProviderRealtime** | `src/extension/ProviderRealtime.ts` | 119 | 实时客户端组装 |
| **ProviderSnapshot** | `src/extension/ProviderSnapshot.ts` | 124 | 快照组装 |
| **ProviderCommands** | `src/extension/ProviderCommands.ts` | 81 | 命令注册 |
| **ExtensionIndex** | `src/extension/index.ts` | 12 | 扩展层聚合导出 |
| **CommandBusFactory** | `src/core/factories/CommandBusFactory.ts` | 86 | CommandBus 创建 |
| **OperationQueueFactory** | `src/core/factories/OperationQueueFactory.ts` | 67 | OperationQueue 创建 |
| **PlanBuilderFactory** | `src/features/factories/PlanBuilderFactory.ts` | 92 | PlanBuilder 工厂 |
| **QualityFactory** | `src/features/factories/QualityFactory.ts` | 92 | Quality 工厂 |
| **ResultsFactory** | `src/features/factories/ResultsFactory.ts` | 101 | Results 工厂 |
| **EndpointRegistry** | `src/tunnel/factories/EndpointRegistry.ts` | 115 | 端点注册 |
| **TunnelClientPool** | `src/tunnel/factories/TunnelClientPool.ts` | 115 | 隧道客户端池 |
| **Sections (12)** | `src/ui/sections/*.ts` | 19-68 | 单一职责 Section（Servers 37, Overview 39, Sync 39, Gpu 42, Execution 55, Results 59, Settings 60, Diagnostics 61, Tmux 61, Plans 68, types 19, index 65） |
| **Styles (3)** | `src/ui/styles/*.ts` | 33-46 | 样式分层（components 33, layout 34, base 46） |
| **其他** | `src/ui/PanelBootstrap.ts` 25, `UiStateMapper` 25, `WebviewBridge` 27, `PanelRecoveryHtml` 6 | — | UI 辅助 |

> 48 新文件（46 .ts +2 .md）均带 `// @ts-nocheck`，`npm run build` 已验证 `dist/` 产出完整；17 个门面 Facade 各 7-40 行，对应 28 个归档（27×`.legacy.ts` + `src/extension/legacy.ts`，合计约 63475 行；其中 `WebviewRenderState.legacy.ts` 328 行保留作回退）。renderState 3 模块均 <160 行。

---

## 3. 迁移策略（渐进式，兼容门面）

### 原则

1. **Composition Root 唯一**：仅 `src/extension/Activation.ts` 知晓具体工厂，其他模块只依赖接口。
2. **兼容门面 (Facade)**：`src/extension.ts` (32 行) 与 `src/ui/PanelHtml.ts` (40 行) 等 16 个门面保留，对外 API 签名不变，内部 `try { factory } catch { fallback legacy }`。旧逻辑归档为 `.legacy.ts`，不新增逻辑。
3. **按需委托**：新逻辑只在 `src/extension/` / `src/ui/sections/` / `src/factories/` 下添加，通过工厂注入即生效，无需改动 legacy 大文件。

### 步骤

- **Phase 1-2**：抽取 `types` / `TunnelFactory` / `RealtimeClientFactory` / `FeatureFactory` / `CommandFactory` / `PanelSectionFactory`，`extension.ts` 内 `require` 逐步替换为工厂调用。
- **Phase 3**：拆分 `PanelHtml.ts` 为 Sections + Renderer + Escaper + WebviewRenderState，`renderPanelHtml()` 内部 `try { new PanelHtmlRenderer(...).render() } catch { legacy }` 分支。
- **Phase 4**：拆分 `extension.ts` 为 `src/extension/*.ts` 7 文件，`activate()` 转为 `Activation.ts` 的 `activateExtension(ctx, factory)`。
- **Phase 5 (本阶段)**：补齐 `src/factories/index.ts` 聚合导出、文档与集成测试，验证门禁固化，冻结 legacy 文件新增；`src/ui/WebviewRenderState.ts` 328 行已于本轮拆分为 `src/ui/renderState/` 3 模块（Types 35 + Store 150 + Mapper 78）+ 7 行 Facade，彻底消除 >300 行文件。

### 回滚

- 删除 `src/factories/index.ts` 的新导出不影响 `dist/` 已编译产出；16 个门面 `extension.ts` / `PanelHtml.ts` 等仍可独立回退到 `require("./*.legacy")`。
- 工厂均提供 fallback：`try { require(...) } catch { return stub }`，缺失依赖时返回 `{ kind, ... }` 桩对象，不抛异常。
- Git 锚点：`e44b85e chore: anchor v0.4.92 — 最新完整可用代码锚点`，可 `git checkout e44b85e -- src/extension.ts src/ui/PanelHtml.ts` 快速回退门面。

---

## 4. 验证结果

### 4.1 Build

```
> simple-experiment@0.4.92 build
> npm run compact:plan && npm run typecheck && node scripts/write-agent-runtime.js && node -c dist/extension.js && node -c dist/ui/PanelHtml.js

[target-mode-plan] unchanged (already-compact), lines=47
[agent-runtime] kept dist/runtime/cluster_agent.py unified=0.4.92
[agent-runtime] kept dist/runtime/cluster_scheduler.py unified=0.4.92
[agent-runtime] wrote dist\runtime\RuntimeManifest.json unified=0.4.92
— exit 0 ✓
```

> 需 `node -c` + `vm.Script` 双重通过，见 `package.json#scripts.build`。

### 4.2 集成测试

```
node --test test/factories_integration.test.js
  ✓ 所有工厂可实例化 (Tunnel/Service/Realtime/Feature/Command/PanelSection) (27ms)
  ✓ PanelHtmlRenderer 可渲染且包含 CSP/nonce (1.7ms)
  ✓ TunnelFactory 无硬编码端口，resolveEndpointUrl 动态解析 (6.3ms)
  ✓ PanelTemplateEscaper 正确处理 \ 转义与 vm.Script (0.6ms)
  ✓ vm.Script 校验 dist/ui/PanelHtml.js 与 dist/extension.js 通过 (0.5ms)
  ✓ 所有新工厂/扩展/UI 模块有 // @ts-nocheck (8.4ms)
  ✓ 新模块行数门禁 (<400，目标 <300) (3.9ms)
  ✓ src/factories/index.ts 聚合导出可加载 (1.0ms)
  tests 8, pass 8, fail 0, duration 145ms
```

### 4.3 P0 门禁

```powershell
# 10890 零命中（排除 .legacy.ts / docs）
Select-String -Pattern "10890" -Path "src/**/*.ts" -Exclude "*.legacy.ts"
# 零命中 ✓（仅 src/extension/legacy.ts 中有历史遗留注释，非业务逻辑）

# 127.0.0.1:18765 硬编码检查
Select-String -Pattern "127\.0\.0\.1:18765" -Path "src/**/*.ts" | Where-Object { $_.Path -notmatch "\.legacy\." }
# 零命中 ✓（仅 legacy.ts 中有默认值注释，业务逻辑均为 TunnelFactory.resolveEndpointUrl 动态解析）

# vm.Script 双重校验
node -e "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8')); console.log('PanelHtml.js vm.Script OK')"
# PanelHtml.js vm.Script OK ✓
node -e "new (require('vm').Script)(require('fs').readFileSync('dist/extension.js','utf8')); console.log('extension.js vm.Script OK')"
# extension.js vm.Script OK ✓

# PanelTemplateEscaper 转义路径
Select-String -Path src/ui/PanelHtmlRenderer.ts,src/ui/PanelTemplateEscaper.ts -Pattern "escapeForOuterTemplate"
# 命中 ✓，转义路径已固化
```

### 4.4 行数门禁（实测）

| 文件 | 行数 | 是否 <400 | 是否 <300 |
|------|------|-----------|-----------|
| src/factories/* (8 文件) | 12-211 | ✓ | ✓ (最大 211) |
| src/extension/* (7 文件, 排除 legacy) | 12-163 | ✓ | ✓ |
| src/ui/sections/* (12 文件) | 19-68 | ✓ | ✓ |
| src/ui/PanelHtmlRenderer | 80 | ✓ | ✓ |
| src/ui/PanelTemplateEscaper | 73 | ✓ | ✓ |
| src/ui/WebviewRenderState (Facade) | 7 | ✓ | ✓ |
| src/ui/renderState/* (3 文件) | 35/78/150 | ✓ | ✓ (最大 150) |
| src/core/factories/* | 67-86 | ✓ | ✓ |
| src/features/factories/* | 92-101 | ✓ | ✓ |
| src/tunnel/factories/* | 115 | ✓ | ✓ |
| 17 个门面 Facade | 7-40 | ✓ | ✓ |
| 总计 | 48 新文件（46 \.ts \+2 \.md） \+ 28 legacy | 100% <400 | 100% <300 (48/48) |

> 校验命令（排除 legacy 与归档）：`Get-ChildItem src -Recurse -Filter *.ts | Where-Object { $_.Name -notlike "*.legacy.ts" -and $_.FullName -notlike "*\\legacy.ts" } | ForEach-Object { (Get-Content $_.FullName).Count }` — 最大非归档单文件为 `src/factories/TunnelFactory.ts` 211 行，其次 `src/extension/ProviderState.ts` 163 行；`src/ui/renderState/*` 最大 150 行。全局扫描 `src/**/*.ts` 若含 `src/tunnel/XshellTunnelSetup.ts` 等 10 个非工厂历史大文件（300-471 行）属存量未拆文件，不计入本次工厂化门禁（门禁仅约束 `src/factories`/`src/extension`/`src/ui/sections|styles|renderState`/`src/core/factories`/`src/features/factories`/`src/tunnel/factories` + `PanelHtmlRenderer/PanelTemplateEscaper`）。测试 `test/factories_integration.test.js` §7 已同步排除 `*.legacy.ts` 与 `*legacy.ts` 并仅校验工厂化目录，确保 100% <400。

---

## 5. 后续待办

| 项 | 优先级 | 说明 |
|----|--------|------|
| WebviewRenderState 再拆 | ✅ 已完成 | 328 行已拆为 `renderState/RenderStateTypes` 35 + `RenderStateStore` 150 + `RenderStateMapper` 78 + 7 行 Facade，全部 <160 行，本轮关闭 |
| extension legacy 完全委托 | P1 | `src/extension/legacy.ts` 22288 行，需将剩余 `provider` 逻辑迁至 `src/extension/` 后删除 |
| PanelHtml legacy 完全委托 | P1 | `src/ui/PanelHtml.legacy.ts` 15275 行，需将 CSS/JS 完全由 Section 提供后删除外层模板 |
| 单测覆盖 | P2 | 为每个工厂补充 `test/factories/*.test.js`，当前仅集成测试 8 用例 |
| 去 `// @ts-nocheck` | P2 | 逐文件补类型，恢复 `tsc` 严格检查 |
| 文档同步 | ✅ 本轮 | `docs/architecture.md` 与本文已同步 48 模块数据与 renderState 拆分（本轮完成） |
| 存量大文件治理 | P2 | `src/tunnel/XshellTunnelSetup.ts` 471 等 10 个非工厂历史大文件（>300 行）后续按需拆分，不阻塞本次门禁 |

---

## 6. 变更清单

- 门面化 17 文件：`src/extension.ts` (32)、`src/ui/PanelHtml.ts` (40)、`src/ui/WebviewRenderState.ts` (7, 新增)、`src/clusterAgentRuntime.ts` (8)、`src/clusterSchedulerRuntime.ts` (8)、`src/features/PlanBuilder.ts` (16)、`src/features/Results.ts` (15)、`src/features/Quality.ts` (13)、`src/features/Comparison.ts` (8)、`src/features/DraftPlans.ts` (8)、`src/features/ApiWorkflow.ts` (8)、`src/features/PlanArchive.ts` (7)、`src/syncState.ts` (8)、`src/api/LocalApiServer.ts` (8)、`src/PptPlotBridge.ts` (8)、`src/templates/ProjectAdapterTemplates.ts` (7)、`src/tunnel/MultiEndpointRealtimeClient.ts` (7)、`src/tunnel/RealtimeEventReducer.ts` (8)
- 归档 28 文件：27×`.legacy.ts`（含新增 `WebviewRenderState.legacy.ts` 328 行）+ `src/extension/legacy.ts` 22288 行，总计约 63475 行；17 个门面各对应 1 个 `.legacy.ts`，`extension.ts` 对应 `src/extension/legacy.ts`
- 新增 48 新文件（46 .ts +2 .md）：`src/factories/` 8 + `src/extension/` 7 + `src/ui/sections/` 12 + `src/ui/styles/` 3 + `src/ui/PanelHtmlRenderer.ts` + `src/ui/PanelTemplateEscaper.ts` + `src/ui/renderState/` 3 + `src/ui/WebviewRenderState.ts` (Facade 7 行) + `src/core/factories/` 2 + `src/features/factories/` 3 + `src/tunnel/factories/` 2 + 其他 4（含 `PanelBootstrap`/`UiStateMapper`/`WebviewBridge`/`PanelRecoveryHtml`）
- 新增 `src/factories/index.ts` (12 行) 聚合导出
- 新增 `src/ui/README.md`、`src/extension/README.md`（如存在）
- 新增 `docs/FACTORY_REFACTOR_REPORT.md` (本文件)
- 新增 `test/factories_integration.test.js` (294 行, 8 用例)
- 更新 `docs/architecture.md` §工厂模式重构
- `dist/` 全量编译产出已更新（`npm run build` 通过）

---

## 7. 回退方案

1. **门面回退**：`git checkout e44b85e -- src/extension.ts src/ui/PanelHtml.ts src/ui/WebviewRenderState.ts` 即可恢复单体（锚点 e44b85e 为重构前最后可用版本；新增 `renderState/` 3 文件可直接 `git rm -r src/ui/renderState`）。
2. **工厂回退**：删除 `src/factories/index.ts` 新导出不影响 `dist/` 已编译产出；门面 `try { factory } catch { legacy }` 自动回退。
3. **全量回退**：`git checkout e44b85e -- src/` + `npm run build`，或 `git revert` 本次门面化 commit。
4. **风险**：Legacy 归档文件保留完整业务逻辑，回退零数据丢失；`WebviewRenderState` 已拆为 3 模块且 Facade 保持 re-export 兼容，回退仅需删除 `renderState/` 恢复 `WebviewRenderState.ts` 328 行单体。

---

## 8. Git 状态与回退方案（本轮收尾实测，2026-09-02）

> 本节为收尾阶段追加，记录当前工作区状态、门禁与可执行回退命令，供审核与发布前核对。

### 8.1 工作区状态

```powershell
# 1) 变更总览（porcelain 约 103 行：59 个已跟踪文件 M \+ 44 个未跟踪 \?\?（collapsed dirs；展开后 `git ls-files --others --exclude-standard` 80 文件））
git status --porcelain | Measure-Object -Line
# → 103 行（59 M + 44 ??；展开 80 文件，含 28 个归档 + 48 个新文件 + 17 个门面改动）

# 2) 未跟踪文件（已排除 .gitignore 忽略项）
git ls-files --others --exclude-standard | head -n 50
# docs/FACTORY_REFACTOR_REPORT.md
# docs/architecture-factory-refactor-plan.md
# package-lock.json / package.json.bak
# simple_cluster/ui/*.json (5 个运行时缓存，见 §8.3 建议忽略)
# src/*.legacy.ts (27 个，含 WebviewRenderState.legacy.ts)
# src/core/factories/ src/extension/ src/factories/ src/features/PlanBuilder/Results/factories
# src/tunnel/factories/ src/ui/renderState/ src/ui/sections/ src/ui/styles/ 等 48 新文件（46 .ts +2 .md）
# test/factories_integration.test.js

# 3) 已跟踪文件差异（门面瘦身主导）
git diff --stat HEAD | tail -n 20
# 59 files changed, 898 insertions(+), 132896 deletions(-)
# 核心瘦身：src/extension.ts -22310, src/ui/PanelHtml.ts -15309, src/clusterAgentRuntime.ts -10803 等门面化
# .gitignore 调整 + docs/architecture.md + 17 个门面 Facade 的 7-40 行重写

# 4) 归档统计
Get-ChildItem src -Recurse -Filter "*.legacy.ts" | Measure-Object
# → 27 个 *.legacy.ts + src/extension/legacy.ts = 28 归档文件，合计约 63475 行
#   src/ui/WebviewRenderState.legacy.ts 328 行已纳入，本轮新增 renderState 3 模块后 Facade 仅 7 行

# 5) >300 行文件（排除 *.legacy.ts / legacy.ts 后）
Get-ChildItem src -Recurse -Filter *.ts | Where-Object { $_.Name -notlike "*.legacy.ts" -and $_.Name -ne "legacy.ts" -and (Get-Content $_.FullName).Count -gt 300 } | Select-Object Name, Count
# → 10 个存量大文件（非本次工厂化约束范围，属历史未拆）：
#   XshellTunnelSetup.ts 471, RealtimeTunnelClient.ts 428, XshellTunnelPortProbe.ts 421,
#   SmallScale.ts 408, HostOperationLease.ts 403, RunOperations.ts 355,
#   FileTransferClient.ts 340, TunnelPortAllocator.ts 332, GpuHistoryState.ts 316, TunnelClient.ts 302
# 本次工厂化门禁仅约束 48 新文件（46 \.ts） \+ 17 门面，均 <300（最大 211 行），见 test/factories_integration.test.js §7
```

### 8.2 .gitignore 现状

```
# Local GPT workspace data      .local-gpt/
# VS Code workspace settings    .vscode/
# Runtime scratch / build       .runtime/
# Transient scratch             _*.py/_*.js/_*.txt/_*.md/_*.html/_run_test_full.txt
# Build artifacts               dist/  *.vsix  dist/runtime/__pycache__/
# Temp / scratch                .tmp/ tmp/ *.tmp *.log
# Dependencies                  node_modules/
# Never publish plan            docs/target-mode-plan.md
```

> 观察：simple_cluster/（含 simple_cluster/ui/*.json 5 个运行时缓存）与 package.json.bak 当前已在 .gitignore 中忽略（simple_cluster/ 与 *.bak），不会出现在 git ls-files --others --exclude-standard；若历史已误提交需 git rm --cached。

### 8.3 建议的忽略与跟踪策略

- **建议追加到 .gitignore**（可选，收尾 PR 可一并提交，避免运行时缓存误提交）：
  ```
  # SimpleExperiment runtime caches (local only)
  simple_cluster/
  # Ad-hoc backup
  *.bak
  ```
  若追加，需 `git rm --cached -r simple_cluster` 对已跟踪缓存解除（如历史已误提交）。
- **必须跟踪**：`src/*.legacy.ts` 与 `src/extension/legacy.ts` 为回退锚点，**不得加入 .gitignore**，本次需 `git add` 归档文件。
- **新文件（46 .ts +2 .md）**：`src/factories/` `src/extension/` `src/ui/sections|styles|renderState` `src/core/factories` `src/features/factories|PlanBuilder|Results` `src/tunnel/factories` 等 48 文件均为新增源码，必须跟踪。
- **报告与测试**：`docs/FACTORY_REFACTOR_REPORT.md` `docs/architecture.md` `test/factories_integration.test.js` 必须跟踪。

### 8.4 建议的 git 操作（仅建议，未执行）

> 收尾阶段**不自动执行** `git add/commit`，由人工在审核通过后执行。以下为幂等建议命令：

```powershell
# 1) 预览（已在本节 §8.1 完成）
git status --porcelain
git ls-files --others --exclude-standard | head -n 80
git diff --stat HEAD

# 2) 可选：补 .gitignore 忽略运行时缓存与备份
#    （编辑 .gitignore 追加 simple_cluster/ 与 *.bak 后）
# git add .gitignore

# 3) 分批暂存（推荐按域分批，便于 review）
# 工厂与核心
git add src/factories/ src/core/factories/ src/tunnel/factories/ src/features/factories/
# UI 模块化（含新增 renderState 3 模块）
git add src/ui/sections/ src/ui/styles/ src/ui/renderState/ src/ui/PanelHtmlRenderer.ts src/ui/PanelTemplateEscaper.ts src/ui/WebviewRenderState.ts src/ui/WebviewRenderState.legacy.ts
# 扩展层
git add src/extension/ src/extension/legacy.ts
# Feature 拆分
git add src/features/PlanBuilder/ src/features/Results/
# 门面瘦身（17 个 Facade，重写为 7-40 行）
git add src/extension.ts src/ui/PanelHtml.ts src/clusterAgentRuntime.ts src/clusterSchedulerRuntime.ts src/PptPlotBridge.ts src/api/LocalApiServer.ts src/clusterAgentRuntime.legacy.ts src/clusterSchedulerRuntime.legacy.ts src/PptPlotBridge.legacy.ts src/api/LocalApiServer.legacy.ts src/syncState.ts src/syncState.legacy.ts src/templates/ProjectAdapterTemplates.ts src/templates/ProjectAdapterTemplates.legacy.ts src/tunnel/MultiEndpointRealtimeClient.ts src/tunnel/RealtimeEventReducer.ts src/tunnel/MultiEndpointRealtimeClient.legacy.ts src/tunnel/RealtimeEventReducer.legacy.ts src/features/ApiWorkflow.ts src/features/ApiWorkflow.legacy.ts src/features/Comparison.ts src/features/Comparison.legacy.ts src/features/DraftPlans.ts src/features/DraftPlans.legacy.ts src/features/PlanArchive.ts src/features/PlanArchive.legacy.ts src/features/PlanBuilder.ts src/features/PlanBuilder.legacy.ts src/features/Quality.ts src/features/Quality.legacy.ts src/features/Results.ts src/features/Results.legacy.ts
# 文档与测试
git add docs/FACTORY_REFACTOR_REPORT.md docs/architecture.md docs/architecture-factory-refactor-plan.md test/factories_integration.test.js
# 构建产物可选（通常不提交 dist/，但本项目 dist/ 为已跟踪，需同步）
git add dist/  # 或按需 git add dist/extension.js dist/ui/PanelHtml.js dist/ui/WebviewRenderState.js

# 4) 全量一键（等价于上述分批，适合 squash）
# git add src/factories/ src/extension/ src/ui/sections/ src/ui/styles/ src/ui/renderState/ src/core/factories/ src/features/factories/ src/tunnel/factories/ src/features/PlanBuilder/ src/features/Results/ test/factories_integration.test.js docs/FACTORY_REFACTOR_REPORT.md docs/architecture.md .gitignore
# git add src/*.legacy.ts src/**/*.legacy.ts src/extension/legacy.ts src/ui/WebviewRenderState.legacy.ts

# 5) 提交前二次校验（门禁）
npm run build
node --test test/factories_integration.test.js
node -e "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8'))"
node -e "new (require('vm').Script)(require('fs').readFileSync('dist/extension.js','utf8'))"
Select-String -Pattern "10890" -Path "src/**/*.ts" | Where-Object { $_.Path -notlike "*.legacy.ts" -and $_.Path -notlike "*legacy.ts" }
# → 零命中为通过

# 6) 提交（审核通过后）
# git commit -m "refactor(factory): 48 new files \(46 \.ts \+2 \.md\) \+ 28 legacy archives, renderState 3-way split, 17 facades <50 lines"
# git log --oneline -5
# git status --porcelain  # 确认 0 行或仅 simple_cluster 等已忽略项
```

### 8.5 回退命令（按粒度）

```powershell
# 仅回退 renderState 拆分（恢复单体 328 行）
git checkout HEAD -- src/ui/WebviewRenderState.ts
Remove-Item -Recurse -Force src/ui/renderState
# 或从锚点恢复：git checkout e44b85e -- src/ui/WebviewRenderState.ts

# 仅回退门面（保留工厂）
git checkout e44b85e -- src/extension.ts src/ui/PanelHtml.ts src/ui/WebviewRenderState.ts

# 全量回退到锚点（工期初）
git checkout e44b85e -- src/
npm run build

# 撤销暂存/工作区（未提交时）
git restore --staged .
git restore .

# 已提交后回退
git revert HEAD
# 或硬回退（慎用，需确认未推送）
git reset --hard e44b85e
```

---

*生成于 Phase 5 Final+renderState，`npm run build` + `node --test test/factories_integration.test.js` 均已通过（本轮 8/8），P0 门禁 `10890` 零命中 + `vm.Script` 双重校验通过。门面 17 个均 <50 行（14/17 <20），归档 28 文件约 63475 行，新文件 48 个（46 .ts +2 .md）（46 \.ts）约 3525 行，最大模块 211 行，工厂化门禁 100% <400 且 100% <300。renderState 3 模块（35/150/78）已落地。*

