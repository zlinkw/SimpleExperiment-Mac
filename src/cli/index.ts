import { actionCommand } from "./commands/action";
import { controlCommand } from "./commands/control";
import { businessError } from "./errors";
import { planValidate } from "./commands/plan";
import { actionsListCommand, agentsLifecycleCommand, artifactCommand, compareEntry, draftCommand, experimentCommand, gpuCommand, logCommand, metricCommand, planCommand, planCleanupCommand, projectOpsCommand, projectStatus, resourceCommand, resultCommand, serverCommand } from "./commands";
import { asCliError, envError, EXIT_OK, jsonErrorBody, usageError } from "./errors";
import { optionalApi, callApi, setInstancePin } from "./api";
import { isExperimentProjectRoot, setProjectRoot, validProjectRoot } from "./data";
import { writeJson, writeText } from "./format";
import { doctorCommand, sftpCommand } from "./plugins";
import { domainHelp, SIMPLE_HELP } from "./help";
import { parseArgv } from "./parse";

// Old public entries revoked by user decision 2026-10-23 (no compatibility layer kept). Each prints an explicit refusal with the new path.
const REMOVED_ENTRIES: Record<string, string> = {
  api: "raw API passthrough removed: use the named domain commands (simpleex --help); live capability listing is printed by simpleex doctor and simpleex sftp capabilities",
  status: "old status stub removed: use simpleex project status",
  "self-check": "old self-check removed: use simpleex doctor",
  agent: "old agent health stub removed (it never reported live data): use simpleex experiment health or simpleex project status",
  experiments: "old experiments alias removed: use simpleex experiment list",
  metrics: "old metrics alias removed: use simpleex metric list | metric show <id> | metric leaderboard --file <metrics>",
  results: "old results alias removed: use simpleex result list | result parse --file <f> | result paper-table --file <registry.json>",
  run: "recorded local run removed: it executed arbitrary local commands outside the API. Experiment execution goes through simpleex experiment run (workflow.plan dry-run/upload then workflow.run); local metric/result analysis is available as metric leaderboard / result parse / result paper-table with --file",
};
const SIMPLE_DOMAINS = new Set(["project", "experiment", "plan", "result", "log", "metric", "compare", "gpu", "resource", "server", "artifact", "task", "draft", "agents", "actions", "sftp", "config", "state", "flow", "tmux", "panel"]);

