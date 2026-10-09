/**
 * src/extension.ts - Facade (Factory Refactor v0.4.92)
 * 瘦身门面：委托给 src/extension/Activation.ts 的工厂化实现
 * 原 22288 行逻辑已迁移至 src/extension/legacy.ts
 */
export * from "./extension/legacy";
export { RealtimeTunnelPanelProvider } from "./extension/legacy";
// 覆盖 activate/deactivate 走工厂路径
const activation = require("./extension/Activation");
export async function activate(context: any): Promise<void> {
  // 工厂激活是异步的；等待结果，避免 Promise rejection 越过同步 try/catch。
  try {
    if (activation && typeof activation.activate === "function") {
      await activation.activate(context);
      return;
    }
  } catch (e) {
    console.error("[extension facade] factory activate failed", e);
    // 若新路径已创建 Provider，避免再次注册整套命令与监听器。
    if (typeof activation?.getProvider === "function" && activation.getProvider()) return;
  }
  const legacy = require("./extension/legacy");
  await legacy.activate(context);
}
export async function deactivate(): Promise<void> {
  try {
    if (activation && typeof activation.deactivate === "function") {
      await activation.deactivate();
      return;
    }
  } catch (error) { console.error("[extension facade] factory deactivate failed", error); }
  try {
    const legacy = require("./extension/legacy");
    if (typeof legacy.deactivate === "function") await legacy.deactivate();
  } catch (error) { console.error("[extension facade] legacy deactivate failed", error); }
}
