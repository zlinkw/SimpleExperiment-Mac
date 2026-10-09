export type PanelLifecycleState = "detached" | "booting" | "ready" | "maintenance" | "reload_required" | "recovering" | "degraded" | "disposed";

const TRANSITIONS: Record<PanelLifecycleState, readonly PanelLifecycleState[]> = {
  detached: ["booting", "disposed"],
  booting: ["ready", "maintenance", "reload_required", "recovering", "degraded", "detached", "disposed"],
  ready: ["booting", "maintenance", "reload_required", "recovering", "degraded", "detached", "disposed"],
  maintenance: ["ready", "reload_required", "degraded", "detached", "disposed"],
  reload_required: ["disposed"],
  recovering: ["booting", "ready", "maintenance", "reload_required", "degraded", "detached", "disposed"],
  degraded: ["booting", "ready", "maintenance", "reload_required", "recovering", "detached", "disposed"],
  disposed: [],
};

export function transitionPanelLifecycle(current: PanelLifecycleState, next: PanelLifecycleState): { state: PanelLifecycleState; changed: boolean; allowed: boolean } {
  if (current === next) return { state: current, changed: false, allowed: true };
  if (!TRANSITIONS[current]?.includes(next)) return { state: current, changed: false, allowed: false };
  return { state: next, changed: true, allowed: true };
}