export async function runSimpleCli(argv: string[]): Promise<number> {
  // Refuse revoked entries before generic parsing, so their pointer message survives odd flags.
  if (argv[0] && REMOVED_ENTRIES[argv[0]]) throw usageError(`removed entry: simpleex ${argv[0]}`, REMOVED_ENTRIES[argv[0]]);
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  const { positionals, flags } = parsed;
  // The explicit --instance flag outranks SIMPLE_CLI_INSTANCE_ID for every domain from here on.
  setInstancePin(flags.instance || "");
  const [domain, action, ...rest] = positionals;
  if (!domain || domain === "help" || (flags.help && !action)) {
    writeText(domain && (SIMPLE_DOMAINS.has(domain) || domain === "doctor") ? domainHelp(domain) : SIMPLE_HELP);
    return EXIT_OK;
  }
  if (flags.help) {
    writeText(domainHelp(domain));
    return EXIT_OK;
  }
  if (domain === "doctor") return doctorCommand(flags);
  if (domain === "sftp") return sftpCommand(action, rest, flags);
  // The drafts domain is pure RPC and never uses the local project root, so it routes BEFORE
  // initializeProjectRoot: that probe would otherwise fall back to optionalApi("status") in an
  // unfamiliar cwd and read capabilities/RPC even for usage refusals and the local promote refusal.
  // Root-dependent data domains below keep their existing root resolution untouched.
  if (domain === "draft") {
    if (!action) throw usageError("missing draft action", domainHelp("draft"));
    return draftCommand(action, rest, flags);
  }
  // plans.cleanup.* is pure RPC against the extension host (no local root use), so this subroute
  // also sits before the root probe; the rest of the plan domain (local list/build/validate files)
  // keeps its root resolution below, untouched.
  if (domain === "plan" && action === "cleanup") return planCleanupCommand(rest[0] || "", rest.slice(1), flags);
  // project prepare/bootstrap/bootstrap-operation are pure-RPC, confirmation-gated entries (the host
  // resolves its own workspace), so they route before the root probe too; `project status` below keeps
  // its local root resolution untouched.
  if (domain === "project" && (action === "prepare" || action === "bootstrap" || action === "bootstrap-operation")) return projectOpsCommand(action, rest, flags);
  // A agents.lifecycle is pure RPC against the extension host (its target dirs/tmux state are host-side),
  // so it also routes before the root probe. This is A's contract only — B's sftp agents lifecycle lives
  // under the sftp domain with its own server-file parameters.
  if (domain === "agents") {
    if (action !== "lifecycle") throw usageError("simpleex agents 目前仅支持: agents lifecycle inspect|ensure|stop|restart|migrate", domainHelp("agents"));
    return agentsLifecycleCommand(rest[0] || "", rest.slice(1), flags);
  }
  // The action catalog is a pure-RPC read-only discovery entry (live server-side table), so it also
  // routes before the root probe; there is no raw invoke route anywhere in this CLI.
  if (domain === "actions") {
    if (action === "list") return actionsListCommand(rest, flags);
    return actionCommand(action || "", rest, flags);
  }
  // Same pure-RPC rule as drafts: the task domain never reads the local project root, so it routes
  // before the root probe (a foreign cwd must not turn usage refusals into optionalApi("status")
  // reads). Data domains below keep their root resolution untouched.
  if (domain === "task") {
    if (action === "analyze") {
      writeJson(await callApi("tasks.analyze", { workflowId: flags.workflow, index: flags.index, workerId: flags.worker,
        commandId: flags.command, outputDir: flags.out })); return EXIT_OK;
    }
    if (action === "preflight") {
      // Contracts mirror src/extension/legacy.ts:14314-14362 (start: workerId+commandId, strict
      // booleans; status/cancel: operationId grammar at :14329). No confirmation factors exist at
      // this backend entry, so none are invented; flags are forwarded only when actually given.
      const sub = rest[0] || "";
      const usage = "用法：simpleex task preflight start --worker ID --command ID [--environment-only] [--completed-output-verify] | status|cancel --worker ID --operation-id formal-preflight-… [--json]";
      const workerId = String(flags.worker || "");
      if (!workerId) throw usageError("task preflight 需要 --worker <ID>（backend: FORMAL_JOB_PREFLIGHT_WORKER_REQUIRED）", usage);
      if (sub === "start") {
        if (!flags.command) throw usageError("task preflight start 需要 --command <commandId>（backend: FORMAL_JOB_PREFLIGHT_COMMAND_REQUIRED）", usage);
        const params: Record<string, unknown> = { workerId, commandId: String(flags.command) };
        if (flags["environment-only"] === true) params.environmentOnly = true;
        if (flags["completed-output-verify"] === true) params.completedOutputVerify = true;
        writeJson(await callApi("tasks.preflight", params)); return EXIT_OK;
      }
      if (sub === "status" || sub === "cancel") {
        const operationId = String(flags["operation-id"] || "");
        // Input-deterministic grammar check (:14329): refuse locally with zero RPC, same reason the backend gives.
        if (!/^formal-preflight-[a-zA-Z0-9-]+$/.test(operationId)) throw usageError("task preflight status|cancel 需要 --operation-id 匹配 ^formal-preflight-[a-zA-Z0-9-]+$（backend: FORMAL_JOB_PREFLIGHT_OPERATION_REQUIRED）", usage);
        writeJson(await callApi(sub === "status" ? "tasks.preflight.status" : "tasks.preflight.cancel", { workerId, operationId })); return EXIT_OK;
      }
      throw usageError(`unknown task preflight subcommand: ${sub || "(missing)"}`, usage);
    }
    if (action !== "dispatch") throw usageError("用法：simpleex task dispatch --workflow ID --jobs 0,1 --worker ID --gpu 0 --confirm [--stop-running]");
    if(flags.remaining===true){
      if(flags.all!==true&&!flags.workflow)throw usageError("请指定 --workflow ID 或 --all；仅选择尚未派发的剩余 job。");
      writeJson(await callApi("tasks.dispatch",{distribution:"quota_remaining",workflowId:flags.workflow,all:flags.all===true,confirm:flags.confirm===true}));return EXIT_OK;
    }
    const jobs=String(flags.jobs||"").trim();
    if (!/^\d+(?:,\d+)*$/.test(jobs)) throw usageError("请用 --jobs 明确选择 job 索引，例如 --jobs 0,2。");
    const result=await callApi("tasks.dispatch",{workflowId:String(flags.workflow||""),indices:jobs.split(",").map(Number),
      workerId:String(flags.worker||""),gpuId:String(flags.gpu??""),confirm:flags.confirm===true,stopRunning:flags["stop-running"]===true});
    writeJson(result);return EXIT_OK;
  }
  if (["config", "state", "flow", "tmux", "panel"].includes(domain)
    || domain === "gpu" && action === "history"
    || domain === "server" && action === "test-all"
    || domain === "plan" && action === "filter") return controlCommand(domain, action || "", rest, flags);
  if (domain === "plan" && action === "validate") {
    if (rest.length !== 1) throw usageError("plan validate requires exactly one project-relative plan file");
    return planValidate(rest[0], flags);
  }
  if (domain === "experiment" && action === "pause") throw businessError("EXPERIMENT_PAUSE_UNSUPPORTED: the scheduler has no pause operation; use experiment stop or monitor.");
  await initializeProjectRoot();
  if (domain === "project") {
    if (action && action !== "status") throw usageError(`unknown project action: ${action}`);
    return projectStatus(flags);
  }
  if (domain === "experiment") {
    if (!action) throw usageError("missing experiment action", domainHelp("experiment"));
    return experimentCommand(action, rest, flags);
  }
  if (domain === "plan") {
    if (!action) throw usageError("missing plan action", domainHelp("plan"));
    return planCommand(action, rest, flags);
  }
  if (domain === "result") {
    if (!action) throw usageError("missing result action", domainHelp("result"));
    return resultCommand(action, rest, flags);
  }
  if (domain === "log") {
    if (!action) throw usageError("missing log action", domainHelp("log"));
    return logCommand(action, rest, flags);
  }
  if (domain === "metric") {
    if (!action) throw usageError("missing metric action", domainHelp("metric"));
    return metricCommand(action, rest, flags);
  }
  if (domain === "compare") return compareEntry([action, ...rest].filter(Boolean), flags);
  if (domain === "gpu") return gpuCommand(action || "status", rest, flags);
  if (domain === "resource") return resourceCommand(action || "available", rest, flags);
  if (domain === "server") return serverCommand(action || "list", rest, flags);
  if (domain === "artifact") {
    if (!action) throw usageError("missing artifact action", domainHelp("artifact"));
    return artifactCommand(action, rest, flags);
  }
  throw usageError(`unknown domain: ${domain}`);
}

