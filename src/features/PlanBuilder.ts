/**
 * src/features/PlanBuilder.ts - Facade
 * 原 1884 行已迁移至 PlanBuilder.legacy.ts，按需委托 PlanBuilderFactory
 * 兼容门面只透传旧 API；新建逻辑由显式注入的工厂负责，不在模块加载时吞掉导入失败。
 */
export * from "./PlanBuilder.legacy";
