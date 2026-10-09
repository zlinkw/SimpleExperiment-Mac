# SimpleExperiment 工厂模式重构方案（Factory Refactor Plan v0.4.92）

> 状态：架构设计稿（Architecture Design Proposal）——待评审后进入分阶段迁移  
> 基线：71k 行 / 119 文件 / `src/extension.ts` 22260 行（592 函数）/ `src/ui/PanelHtml.ts` 14473 行（单函数 `renderPanelHtml()`，约 925 个内联函数）  
> 已有分层：`core / state / services / tunnel / features / ui / runtime`，但 `extension.ts` 仍强耦合 30+ 模块，`PanelHtml.ts` 单模板吞吐全部 CSS+HTML+JS  
> 约束红线：P0-外层模板裸反斜杠禁令（`src/ui/PanelHtml.ts` 外层 `` return `...<script>...` `` 内禁止裸 `\s \d \n`）、P0-禁止硬编码隧道端口/IP（需动态读取 `TunnelEndpointConfig/localForwardPort`）、禁止直连 SSH、`npm run build` 双重校验 `node -c` + `vm.Script`

---

## 1. 设计目标与原则

### 1.1 核心问题
| 维度 | 现状痛点 | 工厂模式要解决的 |
|---|---|---|
| `extension.ts` | 单体入口 + 全局 `provider` + 30+ `require` + 592 函数 + 缓存/去重/限流/状态构建全部内聚 | 将创建逻辑与使用逻辑解耦，`activate()` 只做组装（Composition Root） |
| `PanelHtml.ts` | 单函数返回 14k 行模板，CSS 700+ 行、HTML 700+ 行、JS 13000+ 行混在一个模板字符串，外层模板剥离导致裸 `\` 风险 | 按关注点分离 + Section 工厂，模板不再承载逻辑，正则/字符串通过工厂方法安全转义 |
| `tunnel/*` | `TunnelGateway / XshellTunnelSetup / TunnelEndpointRegistry / TunnelPortAllocator / MultiEndpointRealtimeClient` 创建散落在 `RealtimeTunnelPanelProvider` 的 20+ 个 `private xxxCache` 方法中，难以测试 | 统一 `TunnelFactory / RealtimeClientFactory`，端点创建可注入、可 Mock、可单测 |
| `features/*` | `PlanBuilder / Results / Lifecycle / Anomaly` 等 15+ Feature 模块在 `extension.ts` 中以 `if (command === '...')` 分支硬编码 | `FeatureFactory + CommandFactory` 将“命令→Feature→OperationQueue”映射表驱动化 |
| 可测试性 | 巨型类难以单元测试，`FakeClusterRuntime` 只能模拟运行时，无法单测工厂创建 | 工厂接口 + 内存实现 + Fake 实现，可 `new FakeTunnelFactory()` 直接注入 |

### 1.2 原则
1. **Composition Root 唯一**：只有 `src/extension/activate.ts` 知道所有具体工厂，其他模块只依赖抽象。
2. **渐进式、可回退**：每个工厂先以“门面（Facade）包裹旧实现”的方式落地，旧代码保留为 `*.legacy.ts`，新代码通过特性开关并行验证。
3. **P0 门禁内建**：所有穿越 `PanelHtml` 外层模板的文本必须经 `PanelTemplateEscaper.escapeForOuterTemplate()` 二次转义；所有端点创建必须经 `TunnelFactory.resolveEndpoint()` 读取用户配置，禁止工厂内出现字面量 `10890` / `18765`。
4. **行数目标**：任何新文件 >800 行即视为二次拆分信号；`extension.ts` 拆分后单文件目标 300–600 行，`PanelHtml.ts` 拆分后单 Section 目标 <400 行。

---

## 2. 工厂体系总览（Factory Family）

```
ExtensionHost (activate)
  └─ ServiceFactory (根工厂 / Abstract Factory)
       ├─ TunnelFactory              → 创建所有 Tunnel 相关对象
       ├─ RealtimeClientFactory      → 创建 Realtime 客户端族
       ├─ FeatureFactory             → 创建 Feature 处理器族
       ├─ CommandFactory             → 创建/注册 VS Code Command
       ├─ PanelSectionFactory        → 创建 Webview Section
       └─ UiFactory                  → 创建 Bridge / Mapper / Layout
```

### 2.1 工厂继承关系
- **Abstract Factory**：`ServiceFactory` 聚合子工厂，向 `activate()` 暴露统一创建入口，保持引用一致性（同一 `RequestBudget` / 同一 `ClusterStore` 被复用）。
- **Factory Method**：各子工厂内部用 Factory Method 创建具体产品（如 `TunnelFactory.createPortAllocator()`）。
- **辅助模式**：`Builder`（PlanBuilder 参数组装）、`Strategy`（`RefreshProfile` 切换）、`Registry`（`TunnelEndpointRegistry` 仍保留，但由工厂统一构造）。

---

## 3. 工厂接口定义（TypeScript）

### 3.1 通用基类型

```ts
// src/factories/types.ts
export interface FactoryContext {
  readonly extensionUri: vscode.Uri;
  readonly globalState: vscode.Memento;
  readonly workspaceState: vscode.Memento;
  readonly secrets?: vscode.SecretStorage;
  readonly clusterStore: import('../state/ClusterStore').ClusterStore;
  readonly operationQueue: import('../core/OperationQueue').OperationQueue;
  readonly requestBudgetConfig: import('../tunnel/RequestBudget').RequestBudgetConfig;
}

export interface Factory<TProduct> {
  create(ctx: FactoryContext): TProduct;
}

export interface DisposableFactory<T extends vscode.Disposable> extends Factory<T> {
  create(ctx: FactoryContext): T;
}
```

### 3.2 ServiceFactory（根抽象工厂）

```ts
// src/factories/ServiceFactory.ts
import type { TunnelFactory } from './TunnelFactory';
import type { RealtimeClientFactory } from './RealtimeClientFactory';
import type { FeatureFactory } from './FeatureFactory';
import type { CommandFactory } from './CommandFactory';
import type { PanelSectionFactory } from './PanelSectionFactory';
import type { UiFactory } from './UiFactory';

export interface ServiceFactory {
  readonly tunnel: TunnelFactory;
  readonly realtime: RealtimeClientFactory;
  readonly features: FeatureFactory;
  readonly commands: CommandFactory;
  readonly panels: PanelSectionFactory;
  readonly ui: UiFactory;

  // 供 activate() 一键组装 provider
  createPanelProvider(ctx: FactoryContext): import('../extension/provider/RealtimeTunnelPanelProvider').RealtimeTunnelPanelProvider;
  createLocalApiServer(ctx: FactoryContext): import('../api/LocalApiServer').LocalApiServer;
}

export class DefaultServiceFactory implements ServiceFactory {
  constructor(
    public readonly tunnel = new DefaultTunnelFactory(),
    public readonly realtime = new DefaultRealtimeClientFactory(),
    public readonly features = new DefaultFeatureFactory(),
    public readonly commands = new DefaultCommandFactory(),
    public readonly panels = new DefaultPanelSectionFactory(),
    public readonly ui = new DefaultUiFactory(),
  ) {}
  createPanelProvider(ctx: FactoryContext) { /* 组装并注入 */ }
  createLocalApiServer(ctx: FactoryContext) { /* ... */ }
}
```

### 3.3 TunnelFactory（隧道产品族）

```ts
// src/factories/TunnelFactory.ts
import type { TunnelGatewayConfig } from '../tunnel/TunnelGateway';
import type { XshellSetupConfig } from '../tunnel/XshellTunnelSetup';
import type { TunnelEndpointAssignment, TunnelPortRange } from '../tunnel/TunnelPortAllocator';