async function initializeProjectRoot(): Promise<void> {
  const explicit = process.env.SIMPLE_EXPERIMENT_PROJECT_ROOT;
  if (explicit !== undefined) {
    const root = validProjectRoot(explicit);
    if (!root) throw envError("SIMPLE_EXPERIMENT_PROJECT_ROOT must be an existing absolute directory");
    setProjectRoot(root);
    return;
  }
  const cwd = process.cwd();
  if (isExperimentProjectRoot(cwd)) {
    setProjectRoot(cwd);
    return;
  }
  let status: unknown = null;
  try { status = await optionalApi("status"); } catch { /* Offline commands use cwd. */ }
  const workspace = (status && typeof status === "object" && !Array.isArray(status))
    ? (status as Record<string, unknown>).workspace : "";
  setProjectRoot(validProjectRoot(workspace) || cwd);
}

/**
 * The single dispatch owns every public entry since the compatibility layer was revoked
 * (user decision 2026-10-23). Kept exported so older imports keep resolving; it always routes
 * into runSimpleCli, which refuses removed entries explicitly instead of falling through.
 */
export function isSimpleCommand(_argv: string[]): boolean {
  return true;
}

export function emitCliFailure(error: unknown, json: boolean, compact = false): number {
  const mapped = asCliError(error, 3);
  if (json) writeJson(jsonErrorBody(mapped), false);
  else {
    // Human mode keeps the refusal pointer/preview too, so revocations explain themselves without --json.
    process.stderr.write(mapped.detail ? `${mapped.message}\n${String(mapped.detail).trimEnd()}\n` : `${mapped.message}\n`);
  }
  return mapped.exitCode;
}
