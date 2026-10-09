/**
 * sections/index - 聚合导出 + createAllSections 工厂
 * 供 PanelHtmlRenderer 聚合使用，保持与 PanelSectionFactory 兼容
 */
import type { Section } from "./types";
import { ServersSection } from "./ServersSection";
import { SyncSection } from "./SyncSection";
import { PlansSection } from "./PlansSection";
import { ResultsSection } from "./ResultsSection";
import { ExecutionSection } from "./ExecutionSection";
import { GpuSection } from "./GpuSection";
import { TmuxSection } from "./TmuxSection";
import { SettingsSection } from "./SettingsSection";
import { DiagnosticsSection } from "./DiagnosticsSection";

export type { Section } from "./types";
export { ServersSection } from "./ServersSection";
export { SyncSection } from "./SyncSection";
export { PlansSection } from "./PlansSection";
export { ResultsSection } from "./ResultsSection";
export { ExecutionSection } from "./ExecutionSection";
export { GpuSection } from "./GpuSection";
export { TmuxSection } from "./TmuxSection";
export { SettingsSection } from "./SettingsSection";
export { DiagnosticsSection } from "./DiagnosticsSection";

export function createAllSections(): Section[] {
  // 目标序：sync1/plans2/gpu3/tmux4/execution5/results6/diagnostics7/settings8；
  // servers 仅废弃兼容保留（order 90），运行时顺序以 legacy RESOURCE 为准
  const sections: Section[] = [
    new SyncSection(),
    new PlansSection(),
    new GpuSection(),
    new TmuxSection(),
    new ExecutionSection(),
    new ResultsSection(),
    new DiagnosticsSection(),
    new SettingsSection(),
    new ServersSection(),
  ];
  return sections.sort((a, b) => a.order - b.order);
}

export function createSectionById(id: string): Section | undefined {
  return createAllSections().find((s) => s.id === id);
}

/**
 * 适配 PanelSectionFactory 的 PanelSection 形状，供 PanelHtmlRenderer 使用
 */
export function toPanelSections(sections: Section[]): import("../../factories/PanelSectionFactory").PanelSection[] {
  return sections.map((s) => ({
    id: s.id as any,
    title: s.title,
    order: s.order,
    icon: "",
    renderHtml: (state: unknown) => s.renderHtml(state),
    renderCss: () => s.renderCss(),
    renderScript: () => s.renderScript(),
  }));
}

export const allSectionIds = ["sync","plans","gpu","tmux","execution","results","diagnostics","settings"] as const;
// 已废弃（兼容保留，不参与目标序）：servers, operations