export interface TunnelFactory {
  // 配置归一化（禁止硬编码端口，全部走 normalize）
  normalizeGatewayConfig(input: Partial<TunnelGatewayConfig>): TunnelGatewayConfig;
  normalizeSetupConfig(input: Partial<XshellSetupConfig>): XshellSetupConfig;

  // 端点与端口
  createPortAllocator(range?: TunnelPortRange): import('../tunnel/TunnelPortAllocator').TunnelPortAllocator;
  createEndpointRegistry(setup: XshellSetupConfig, probes?: Record<string, unknown>): import('../tunnel/TunnelEndpointRegistry').TunnelEndpointRegistry;
  detectPortConflicts(assignments: TunnelEndpointAssignment[], range?: TunnelPortRange): import('../tunnel/TunnelPortConflict').TunnelPortConflict[];

  // 探活与启动
  createPortProbe(): import('../tunnel/XshellTunnelPortProbe').PortProbe;
  createLauncher(): import('../tunnel/XshellSessionLauncher').XshellSessionLauncher;
  createIntegration(): import('../tunnel/XshellTunnelIntegration').XshellTunnelIntegration;

  // 动态解析 P0 关键方法：禁止工厂内出现字面量端口，必须读取输入配置
  resolveEndpointUrl(cfg: { localHost: string; localPort: number }): string; // 内部调用 localBaseUrl()
}

export class DefaultTunnelFactory implements TunnelFactory {
  normalizeGatewayConfig(input) { return TunnelGateway.normalizeTunnelGatewayConfig(input); }
  resolveEndpointUrl(cfg) { return TunnelGateway.localBaseUrl(cfg); } // 断言 assertLocalhost 非 throw 逻辑
  // ...
}
```

**产品族**：`TunnelGatewayConfig` / `XshellSetupConfig` / `TunnelPortAllocator` / `TunnelEndpointRegistry` / `XshellTunnelPortProbe` / `XshellSessionLauncher` / `XshellTunnelIntegration`

### 3.4 RealtimeClientFactory（实时流产品族）

```ts
// src/factories/RealtimeClientFactory.ts
import type { NamedTunnelEndpointConfig } from '../tunnel/MultiEndpointRealtimeClient';
import type { RequestBudget } from '../tunnel/RequestBudget';
import type { RealtimeRefreshPolicy } from '../tunnel/RealtimeTunnelClient';

export interface RealtimeClientFactory {
  createBudget(endpoint: NamedTunnelEndpointConfig): RequestBudget;
  createSingleClient(
    endpoint: import('../tunnel/TunnelClient').TunnelEndpointConfig,
    budget: RequestBudget,
    policy: RealtimeRefreshPolicy,
    onState: (s: import('../tunnel/RealtimeEventReducer').RealtimeState) => void,
  ): import('../tunnel/RealtimeTunnelClient').RealtimeTunnelClient;

  createMultiClient(
    endpoints: NamedTunnelEndpointConfig[],
    budgetFactory: (e: NamedTunnelEndpointConfig) => RequestBudget,
    policy?: RealtimeRefreshPolicy,
    onState?: (s: import('../tunnel/RealtimeEventReducer').RealtimeState) => void,
  ): import('../tunnel/MultiEndpointRealtimeClient').MultiEndpointRealtimeClient;

