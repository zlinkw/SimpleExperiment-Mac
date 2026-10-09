/**
 * src/features/Quality.ts - Facade
 * 原 649 行已迁移至 Quality.legacy.ts，按需委托 QualityFactory
 * 兼容门面只透传旧 API；新建逻辑由显式注入的工厂负责，不在模块加载时吞掉导入失败。
 */
export * from "./Quality.legacy";
