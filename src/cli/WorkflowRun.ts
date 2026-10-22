import * as fs from "node:fs";
import * as path from "node:path";
import { callApi } from "./api";
import { businessError, envError } from "./errors";
import { bindWorkflowWorkspace, assertWorkflowWorkspace, assertPlanSeedContract } from "../features/WorkflowWorkspaceBinding";
import type { CliFlags } from "./parse";
function record(value: unknown): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) throw businessError("Invalid workflow API response"); return value as Record<string, any>; }
export function assertProjectPlan(root: string, file: string): string {
  const canonical = fs.realpathSync.native(root), target = fs.realpathSync.native(path.resolve(root, file)), relative = path.relative(canonical, target);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep) || !fs.statSync(target).isFile()) throw businessError("Plan must be a file inside the current project");
  return canonical;
}
export async function requestWorkflowRun(root: string, planFile: string, flags: Pick<CliFlags, "seed" | "dryRun" | "check" | "operation">): Promise<{ code: number; payload: Record<string, unknown> }> {
  assertPlanSeedContract(flags as unknown as Record<string, unknown>);
  const canonical = assertProjectPlan(root, planFile), binding = bindWorkflowWorkspace(canonical, canonical);
  const verify = async () => {
    const state = record(await callApi("status"));
    try { bindWorkflowWorkspace(state.workspace, binding.root); assertWorkflowWorkspace(binding, state.workspace); }
    catch { throw envError("CLI project differs from the current VS Code API workspace; open the intended project"); }
  };
  await verify();
  if (flags.operation && (flags.dryRun || flags.check)) throw businessError("--operation cannot resume a read-only preview");
  const params = { planFile, workspace: canonical, debugMode: false, ...(flags.operation ? { operationId: flags.operation } : {}) };
  const preview = Boolean(flags.dryRun || flags.check);
  // workflow.run already invokes the server's workflow.plan, including all normal preflight steps.
  const route = record(await callApi(preview ? "workflow.plan" : "workflow.run", params));
  const normalize = (v: string) => process.platform === "win32" ? v.replace(/\\/g, "/").toLowerCase() : v;
  if (route.plan?.planFile && normalize(route.plan.planFile) !== normalize(planFile)) throw businessError("Workflow selected a different Plan; no further action requested");
  assertWorkflowWorkspace(binding, canonical);
  const accepted = route.started === true || !!flags.operation && typeof route.operationId === "string";
  const base = { planFile, dryRun: flags.dryRun, submitted: false, requested: false, runner: "SimpleExperiment Local API", submitPath: "workflow.run", workflow: route, validation: "live_api", ready: route.ok === true && (preview ? route.ready === true : accepted) };
  if (!base.ready) return { code: 3, payload: { ...base, status: "blocked", blocker: route.blocker, nextAction: route.nextAction } };
  if (preview) return { code: 0, payload: { ...base, status: "preflight_ready" } };
  const result = route, requested = result.ok === true && accepted && typeof result.operationId === "string" && Boolean(result.operationId);
  return { code: requested ? 0 : 3, payload: { ...base, requested, result, operationId: result.operationId, status: result.status || "blocked", confirmation: result.confirmation || "none", nextAction: result.nextAction || "operations.list" } };
}
