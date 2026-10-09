/**
 * src/ui/WebviewRenderState.ts - Facade (RenderState Refactor v0.4.92)
 * 瘦身门面：re-export legacy 保持兼容，新增模块见 src/ui/renderState/
 * 原 328 行已拆分为 renderState/RenderStateTypes + Store + Mapper
 */
export * from "./WebviewRenderState.legacy";
