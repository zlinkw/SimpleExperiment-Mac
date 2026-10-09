/**
 * src/features/Results.ts - Facade
 * 原 1595 行已迁移至 Results.legacy.ts，按需委托 ResultsFactory
 * 兼容门面只透传旧 API；新建逻辑由显式注入的工厂负责，不在模块加载时吞掉导入失败。
 */
export * from "./Results.legacy";