  // 策略切换：realtime / balanced / manual_only
  policyForProfile(profile: import('../tunnel/TunnelGateway').RefreshProfile): RealtimeRefreshPolicy;
}
```

**P0 约束**：`endpoints` 的 `localPort` 必须来自 `TunnelFactory.createEndpointRegistry()` 的分配结果，不得在工厂内 `default 18765` 直赋，默认值仅在 `TunnelGateway.defaultTunnelGatewayConfig` 中定义一次。

### 3.5 FeatureFactory（特性产品族）

```ts
// src/factories/FeatureFactory.ts
export type FeatureKind =
  | 'planBuilder' | 'results' | 'lifecycle' | 'metrics' | 'comparison'
  | 'anomaly' | 'notifications' | 'searchTags' | 'recycleBin'
  | 'gpuHistory' | 'topology' | 'runOperations' | 'draftPlans';

export interface FeatureHandler<TArgs = unknown, TResult = unknown> {
  readonly kind: FeatureKind;
  execute(args: TArgs, ctx: import('./types').FactoryContext & { signal?: AbortSignal }): Promise<TResult>;
  // 每个 Feature 声明是否需要 OperationQueue 以及 exclusiveKeys / coalesceKey
  queueSpec?(args: TArgs): Pick<import('../core/OperationQueue').OperationSpec, 'priority' | 'exclusiveKeys' | 'coalesceKey' | 'timeoutMs'>;
}

export interface FeatureFactory {
  create(kind: FeatureKind): FeatureHandler;
  createAll(): Record<FeatureKind, FeatureHandler>;
  // 兼容旧版：按 WebviewActionCommand 映射到 FeatureHandler
  handlerForCommand(command: string): FeatureHandler | undefined;
}
```

**实现要点**：
- `PlanBuilder` / `Results` 等现有模块先不改内部逻辑，工厂仅做“适配器”包装：`PlanBuilderFeatureHandler` 内部 `import { buildExperimentMatrix } from '../features/PlanBuilder'` 并代理。
- `OperationQueue` 入口统一：`FeatureHandler.execute()` 由 `CommandFactory` 包装为 `operationQueue.enqueue({ id, type: handler.kind, ...handler.queueSpec() })`。

### 3.6 CommandFactory（命令产品族）

```ts
// src/factories/CommandFactory.ts
export interface CommandDescriptor {
  readonly id: string;               // 如 "simpleExperiment.testAllTunnels"
  readonly title: string;
  readonly category?: string;
  readonly when?: string;
  readonly handler: (...args: unknown[]) => unknown;
  readonly withLease?: boolean;       // 是否走 HostOperationLease
  readonly leaseLabel?: string;
}

export interface CommandFactory {
  createDescriptors(ctx: import('./types').FactoryContext): CommandDescriptor[];
  registerAll(ctx: vscode.ExtensionContext & { subscriptions: vscode.Disposable[] }, factoryCtx: import('./types').FactoryContext): vscode.Disposable[];
}
```

**与 `package.json` 的契约**：
- `contributes.commands` 38 个命令保持不动，`CommandFactory` 读取同一份 `COMMAND_MANIFEST`（从 `package.json` 生成的 `src/generated/commandManifest.ts`），避免两处枚举不一致。
- 迁移后 `activate()` 中 `vscode.commands.registerCommand` 的 20+ 处 `hostCommand(...)` 全部收敛到 `commandFactory.registerAll()` 一处。

### 3.7 PanelSectionFactory（面板切片工厂）

```ts
// src/factories/PanelSectionFactory.ts
export type SectionId =
  | 'overview' | 'plans' | 'results' | 'execution'
  | 'servers'  | 'settings' | 'gpu'  | 'sync' | 'diagnostics';

export interface PanelSection {
  readonly id: SectionId;
  readonly order: number;
  readonly title: string;
  readonly icon: string;
  renderHtml(state: unknown): string;          // 仅 HTML 片段
  renderCss(): string;                         // 仅 CSS 片段
  renderScript(): string;                      // 仅 JS 片段（已转义，可安全嵌入外层模板）
  // 客户端事件绑定声明，供统一注册
  readonly clientEvents?: ReadonlyArray<{ event: string; handler: string }>;
}

