import { createHash } from "node:crypto";

export type PlanExecutionMode = "train" | "test" | "train_test";

/** The validation result is authoritative. Never silently widen an unknown mode. */
export function requirePlanExecutionMode(value: unknown): PlanExecutionMode {
  if (value === "train" || value === "test" || value === "train_test") return value;
  throw new Error("Plan execution mode is unverified; validate this exact Plan revision before dispatch.");
}

/** Legacy queues may use a local PLAN only when its original content hash still matches. */
export function modeFromMatchingPlan(revision: string, text: string, parsedMode: unknown): PlanExecutionMode | undefined {
  if (createHash("sha256").update(text, "utf8").digest("hex") !== revision) return undefined;
  try { return requirePlanExecutionMode(parsedMode); } catch { return undefined; }
}
