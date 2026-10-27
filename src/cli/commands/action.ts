import * as fs from "node:fs";
import { callApi } from "../api";
import { businessError, envError, usageError } from "../errors";
import { writeJson } from "../format";
import { CliFlags } from "../parse";
import { emitRpc } from "./control";

interface ActionRow { command: string; safe: boolean; confirm: boolean; action: string; }
export function actionName(command: string): string { return command.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(); }
const REDIRECT: Record<string, string> = {
  deleteArtifacts: "plan cleanup preview/confirm/execute",
  reconcileDeletions: "plan cleanup preview/confirm/execute",
  cleanupPlan: "plan cleanup preview/confirm/execute",
  cleanupDrafts: "draft candidates/cleanup",
  promoteDraft: "draft promote (retired)",
};
const READ_ACTIONS = new Set(["status", "fetchTmuxList", "fetchTmuxCapture", "loadGpuHistory", "gpuWindowSamples", "getTensorBoardStatus", "showRegistry", "checkPluginUpdates"]);
export async function actionCommand(name: string, rest: string[], flags: CliFlags): Promise<number> {
  if (name === "invoke" || name === "run" || rest.length > (name === "describe" ? 1 : 0)) throw usageError("use a named action: simpleex actions <kebab-name> [--file parameters.json] [--confirm]; actions list prints available names");
  if (name === "describe" && rest.length !== 1) throw usageError("actions describe requires a named action");
  const requested = name === "describe" ? rest[0] : name;
  if (!/^[a-z][a-z0-9-]*$/.test(requested)) throw usageError("action names use lowercase kebab-case");
  const params: Record<string, unknown> = {};
  if (flags.file) {
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(flags.file, "utf8")); } catch { throw usageError("action --file must be a readable JSON object"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError("action --file must be a JSON object");
    Object.assign(params, value);
    for (const key of ["command", "confirm", "pathConfirmed", "secondConfirmation"]) if (Object.hasOwn(params, key)) throw usageError("confirmation/command fields cannot come from --file; use explicit confirmation flags");
  }
  const catalog = await callApi("actions.list", {}) as { actions?: ActionRow[] };
  if (!Array.isArray(catalog?.actions) || catalog.actions.some(row => typeof row.command !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(row.command))) throw envError("Invalid actions.list catalog");
  const rows = catalog.actions.filter(row => actionName(row.command) === requested);
  if (rows.length !== 1) throw businessError("Action is absent or ambiguous in the current host catalog: " + requested);
  const row = rows[0];
  if (name === "describe") {
    writeJson({ name: requested, ...row, parameters: "explicit JSON object via --file; handler validates business parameters", confirmation: READ_ACTIONS.has(row.command) ? "backend-defined" : "--confirm required by CLI; further backend requirements remain authoritative", replacement: REDIRECT[row.command] || null });
    return 0;
  }
  if (row.command === "promoteDraft" || actionName(row.command).replace(/git-hub/g, "github").split("-").includes("hub")) throw businessError("RETIRED_ACTION: " + row.command);
  if (REDIRECT[row.command]) throw businessError("Use the protected named command: simpleex " + REDIRECT[row.command]);
  // A catalog row's 'safe' means non-uiActionCommand, NOT read-only. Do not use it as authorization.
  if (!READ_ACTIONS.has(row.command) && flags.confirm !== true) throw envError("CONFIRM_REQUIRED: " + requested, JSON.stringify({ command: row.command, params, requires: ["confirm"], executed: false }));
  if (flags.confirm === true) params.confirm = true;
  if (flags["path-confirmed"] === true) params.pathConfirmed = true;
  if (flags["second-confirmation"] === true) params.secondConfirmation = true;
  return emitRpc("invoke", { ...params, command: row.command });
}