export interface PanelSectionFactory {
  create(id: SectionId, ctx: import('./types').FactoryContext): PanelSection;
  createAll(ctx: import('./types').FactoryContext): PanelSection[];
  // 模板转义门禁
  escaper: import('../ui/PanelTemplateEscaper').PanelTemplateEscaper;
}
```

**P0 专项**：
```ts
// src/ui/PanelTemplateEscaper.ts
export class PanelTemplateEscaper {
  // 将内层 <script> 中的裸 \ 批量双写，避免外层模板剥离
  escapeForOuterTemplate(js: string): string {
    return js
      .replace(/\\/g, '\\\\')           // \ -> \\  （关键：正则 \s \d 等在此被保护）
      .replace(/`/g, '\\`')             // 反引号
      .replace(/\$\{/g, '\\${');        // 模板插值
  }
  escapeInlineRegex(pattern: string): string { /* 校验裸 \ 并抛出 */ }
}
```
所有 `PanelSection.renderScript()` 的返回值在 `PanelHtml` 最终拼接前必须经过 `escaper.escapeForOuterTemplate()`，并在 CI 中增加 `vm.Script` 校验。

### 3.8 UiFactory

```ts
// src/factories/UiFactory.ts
export interface UiFactory {
  createWebviewBridge(ctx: import('./types').FactoryContext): import('../ui/WebviewBridge').WebviewBridge;
  createStateMapper(ctx: import('./types').FactoryContext): import('../ui/UiStateMapper').UiStateMapper;
  createPanelHtmlRenderer(sections: import('./PanelSectionFactory').PanelSection[]): import('../ui/PanelHtmlRenderer').PanelHtmlRenderer;
}
```

---

## 4. 新目录树（迁移目标）

```
src/
├── extension/                          # 拆自 extension.ts 22260 行
│   ├── activate.ts                     # 唯一 Composition Root，<120 行
│   ├── provider/
│   │   ├── RealtimeTunnelPanelProvider.ts   # 主 provider 壳，<600 行（仅生命周期与委托）
│   │   ├── ProviderState.ts            # 状态字段与聚合（原 654-820 行的字段区拆出）
│   │   ├── ProviderRealtime.ts         # connect / disconnect / reconnect / endpoints
│   │   ├── ProviderSnapshot.ts         # getSnapshot / buildState / buildPlanRuntimeEvidenceState
│   │   ├── ProviderSelections.ts       # selectedPlan/Task/Gpu 选择与持久化
│   │   ├── ProviderCommands.ts         # quickSetup / configure* / start* / test*
│   │   ├── ProviderOperations.ts       # OperationQueue 包装与 reconcile
│   │   ├── ProviderTunnel.ts           # currentAssignments / portConflicts / registry
│   │   └── ProviderLegacy.ts           # 兼容字段与迁移期转发（逐步删除）
│   ├── commands/
│   │   ├── commandManifest.ts          # 从 package.json 生成的命令清单
│   │   └── hostCommand.ts              # withHostOperationLease 包装
│   └── lifecycle/
│       ├── onboarding.ts
│       └── configurationWatcher.ts
│
├── factories/                          # 新增工厂层（本方案核心）
│   ├── types.ts
│   ├── ServiceFactory.ts               # 根抽象工厂
│   ├── TunnelFactory.ts
│   ├── RealtimeClientFactory.ts
│   ├── FeatureFactory.ts
│   ├── CommandFactory.ts
│   ├── PanelSectionFactory.ts
│   └── UiFactory.ts
│
├── ui/                                 # PanelHtml.ts 14473 行拆分目标
│   ├── PanelHtml.ts                    # 保留为门面：re-export + 委托给 PanelHtmlRenderer（<80 行）
│   ├── PanelHtmlRenderer.ts            # 最终拼接 HTML+CSS+JS（负责 escaper + vm.Script 校验）
│   ├── PanelTemplateEscaper.ts         # P0 转义门禁
│   ├── sections/                       # 每个 Section 独立文件，<400 行
│   │   ├── OverviewSection.ts
│   │   ├── PlansSection.ts
│   │   ├── ResultsSection.ts
│   │   ├── ExecutionSection.ts
│   │   ├── ServersSection.ts
│   │   ├── SettingsSection.ts
│   │   ├── GpuSection.ts
│   │   ├── SyncSection.ts
│   │   └── DiagnosticsSection.ts
│   ├── styles/
│   │   ├── base.css.ts                 # :root 变量 / reset（原 1-100 行）
│   │   ├── layout.css.ts               # app-shell / cardDeck / resourceTree
│   │   └── components.css.ts           # card / button / pill 等
│   ├── scripts/
│   │   ├── bootstrap.ts                # vscode API / 常量 / 状态初始化
│   │   ├── tmux.ts                     # 1400-1800 行的 tmux 逻辑拆出
│   │   ├── renderers.ts                # 各 Section 的 render* 函数
│   │   └── events.ts                   # postMessage / pendingActions / button 装饰
│   ├── PanelBootstrap.ts               # 保留
│   ├── PanelRecoveryHtml.ts            # 保留
│   ├── UiStateMapper.ts
│   ├── WebviewBridge.ts
│   └── WebviewRenderState.ts
│
├── tunnel/                             # 保持不变，仅创建逻辑上移至 TunnelFactory/RealtimeClientFactory
│   ├── TunnelGateway.ts
│   ├── XshellTunnelSetup.ts
│   ├── TunnelEndpointRegistry.ts
│   ├── TunnelPortAllocator.ts
│   ├── MultiEndpointRealtimeClient.ts
│   └── ...
│
├── features/                           # 保持不变，新增 FeatureFactory 适配器
│   ├── adapters/                       # 新增：每个 Feature 的 Handler 适配层
│   │   ├── PlanBuilderHandler.ts
│   │   ├── ResultsHandler.ts
│   │   └── ...
│   └── ...
│
├── services/                           # 保持，ServiceFactory 统一注入
├── core/
├── state/
├── runtime/
└── generated/                          # 构建生成
    └── commandManifest.ts
```

**行数目标对照**：
| 拆分前 | 拆分后 | 单文件行数目标 |
|---|---|---|
| `extension.ts` 22260 行 | `extension/provider/*` 10 文件 + `extension/activate.ts` | 每文件 300–600 行，provider 壳 <600 行 |
| `PanelHtml.ts` 14473 行 | `ui/sections/*` 9 文件 + `ui/styles/*` 3 文件 + `ui/scripts/*` 4 文件 + `PanelHtmlRenderer` | 每文件 <400 行，Renderer <250 行 |
| 工厂层 0 行 | `factories/*` 7 文件 | 每文件 120–280 行 |

---

## 5. extension.ts 拆分详案

### 5.1 现状切分点分析（基于 12000-13500 行采样）
- `12000-12280`：`realtimeEndpoints() / tunnelLaunchItems() / agentLaunchItems()` — 属于 **ProviderRealtime + ProviderTunnel** 边界。
- `12386-12572`：`buildPlanRuntimeEvidenceState() / buildState(): WebviewClusterState` — 属于 **ProviderSnapshot**，是最大耦合点（聚合 `ClusterStore / TunnelEndpointRegistry / GpuHistoryState / localOperations`），需最先抽离。
- `654-820`：字段区 80+ 个 `private` 状态 + 缓存（如 `currentAssignmentsCacheValue` / `endpointRegistryStateCacheValue`）— 统一收归 `ProviderState` 并引入显式 `VersionedCache`。
- `535-589`：`activateExtension() / hostCommand()` — 收归 `extension/activate.ts` + `CommandFactory`。

### 5.2 拆分文件清单与职责

| 新文件 | 来源行段（近似） | 职责 | 依赖工厂 | 行数目标 |
|---|---|---|---|---|
| `extension/activate.ts` | 535-593 | `activate/deactivate`、`registerWebviewViewProvider`、订阅 `onDidChangeConfiguration` | `ServiceFactory` | <120 |
| `extension/provider/RealtimeTunnelPanelProvider.ts` | 654-760（壳） | 保留类定义与 `dispose`，其余方法委托给 `*Mixin` 或组合对象 | `RealtimeClientFactory` | <450 |
| `extension/provider/ProviderState.ts` | 654-810 | 字段声明、缓存 `Map`、`VersionedCache` 工具、状态签名 | — | <500 |
| `extension/provider/ProviderRealtime.ts` | 11995-12040 | `createClient / connect / disconnect / realtimeEndpoints / diagnostics()` | `RealtimeClientFactory` | <500 |
| `extension/provider/ProviderSnapshot.ts` | 12360-12572 | `buildPlanRuntimeEvidenceState / buildState / compact*ForWebview` | `TunnelFactory` / `FeatureFactory` | <600 |
| `extension/provider/ProviderTunnel.ts` | 12172-12280 | `currentAssignments / currentPortConflicts / endpointRegistryState / hubDisplayName` | `TunnelFactory` | <450 |
| `extension/provider/ProviderSelections.ts` | 670-810（选择相关） | `selectedPlanId / selectedTaskUiKeys / planFileInput` 持久化队列整合 | — | <400 |
| `extension/provider/ProviderCommands.ts` | 545-575 + 各 `quickSetup / configure* / start*` | 业务命令实现，内部调用 `FeatureFactory` | `FeatureFactory` / `CommandFactory` | <600 |
| `extension/provider/ProviderOperations.ts` | 732-760 + `HostOperationLease` 相关 | `withHostOperationLease / workerActionInFlight / availabilityPush` | `OperationQueue` | <400 |
| `extension/lifecycle/onboarding.ts` | 594-652 | `runOnboardingSteps / setupGuideNextStep` | — | <200 |
| `extension/commands/commandManifest.ts` | `package.json#contributes.commands` 38 项 | 生成命令清单，确保与 `package.json` 单源 | — | <80 |

**拆分手法**：
- 采用“组合优于继承”：`RealtimeTunnelPanelProvider` 持有 `ProviderRealtime` / `ProviderSnapshot` 等成员对象，方法转发 `this.realtime.connect()`，避免多继承 Mixin 导致 `this` 混乱。
- 阶段一保留 `extension.ts` 作为 **兼容转发层**：`export { RealtimeTunnelPanelProvider } from './extension/provider/RealtimeTunnelPanelProvider'`，并在文件顶部 `// @deprecated` 注释，编译期同时输出旧路径与新路径，逐步替换 `import ... from "./extension"`。

### 5.3 关键代码示例：Composition Root

```ts
// src/extension/activate.ts
import * as vscode from 'vscode';
import { DefaultServiceFactory } from '../factories/ServiceFactory';
import { ClusterStore } from '../state/ClusterStore';
import { OperationQueue } from '../core/OperationQueue';

export async function activate(context: vscode.ExtensionContext) {
  const clusterStore = new ClusterStore();
  const operationQueue = new OperationQueue(500);
  const serviceFactory = new DefaultServiceFactory(); // 根工厂

  const ctx = {
    extensionUri: context.extensionUri,
    globalState: context.globalState,
    workspaceState: context.workspaceState,
    clusterStore,
    operationQueue,
    requestBudgetConfig: serviceFactory.tunnel.normalizeGatewayConfig(context.globalState.get('tunnelGatewayConfig')).maxRequestsPerMinute,
  };

  const provider = serviceFactory.createPanelProvider(ctx as any);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('simpleExperiment.panel', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    ...serviceFactory.commands.registerAll(context as any, ctx as any),
  );
  provider.startLocalApiServer();
  return provider;
}
```

---

## 6. PanelHtml.ts 拆分详案

### 6.1 现状切片
- **CSS 区**：`11-600` 行约 600 行样式（含 `app-shell / card / workflowStage / operationTimeline`）→ 拆为 `base.css.ts / layout.css.ts / components.css.ts`，每段以 `export const baseCss = String.raw`...`` 形式导出，**不再经过外层模板**。
- **HTML 区**：`1200-1438` 行 9 个 `<section data-section>` → 每个 Section 的 HTML 移入 `sections/*Section.ts` 的 `renderHtml()`。
- **JS 区**：`1439-15275` 行约 13800 行（含 925 函数：`tmux` / `renderResourceTree` / `operation` / `gpu` / 事件绑定）→ 拆为 `scripts/bootstrap.ts / tmux.ts / renderers.ts / events.ts`，再由各 Section 的 `renderScript()` 按需引入。

### 6.2 Section 工厂实现

```ts
// src/ui/sections/OverviewSection.ts
import type { PanelSection, SectionId } from '../../factories/PanelSectionFactory';

export class OverviewSection implements PanelSection {
  readonly id: SectionId = 'overview';
  readonly order = 0;
  readonly title = '总览';
  readonly icon = '⌘';
  renderHtml(state: any): string {
    return `
      <section class="section-card" data-section="overview" data-anchor="overview">
        <div class="section-head"><div class="section-title"><h2>总览</h2></div></div>
        <div id="overviewStatusGrid" class="overviewStatusGrid"></div>
        <div id="workflowStageRail" class="workflowStageRail"></div>
      </section>`;
  }
  renderCss(): string { return ''; /* 样式已在 styles/* 中 */ }
  renderScript(): string {
    // 注意：此处字符串内的正则需经 escaper 处理，或直接使用 String.fromCharCode 规避
    return `
      function renderOverview(state){
        const grid = el("overviewStatusGrid");
        if(!grid) return;
        // 示例：需匹配数字的正则必须写成 /\\\\d+/ 而非 /\\d+/，最终由 escaper 二次校验
        const hasNumber = /\\\\d+/.test(String(state.extensionVersion||""));
        grid.innerHTML = hasNumber ? "<span>"+esc(state.extensionVersion)+"</span>" : "";
      }
    `;
  }
}
```

### 6.3 Renderer 拼接与 P0 门禁

```ts
// src/ui/PanelHtmlRenderer.ts
import { PanelTemplateEscaper } from './PanelTemplateEscaper';
import type { PanelSection } from '../factories/PanelSectionFactory';

