/**
 * PanelSectionFactory - 面板 Section 工厂
 * 管理 10 个板块的 HTML/CSS/JS 切片，负责排序与外层模板转义门禁接入
 * 遵循 docs/architecture-factory-refactor-plan.md §3.7
 */

import type { FactoryContext } from "./types";
import { PanelTemplateEscaper } from "../ui/PanelTemplateEscaper";

function tryRequire<T>(id: string): T | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch {
    return undefined;
  }
}

type SectionsMod = {
  createSectionById?: (id: SectionId) => unknown;
  createAllSections?: () => unknown[];
};

function getSectionsMod(): SectionsMod | undefined {
  return tryRequire<SectionsMod>("../ui/sections");
}

// 目标序：sync1/plans2/gpu3/tmux4/execution5/results6/diagnostics7/settings8（settings 恒尾）；
// servers/operations 仅为老布局兼容保留（deprecated），运行时以 legacy RESOURCE 为准
export type SectionId =
  | "sync"
  | "plans"
  | "gpu"
  | "tmux"
  | "execution"
  | "results"
  | "diagnostics"
  | "settings"
  | "servers"
  | "operations";

export interface PanelSection {
  readonly id: SectionId;
  readonly order: number;
  readonly title: string;
  readonly icon: string;
  renderHtml(state: unknown): string;
  renderCss(): string;
  renderScript(): string;
  readonly clientEvents?: ReadonlyArray<{ event: string; handler: string }>;
}

export interface PanelSectionFactory {
  create(id: SectionId, ctx: FactoryContext): PanelSection;
  createAll(ctx: FactoryContext): PanelSection[];
  createByName(name: string, ctx: FactoryContext): PanelSection | undefined;
  readonly escaper: PanelTemplateEscaper;
}

const SECTION_DEFS: ReadonlyArray<{ id: SectionId; order: number; title: string; icon: string }> = [
  { id: "sync", order: 1, title: "运行环境准备", icon: "🔄" },
  { id: "plans", order: 2, title: "计划", icon: "📋" },
  { id: "gpu", order: 3, title: "GPU", icon: "🎮" },
  { id: "tmux", order: 4, title: "TMUX", icon: "🖥" },
  { id: "execution", order: 5, title: "执行", icon: "▶" },
  { id: "results", order: 6, title: "结果", icon: "📊" },
  { id: "diagnostics", order: 7, title: "诊断", icon: "🩺" },
  { id: "settings", order: 8, title: "设置", icon: "⚙" },
  // deprecated：老布局兼容保留，不参与目标序
  { id: "servers", order: 90, title: "服务器", icon: "🖥" },
  { id: "operations", order: 91, title: "操作", icon: "⚡" },
];

type SectionLike = {
  id: unknown;
  order: unknown;
  title: unknown;
  icon?: unknown;
  clientEvents?: unknown;
  renderHtml?: unknown;
  renderCss?: unknown;
  renderScript?: unknown;
};

function toPanelSection(s: unknown): PanelSection {
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("Panel section implementation is not an object.");
  const rec = s as SectionLike;
  if (typeof rec.renderHtml !== "function" || typeof rec.renderCss !== "function" || typeof rec.renderScript !== "function")
    throw new Error(`Panel section ${String(rec.id || "unknown")} is missing a required renderer.`);
  if (typeof rec.id !== "string" || !SECTION_DEFS.some((item) => item.id === rec.id)
    || !Number.isFinite(Number(rec.order)) || typeof rec.title !== "string")
    throw new Error("Panel section metadata is invalid.");
  return {
    id: rec.id as SectionId,
    order: rec.order as number,
    title: rec.title as string,
    icon: (rec.icon as string) || "",
    clientEvents: (rec.clientEvents as ReadonlyArray<{ event: string; handler: string }>) || undefined,
    renderHtml: (state: unknown) => (rec.renderHtml as (st: unknown) => string)(state),
    renderCss: () => (rec.renderCss as () => string)(),
    renderScript: () => (rec.renderScript as () => string)(),
  } as PanelSection;
}

