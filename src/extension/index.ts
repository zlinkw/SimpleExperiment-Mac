/**
 * src/extension/index.ts - 聚合导出 (Phase 2)
 * 新模块化层的统一入口，保持 extension.ts 作为兼容门面可运行
 */

export * from "./ExtensionContext";
export * from "./ProviderState";
export * from "./ProviderRealtime";
export * from "./ProviderSnapshot";
export * from "./ProviderCommands";
export * from "./Activation";