export class PanelHtmlRenderer {
  constructor(private readonly sections: PanelSection[], private readonly escaper = new PanelTemplateEscaper()) {}

  render(nonce: string): string {
    const css = this.sections.map(s => s.renderCss()).join('\n');
    const html = this.sections.sort((a,b)=>a.order-b.order).map(s => s.renderHtml({})).join('\n');
    const rawJs = this.sections.map(s => s.renderScript()).join('\n\n');
    const safeJs = this.escaper.escapeForOuterTemplate(rawJs);

    // 双重校验：编译期即保障
    try { new (require('vm').Script)(safeJs); } catch (e) { throw new Error('Panel JS vm.Script 校验失败: '+e); }

    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${css}</style></head><body>${html}<script nonce="${nonce}">${safeJs}</script></body></html>`;
  }
}
```

**兼容层**：
```ts
// src/ui/PanelHtml.ts  (迁移后仅保留门面，<80 行)
import { DefaultPanelSectionFactory } from '../factories/PanelSectionFactory';
import { PanelHtmlRenderer } from './PanelHtmlRenderer';
export function renderPanelHtml(): string {
  const factory = new DefaultPanelSectionFactory();
  const sections = factory.createAll({} as any);
  const renderer = new PanelHtmlRenderer(sections);
  return renderer.render(String(Date.now()));
}
```

### 6.4 样式/脚本分离细节
- `styles/base.css.ts`：导出 `baseCss`，内容为现有 `:root` / `*` / `body / h2` 等 100 行，保持 `String.raw` 不转义。
- `styles/layout.css.ts`：导出 `layoutCss`，含 `.app-shell / #cardDeck / .resourceTree / .workbenchInspector`。
- `scripts/tmux.ts`：`getTmuxWindowCandidates / renderTmuxFilterBar / refreshTmuxList` 等 400 行，需特别注意 `classifyTmuxWindow` 中无正则裸 `\`，属安全区。
- `scripts/renderers.ts`：所有 `render*` 函数，涉及的正则如 `/\s+/` 必须在源码中写作 `/\\s+/`，由 `escaper` 最终去重验证。

---

## 7. 向后兼容与渐进式迁移

### 7.1 兼容策略
1. **导出路径兼容**：`src/extension.ts` 保留 3 个版本周期，仅做 `export * from './extension/activate'` 转发，内部 `provider` 变量指向新 Provider，避免外部 `import { RealtimeTunnelPanelProvider } from '../extension'` 断裂。
2. **`renderPanelHtml` 签名不变**：`PanelHtml.ts` 门面保持 `export function renderPanelHtml(): string` 签名，所有调用方（`extension/provider/*`、`PanelBootstrap`）无需改动。
3. **状态存储键不变**：`keys.tunnelConfig / setupConfig` 等 `globalState` 键名保持不变，新 Provider 读写同一键，支持降级回退只需切回旧 Provider。
4. **Webview 消息协议不变**：`SAFE_WEBVIEW_COMMANDS / API_EXECUTABLE_COMMANDS` 等白名单集合移入 `CommandFactory` 的 `commandManifest`，但运行时校验逻辑保持原样，前后端不需同步发布。

### 7.2 特性开关
- 新增 `simpleExperiment.experiments.factoryRefactor` 配置（default `false`），`activate()` 中 `if (factoryEnabled) use NewProvider else use LegacyProvider`，灰度 1–2 周后默认 `true`，再 1 版本后移除旧实现。

---

## 8. 迁移步骤（分 4 阶段，6 周）

### Phase 0：基线与防护（Week 1）
| 任务 | 文件 | 产出 |
|---|---|---|
| 建立 `PanelTemplateEscaper` + `vm.Script` 门禁 | `src/ui/PanelTemplateEscaper.ts`, `scripts/build` 增加 `node -e "new (require('vm').Script)(...)"` | P0 防护就绪 |
| 生成 `commandManifest` | `scripts/generate-command-manifest.js` → `src/generated/commandManifest.ts` | 命令单源 |
| 增加 `tunnel/noHardcodedPort.test.js` | `test/tunnel/noHardcodedPort.test.js` | `grep -r "10890"` 零命中门禁 |
| 冻结 `extension.ts` / `PanelHtml.ts` 行数基线 | `docs/metrics.md` | 后续 diff 参照 |

### Phase 1：工厂骨架（Week 2）
| 任务 | 文件 | 产出 |
|---|---|---|
| 实现 `factories/types.ts / ServiceFactory / TunnelFactory / RealtimeClientFactory` | `src/factories/*` | 工厂接口 + 默认实现（内部仍委托旧函数） |
| `TunnelFactory` 接管 `normalizeTunnelGatewayConfig / localBaseUrl / detectPortConflicts` | `src/factories/TunnelFactory.ts` | 旧 Provider 中的 6 个 `current*` 方法改为 `this.serviceFactory.tunnel.detectPortConflicts()` |
| 单测：`test/factories/tunnelFactory.test.js` | `test/factories/*` | `createPortAllocator` / `resolveEndpointUrl` 覆盖 |
| 验证 | `npm run build` + `vm.Script` | 零回归 |

### Phase 2：extension.ts 拆分（Week 3–4）
| 步骤 | 操作 | 风险控制 |
|---|---|---|
| 2a | 抽 `ProviderState`（字段区） | 纯移动，无逻辑变更，`git diff --stat` 校验仅文件搬移 |
| 2b | 抽 `ProviderTunnel` + `ProviderRealtime` | 每个方法抽离后在旧类中保留 `// @deprecated` 转发，`Provider` 通过组合调用 |
| 2c | 抽 `ProviderSnapshot`（最大风险） | 要求 `npm run test:scenarios` 全绿；`buildState()` 增加快照对比测试 `stateSnapshot.test.js` |
| 2d | 抽 `activate.ts` + `CommandFactory` | `package.json#contributes.commands` 38 项逐项核对，`commandPalette` 的 `when` 保持不变 |
| 2e | `extension.ts` 缩为 <100 行转发层 | `node -c dist/extension.js && node -c dist/ui/PanelHtml.js` 必过 |

### Phase 3：PanelHtml.ts 拆分（Week 4–5）
| 步骤 | 操作 | 风险控制 |
|---|---|---|
| 3a | 抽 `styles/*` 3 文件 | 样式文件不经过模板转义，`PanelHtmlRenderer` 拼接后目视验证 + 截图对比 |
| 3b | 抽 `sections/*` 9 文件（HTML） | 每个 Section 独立 `renderHtml()`，`PanelHtml.ts` 门面 `createAll()` 排序与原 `order` 一致 |
| 3c | 抽 `scripts/tmux.ts` + `scripts/renderers.ts` | 正则裸 `\` 批量替换为 `\\`，`scripts/lint-smoke.js` 增加 `Select-String -Pattern 'return.*<script>'` 扫描 |
| 3d | 接入 `PanelTemplateEscaper` + `vm.Script` 双重校验 | 任何新增 `renderScript()` 未过门禁即 CI 失败 |
| 3e | `PanelHtml.ts` 缩为门面 | `dist/ui/PanelHtml.js` 大小对比，原 14k 行模板不再存在 |

### Phase 4：Feature/Service 收敛与清理（Week 6）
| 任务 | 文件 | 产出 |
|---|---|---|
| 实现 `FeatureFactory` + `adapters/*` | `src/factories/FeatureFactory.ts`, `src/features/adapters/*` | `uiActionCommands` 映射收敛到工厂 |
| 接入 `OperationQueue` 统一入口 | `src/features/adapters/*` 的 `queueSpec()` | 原 `actionCommandMap / directWorkerActionMap` 分支收敛 |
| 实现 `UiFactory` | `src/factories/UiFactory.ts` | `WebviewBridge / UiStateMapper` 创建统一 |
| 删除 `ProviderLegacy.ts` / 旧转发 | `src/extension.ts` 彻底移除 | 最终 `extension.ts` 仅 `export * from './extension/activate'` |
| 文档与 ADR | `docs/adr/004-factory-refactor.md` | 记录决策与回退方案 |

---

## 9. 风险与回退方案

### 9.1 风险矩阵

| 风险 | 影响 | 概率 | 缓解 | 回退 |
|---|---|---|---|---|
| **P0-模板剥离回归**：新 `renderScript()` 误写裸 `\s` 导致面板白屏 | 高 | 中 | `PanelTemplateEscaper` + `vm.Script` 双重门禁 + `lint-smoke.js` 扫描 `/"\` / `/\s` 裸写 | 回退到 `PanelHtml.legacy.ts` 门面，特性开关切 `false` |
| **隧道端口回退硬编码**：工厂内误用 `10890` 字面量 | 高 | 低 | `TunnelFactory` 唯一创建点 + `noHardcodedPort` 测试零命中 | 回退到 `TunnelGateway.defaultTunnelGatewayConfig` 单源 |
| **Provider 拆分导致状态不一致**：`buildState()` 聚合 `gpu / schedulerStates / experimentTraces` 的合并顺序错误 | 高 | 中 | 增加 `stateSnapshot.test.js` 基线对比（迁移前后 `buildState()` 对同一 `RealtimeState` 输出 diff 为 0） | 特性开关切回 `LegacyProvider`，保留 `ProviderState` 字段兼容 |
| **命令注册遗漏**：38 个命令中有 1 个未在 `CommandFactory` 注册导致 `command not found` | 中 | 中 | `commandManifest` 自动生成 + 启动期 `assertCommandCount(38)` | `extension.ts` 保留旧 `registerCommand` 作为兜底，启动时双注册校验 |
| **Factory 循环依赖**：`ServiceFactory` ↔ `TunnelFactory` ↔ `RealtimeClientFactory` | 中 | 低 | `FactoryContext` 只传值不传工厂实例，工厂间通过 `ctx.clusterStore` 间接依赖 | 拆 `FactoryContext` 为 `ReadModelContext` / `WriteModelContext` |
| **变更过大导致 review 困难** | 中 | 高 | 按 Phase 提交 PR，每 PR <600 行增量，`git diff --stat` 可追溯 | 按 Phase 回退单个 PR，不影响其他 Phase |

### 9.2 回退步骤（任意 Phase 失败）
1. `simpleExperiment.experiments.factoryRefactor` 配置设为 `false`，重启 VS Code 即回退到 Legacy 实现。
2. `git revert <phase-commit>` 单独回退该 Phase 的工厂引入，`extension.ts` 转发层自动回指旧实现。
3. `npm run build && node -c dist/extension.js && node -c dist/ui/PanelHtml.js` 验证通过后发布补丁版本 `0.4.93`。

### 9.3 验证门禁（每 Phase 必跑）

```bash
npm run build                         # 内置 node -c 双重校验
node -e "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8'))"
npm run test:xshell-realtime          # 隧道/实时流
npm run test:multi-tunnel             # 多端点/端口分配
npm run test:port-allocation          # 端口冲突
npm run test:hub-worker-boundary      # Hub/Worker 边界
npm run test:no-direct-ssh            # 禁止直连 SSH
# 新增
npm run test:factory                  # 工厂单测（Phase 1 起）
Select-String -Pattern "10890" src/**  # 零命中（P0）
Select-String -Pattern "return.*<script>" src/ui/** # 检查裸 \
```

---

## 10. 工厂扩展指南（后续新增产品）

- 新增 Feature：仅需在 `FeatureKind` 追加 `myFeature`，在 `src/features/adapters/MyFeatureHandler.ts` 实现 `FeatureHandler`，在 `FeatureFactory` 的 `switch` 中注册，无需改 `extension.ts`。
- 新增 Panel Section：继承 `PanelSection`，在 `PanelSectionFactory.createAll()` 的 `order` 数组中插入新 `SectionId`，`PanelHtmlRenderer` 自动拼接。
- 新增隧道类型：扩展 `TunnelFactory` 的 `createLauncher()` 策略分支，`RealtimeClientFactory` 无需感知。

---

## 11. 决策记录（ADR 摘要）

| 决策 | 选择 | 备选 | 理由 |
|---|---|---|---|
| 工厂实现风格 | 抽象工厂 + 工厂方法 | 纯 DI 容器（Inversify） | VS Code 扩展对启动体积敏感，引入容器增加 40k 打包体积；抽象工厂零依赖 |
| Provider 拆分策略 | 组合（Composition） | Mixin/继承 | 避免 `this` 绑定与初始化顺序陷阱，支持独立单测 |
| PanelHtml 拆分粒度 | 9 Section + 3 Style + 4 Script | 单文件按行切 4 段 | 按语义切更利于 P0 门禁（正则扫描可按 Section 定点） |
| 兼容期 | 3 版本 | 1 版本直接删除 | 运营期项目需平滑升级，保留门面转发成本低（<100 行） |

---

## 12. 附录：关键指标与交付清单

- **拆分后文件数**：119 → ~135（新增 16 工厂/Section/样式文件），`extension.ts` 单文件行数 22260 → <100（门面），Provider 子文件均 <600。
- **工厂文件清单**：`ServiceFactory / TunnelFactory / RealtimeClientFactory / FeatureFactory / CommandFactory / PanelSectionFactory / UiFactory` 共 7 工厂 + `PanelTemplateEscaper`。
- **P0 校验**：`npm run build` + `vm.Script` + `noHardcodedPort` 三重门禁。
- **交付物**：
  - 本方案文档 `docs/architecture-factory-refactor-plan.md`
  - Phase 0 的 `PanelTemplateEscaper.ts` + `commandManifest` 生成脚本
  - 后续每 Phase 的 PR 与 `test/factories/*` 单测

> 本方案不直接修改业务逻辑，所有工厂首版均为“门面委托”实现，确保 `git diff` 首周仅移动代码，零行为变更；行为变更集中在 Phase 4 的 `FeatureFactory.queueSpec()` 统一收敛。

---

*本轮产出会话引用：<本实例真实 sessionId>/<真实 messageId>（系统分配，Part.sessionID/Message.id），供下游通过 session.messages 拉取全量*  
*注：本实例为一次性临时 Agent，任务结束即回收；下游 review 需通过 session.messages 校验全量内容，不得依赖提示词粘贴。*