function validateCustomSection(section: PanelSection, expectedId?: SectionId): PanelSection {
  if (!section || typeof section !== "object" || !SECTION_DEFS.some((item) => item.id === section.id)
    || expectedId && section.id !== expectedId || !Number.isFinite(Number(section.order))
    || typeof section.title !== "string" || typeof section.renderHtml !== "function"
    || typeof section.renderCss !== "function" || typeof section.renderScript !== "function")
    throw new Error(`Panel section ${expectedId || String((section as any)?.id || "unknown")} is incomplete; refusing an empty renderer.`);
  return section;
}

export class DefaultPanelSectionFactory implements PanelSectionFactory {
  public readonly escaper: PanelTemplateEscaper;
  private readonly deps: Record<string, unknown>;
  constructor(deps: Record<string, unknown> = {}, escaper?: PanelTemplateEscaper) {
    this.deps = deps;
    this.escaper = escaper || new PanelTemplateEscaper();
  }

  create(id: SectionId, _ctx: FactoryContext): PanelSection {
    const def = SECTION_DEFS.find((s) => s.id === id);
    if (!def) throw new Error(`Unknown section: ${id}`);
    // 1. 若 deps 中有定制 Section，优先使用
    const custom = (this.deps["sections"] as Record<string, PanelSection> | undefined)?.[id];
    if (custom) return validateCustomSection(custom, id);
    // 2. 尝试真实 Section（逐个导入/聚合导入）
    const sectionsMod = getSectionsMod();
    if (sectionsMod) {
      if (typeof sectionsMod.createSectionById === "function") {
        const real = sectionsMod.createSectionById(id);
        if (real) return toPanelSection(real);
      }
      if (typeof sectionsMod.createAllSections === "function") {
        const all = sectionsMod.createAllSections() as unknown[];
        const found = all.find((x) => (x as SectionLike).id === id);
        if (found) return toPanelSection(found);
      }
    }
    throw new Error(`Panel section ${id} implementation is unavailable; refusing to render an empty section.`);
  }

  createAll(_ctx: FactoryContext): PanelSection[] {
    // 优先尝试真实 Sections 聚合
    const sectionsMod = getSectionsMod();
    if (sectionsMod && typeof sectionsMod.createAllSections === "function") {
      const realSections = sectionsMod.createAllSections() as unknown[];
      if (!Array.isArray(realSections)) throw new Error("Panel section bundle returned an invalid collection.");
      const customMap = (this.deps["sections"] as Record<string, PanelSection> | undefined) || {};
      const byId = new Map<string, PanelSection>();
      for (const item of realSections) {
        const mapped = toPanelSection(item);
        byId.set(mapped.id, mapped);
      }
      for (const [id, section] of Object.entries(customMap)) byId.set(id, validateCustomSection(section, id as SectionId));
      const required = SECTION_DEFS.filter((item) => item.id !== "servers" && item.id !== "operations");
      const missing = required.filter((item) => !byId.has(item.id)).map((item) => item.id);
      if (missing.length) throw new Error(`Panel section bundle missing implementations: ${missing.join(", ")}.`);
      return [...byId.values()].sort((a, b) => a.order - b.order);
    }
    const customMap = (this.deps["sections"] as Record<string, PanelSection> | undefined) || {};
    for (const [id, section] of Object.entries(customMap)) validateCustomSection(section, id as SectionId);
    const required = SECTION_DEFS.filter((item) => item.id !== "servers" && item.id !== "operations");
    const missing = required.filter((item) => !customMap[item.id]).map((item) => item.id);
    if (missing.length) throw new Error(`Panel section implementations unavailable: ${missing.join(", ")}.`);
    return Object.values(customMap).sort((a, b) => a.order - b.order);
  }

  createByName(name: string, ctx: FactoryContext): PanelSection | undefined {
    const def = SECTION_DEFS.find((s) => s.id === name);
    if (!def) return undefined;
    return this.create(def.id, ctx);
  }
}
