import { artifactCommand, compareEntry, experimentCommand, gpuCommand, logCommand, metricCommand, planCommand, projectStatus, resourceCommand, resultCommand, serverCommand } from "./commands";
import { asCliError, envError, EXIT_OK, jsonErrorBody, usageError } from "./errors";
import { optionalApi, callApi } from "./api";
import { isExperimentProjectRoot, setProjectRoot, validProjectRoot } from "./data";
import { writeJson, writeText } from "./format";
import { domainHelp, SIMPLE_HELP } from "./help";
import { parseArgv } from "./parse";

const LEGACY_COMMANDS = new Set(["status", "api", "self-check", "agent", "experiments", "metrics", "results", "run"]);
const SIMPLE_DOMAINS = new Set(["project", "experiment", "plan", "result", "log", "metric", "compare", "gpu", "resource", "server", "artifact", "task"]);

export async function runSimpleCli(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  const { positionals, flags } = parsed;
  const [domain, action, ...rest] = positionals;
  if (!domain || domain === "help" || (flags.help && !action)) {
    writeText(domain && SIMPLE_DOMAINS.has(domain) ? domainHelp(domain) : SIMPLE_HELP);
    return EXIT_OK;
  }
  if (flags.help) {
    writeText(domainHelp(domain));
    return EXIT_OK;
  }
  await initializeProjectRoot();
  if (domain === "task") {
    if (action === "analyze") {
      writeJson(await callApi("tasks.analyze", { workflowId: flags.workflow, index: flags.index, workerId: flags.worker,
        commandId: flags.command, outputDir: flags.out })); return EXIT_OK;
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

export function isSimpleCommand(argv: string[]): boolean {
  const tokens = argv.filter((item) => item !== "--json" && item !== "--help" && item !== "-h" && !item.startsWith("--"));
  const first = tokens[0] || "";
  const second = tokens[1] || "";
  if (!first) return true;
  if (first === "plan" && second === "build") return false;
  if (SIMPLE_DOMAINS.has(first)) return true;
  if (LEGACY_COMMANDS.has(first)) return false;
  return first === "help";
}

export function emitCliFailure(error: unknown, json: boolean, compact = false): number {
  const mapped = asCliError(error, 3);
  if (json) writeJson(jsonErrorBody(mapped), false);
  else process.stderr.write(`${mapped.message}\n`);
  return mapped.exitCode;
}
