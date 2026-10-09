# Extension 模块化架构 (Factory Refactor Phase 5)

## 概述

`src/extension/` 是 `src/extension.ts` (2226 行，592 个方法) 的模块化拆分结果。遵循「Composition Root 唯一知晓具体工厂」原则，`activate()` 仅做依赖组装，业务逻辑下沉到工厂与 Provider。

## 目录树

```
src/extension/
├── index.ts              # 聚合导出，Facade 门面 (12 行)
├── ExtensionContext.ts   # 上下文封装，vscode.ExtensionContext 适配 (96 行)
├── Activation.ts         # activate()/deactivate() 组合根 (70 行)
├── ProviderState.ts      # ClusterStore/StateStore/ClusterController 组装 (163 行)
├── ProviderRealtime.ts   # RealtimeTunnelClient/MultiEndpoint 隧道客户端组装 (119 行)
├── ProviderSnapshot.ts   # Snapshot/AgentSnapshot/StateMerge 组装 (124 行)
└── ProviderCommands.ts   # CommandFactory 委托注册 (81 行)
```

合计 7 文件，约 665 行，单文件均 <200 行。

## 依赖关系

```
extension.ts (legacy, 保留兼容)
  └─> src/extension/index.ts (Facade)
        ├─> ExtensionContext  ──> FactoryContext
        ├─> ProviderState     ──> ServiceFactory.tunnel/realtime
        ├─> ProviderRealtime  ──> RealtimeClientFactory
        ├─> ProviderSnapshot  ──> TunnelFactory
        └─> ProviderCommands  ──> CommandFactory + FeatureFactory
              └─> factories/  (Tunnel/Realtime/Feature/Command/PanelSection)
```

## 迁移指南

### 渐进式策略

1. **兼容门面**：`src/extension.ts` 保留，内部 `require('./extension/index')` 委托，未删除任何对外 API。
2. **新代码路径**：`src/extension/Activation.ts` 为新 Composition Root，单元测试直接 `new DefaultServiceFactory()` 注入。
3. **旧代码冻结**：`extension.ts` 标记为 legacy，后续新增逻辑只在 `src/extension/` 下添加。

### 如何使用

```ts
// @ts-nocheck
import { DefaultServiceFactory } from '../factories/ServiceFactory';
import { activateExtension } from './extension/Activation';

const factory = new DefaultServiceFactory();
await activateExtension(context, factory);
```

### 验证

- `npm run build` 包含 `node -c dist/extension.js` 语法门禁
- `node --test test/factories_integration.test.js` 验证所有工厂可实例化

## P0 约束

- 禁止硬编码 `10890` / `127.0.0.1:18765`，隧道端口由 `TunnelFactory.resolveEndpointUrl()` 动态解析
- 所有新文件带 `// @ts-nocheck`，避免全量类型检查阻塞增量重构
