import * as fs from "node:fs";
import * as path from "node:path";
import { callApi } from "./api";
import { businessError, envError } from "./errors";
import type { CliFlags } from "./parse";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw businessError("Invalid workflow API response");
  return value as Record<string, unknown>;
}

export function assertProjectPlan(root: string, planFile: string): string {
  const canonicalRoot = fs.realpathSync(root);
  const absolute = path.isAbsolute(planFile) ? planFile : path.resolve(root, planFile);
  const canonicalPlan = fs.realpathSync(absolute);
  const relative = path.relative(canonicalRoot, canonicalPlan);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)
    || !fs.statSync(canonicalPlan).isFile()) throw businessError("Plan must be a file inside the current project");
  return canonicalRoot;
}

export async function requestWorkflowRun(root: string, planFile: string, flags: Pick<CliFlags, "seed" | "dryRun" | "check">): Promise<{ code: number; payload: Record<string, unknown> }> {
  if (flags.seed !== undefined) throw businessError("workflow 不支持 seed 覆盖；请在已保存的 Plan 中配置 seeds，移除 --seed 后重新预检。");
  const canonicalRoot = assertProjectPlan(root, planFile);
  const verifyWorkspace = async () => {
    const status = record(await callApi("status"));
    if (typeof status.workspace !== "string" || !status.workspace || !fs.existsSync(status.workspace)
      || fs.realpathSync(status.workspace) !== canonicalRoot) throw envError("CLI project differs from the current VS Code API workspace; open the intended project before running a Plan");
  };
  await verifyWorkspace();
  const params = { planFile, workspace: canonicalRoot, seed: flags.seed, debugMode: false };
  const route = record(await callApi("workflow.plan", params));
  const selected = route.plan && typeof route.plan === "object" ? route.plan as Record<string, unknown> : {};
  if (route.ok === true && route.ready === true) {
    if (typeof selected.planFile !== "string" || selected.planFile !== planFile) throw businessError("Workflow selected a different Plan; no run requested");
  }
  const base = { planFile, seed: flags.seed || "", dryRun: flags.dryRun, submitted: false, requested: false, runner: "SimpleExperiment Local API", submitPath: "workflow.run", workflow: route, validation: "live_api", ready: route.ok === true && route.ready === true };
  if (route.ok !== true || route.ready !== true) return { code: 3, payload: { ...base, status: "blocked", nextAction: route.nextAction, blocker: route.blocker } };
  if (flags.dryRun || flags.check) return { code: 0, payload: { ...base, status: "preflight_ready" } };
  await verifyWorkspace();
  const result = record(await callApi("workflow.run", params));
  // workflow.run starts a local operation that still requires VS Code approval.
  // Remote submission evidence belongs to operations.list, not this initial receipt.
  const requested = result.ok === true && result.started === true && typeof result.operationId === "string" && Boolean(result.operationId);
  return { code: requested ? 0 : 3, payload: { ...base, requested, submitted: false, result, operationId: result.operationId, status: result.status || "blocked", confirmation: result.confirmation || "none", nextAction: result.nextAction || "operations.list" } };
}
