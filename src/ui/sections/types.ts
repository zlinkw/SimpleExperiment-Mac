/**
 * Section 接口定义 - PanelHtml 模块化拆分 Phase 3
 * 对齐 src/factories/PanelSectionFactory.ts 的 PanelSection 约定
 */
export interface Section {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  renderHtml(state?: unknown): string;
  renderCss(): string;
  renderScript(): string;
}

export interface SectionDeps {
  escaper?: { escapeForOuterTemplate(s: string): string };
}

export type SectionFactory = (deps?: SectionDeps) => Section;
