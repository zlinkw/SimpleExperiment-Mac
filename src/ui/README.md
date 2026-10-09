# UI / PanelHtml 模块化架构 (Factory Refactor Phase 5)

## 概述

`src/ui/PanelHtml.ts` (15275 行，925 行 `renderPanelHtml()`) 是全项目最大单文件，内含 CSS+HTML+JS 混合模板，且受 P0 外层模板剥离坑影响（`\s` `\d` `\n` 被外层 `` `...` `` 吞噬）。本轮将其拆分为 Section 工厂 + Renderer + Escaper 三层。

## 目录树

```
src/ui/
├── PanelHtml.ts              # legacy 保留 (15275 行)，待逐步委托
├── PanelHtmlRenderer.ts      # 渲染器，委托 PanelSectionFactory (80 行)
├── PanelTemplateEscaper.ts   # P0 转义门禁，escapeForOuterTemplate + vm.Script (73 行)
├── PanelBootstrap.ts         # Webview 启动脚本 (25 行)
├── PanelRecoveryHtml.ts      # 恢复页 (6 行)
├── WebviewBridge.ts          # 消息桥接 (27 行)
├── WebviewRenderState.ts     # 渲染状态 (328 行)
├── UiStateMapper.ts          # 状态映射 (25 行)
├── sections/
│   ├── index.ts              # Section 聚合导出 (65 行)
│   ├── types.ts              # SectionId/PanelSection 接口 (19 行)
│   ├── OverviewSection.ts    # 总览 (39 行)
│   ├── PlansSection.ts       # 计划 (68 行)
│   ├── ResultsSection.ts     # 结果 (59 行)
│   ├── ExecutionSection.ts   # 执行 (55 行)
│   ├── ServersSection.ts     # 服务器 (37 行)
│   ├── SettingsSection.ts    # 设置 (60 行)
│   ├── GpuSection.ts         # GPU (42 行)
│   ├── SyncSection.ts        # 同步 (39 行)
│   ├── DiagnosticsSection.ts # 诊断 (61 行)
│   └── TmuxSection.ts        # Tmux (61 行)
└── styles/
    ├── base.css.ts           # 基础样式 (46 行)
    ├── components.css.ts     # 组件样式 (33 行)
    └── layout.css.ts         # 布局样式 (34 行)
```

Section 均 <70 行，Renderer <100 行，仅 WebviewRenderState 328 行（含大量状态机，需后续再拆）。

## 架构图

```
PanelHtml.ts (legacy Facade)
  └─> PanelHtmlRenderer
        ├─> PanelSectionFactory.createAll(ctx)  -> PanelSection[10]
        │     ├─ Overview / Plans / Results / Execution ...
        │     └─ renderHtml() / renderCss() / renderScript()
        ├─> PanelTemplateEscaper.escapeForOuterTemplate(rawJs)
        └─> PanelTemplateEscaper.validateVmScript(safeJs)  // P0 门禁

styles/base.css.ts + components.css.ts + layout.css.ts
  └─> 各 Section.renderCss() 聚合
```

## P0 外层模板剥离坑

**根因**：`src/ui/PanelHtml.ts` 最外层是 `` return `...<script>...` `` 模板字符串，内层 JS 的 `\s` `\d` `\n` 会被外层预解析为转义序列，落盘后正则损坏。

**正确写法 (二选一)**：

1. 双写转义：`/\\s+/` `/\\d{4}-\\d{2}-\\d{2}/` `"\\n"`
2. `String.fromCharCode(10)` 替代 `"\n"`

**门禁**：

```bash
npm run build  # 内置 node -c dist/extension.js && node -c dist/ui/PanelHtml.js
node -e "new (require('vm').Script)(require('fs').readFileSync('dist/ui/PanelHtml.js','utf8'))"
```

所有经由 `PanelHtmlRenderer` 的脚本必须先过 `PanelTemplateEscaper.escapeForOuterTemplate()`。

## 迁移指南

1. **兼容门面**：`PanelHtml.ts` 保留，对外 `renderPanelHtml()` 签名不变，内部逐步委托 `PanelHtmlRenderer`。
2. **新增 Section**：在 `src/ui/sections/` 新增文件，实现 `PanelSection` 接口，并在 `src/factories/PanelSectionFactory.ts` 的 `SECTION_DEFS` 注册。
3. **样式新增**：在 `src/ui/styles/` 新增或扩展，Section 通过 `renderCss()` 返回。

```ts
// @ts-nocheck
import { DefaultPanelSectionFactory } from '../factories/PanelSectionFactory';
import { PanelHtmlRenderer } from './PanelHtmlRenderer';

const factory = new DefaultPanelSectionFactory();
const renderer = new PanelHtmlRenderer(factory.createAll({}));
const html = renderer.render(nonce, state);
```

## 验证

- `npm run build` 双重校验：`node -c` + `vm.Script`
- `test/factories_integration.test.js` 验证 `PanelHtmlRenderer` 可渲染且转义正确
