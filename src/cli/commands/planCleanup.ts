import * as fs from "node:fs";
import { callApi } from "../api";
import { EXIT_BUSINESS, EXIT_OK, usageError } from "../errors";
import { writeJson } from "../format";
import { CliFlags } from "../parse";

// A plans.cleanup.* family — parameters mirror the real service signatures only:
// preview {planFile, action?, verifiedOnly?, continuationOf?, job?, authorizationMode?, reuseToken?, exactPaths?}
// (features/PlanCleanup.ts:743-744); confirm {token, digest, phase, confirm, exactTargets} (:966);
// continuePreview {operationId, verifiedOnly?}; recheckNode {nodeId}; execute/resume/status/cancel/restore
// take the operationId (extension/legacy.ts:1392-1401). The confirmation chain lives entirely in the
// confirm phases (delete twice, others once; digest + exactTargets digest at :976-977) — execute has no
// confirm factor, and none is invented here. exactTargets are the preview-ordered "nodeId:absolutePath"
// strings for rows whose disposition equals the action (:975; cleanupDigest=sha256(JSON.stringify),
// order-sensitive :67). Missing or wrong echoes get the backend's CONFIRM_REQUIRED preview (2001 → exit 2).
const USAGE = `Usage:
  simpleex plan cleanup list [--json]
  simpleex plan cleanup preview --plan-file <plan> [--action move|delete|isolate] [--verified-only] [--continuation-of <operationId>] [--job job.json] [--confirmed-paths] [--exact-paths exactPaths.json] [--reuse-token <token>] [--json]
  simpleex plan cleanup confirm --token T --digest D --phase <n> --targets exactTargets.json [--confirm] [--json]   (exactTargets = preview-ordered ["nodeId:absolutePath", …] for disposition==action rows; delete confirms twice, others once; any drift → re-preview, never replay)
  simpleex plan cleanup execute|resume|status|cancel|restore --operation-id <id> [--json]
  simpleex plan cleanup continue --operation-id <id> [--verified-only] [--json]  |  recheck --node-id <id> [--json]
       confirmations live in the confirm phases; execute has no confirm factor and never re-issues a started move (uncertain rows settle via status/execute, per the frozen receipt).`;

export async function planCleanupCommand(sub: string, rest: string[], flags: CliFlags): Promise<number> {
  if (rest.length) throw usageError(`plan cleanup ${sub || "(missing)"} takes no positional arguments`, USAGE);
  if (sub === "list") return emit(await callApi("plans.cleanup.list", {}));
  if (sub === "preview") {
    if (!flags["plan-file"]) throw usageError("plan cleanup preview needs --plan-file <plan>", USAGE);
    const action = flags.action === undefined ? undefined : String(flags.action);
    if (action !== undefined && !["move", "delete", "isolate"].includes(action)) throw usageError("plan cleanup --action must be move|delete|isolate (backend: INVALID_ACTION)", USAGE);
    if (flags["confirmed-paths"] === true && action !== "delete" && action !== "isolate") {
      // authorizationMode is delete/isolate-only at the service (:752); refusing here costs zero API calls.
      throw usageError("plan cleanup --confirmed-paths (authorizationMode=confirmed_paths) is only valid with --action delete or isolate (backend: INVALID_ACTION)", USAGE);
    }
    const params: Record<string, unknown> = { planFile: String(flags["plan-file"]) };
    if (action !== undefined) params.action = action;
    if (flags["verified-only"] === true) params.verifiedOnly = true;
    if (flags["continuation-of"]) params.continuationOf = String(flags["continuation-of"]);
    if (flags["reuse-token"]) params.reuseToken = String(flags["reuse-token"]);
    if (flags["confirmed-paths"] === true) params.authorizationMode = "confirmed_paths";
    if (flags.job) params.job = readJsonObject(flags.job, "plan cleanup job");
    if (flags["exact-paths"]) params.exactPaths = readExactPaths(flags["exact-paths"]);
    return emit(await callApi("plans.cleanup.preview", params));
  }
  if (sub === "confirm") {
    if (!flags.token || !flags.digest) throw usageError("plan cleanup confirm needs --token and --digest from the preview", USAGE);
    const phase = Number(flags.phase);
    if (!flags.phase || !Number.isInteger(phase) || phase < 1) throw usageError("plan cleanup confirm needs --phase as a positive integer (backend: phase must be confirmations+1)", USAGE);
    if (!flags.targets) throw usageError("plan cleanup confirm needs --targets exactTargets.json ([\"nodeId:absolutePath\", …] echoed from the preview in order)", USAGE);
    const exactTargets = readStringArray(readJsonArray(flags.targets, "plan cleanup exactTargets"), "plan cleanup exactTargets");
    const params = { token: String(flags.token), digest: String(flags.digest), phase, confirm: flags.confirm === true, exactTargets };
    return emit(await callApi("plans.cleanup.confirm", params));
  }
  if (sub === "continue") {
    const params: Record<string, unknown> = { operationId: needOperationId(sub, flags) };
    if (flags["verified-only"] === true) params.verifiedOnly = true;
    return emit(await callApi("plans.cleanup.continue", params));
  }
  if (sub === "recheck") {
    if (!flags["node-id"]) throw usageError("plan cleanup recheck needs --node-id <id>", USAGE);
    return emit(await callApi("plans.cleanup.recheck", { nodeId: String(flags["node-id"]) }));
  }
  if (["execute", "resume", "status", "cancel", "restore"].includes(sub)) {
    // These methods carry only the operation identity (legacy.ts:1397-1401); the backend's own guards
    // answer busy/superseded/unconfirmed/unknown-receipt states — never invented confirm factors here.
    return emit(await callApi(`plans.cleanup.${sub}`, { operationId: needOperationId(sub, flags) }));
  }
  throw usageError(`unknown plan cleanup subcommand: ${sub || "(missing)"}`, USAGE);
}

/**
 * Same in-band rule as drafts: the full JSON always prints, and an object carrying ok===false is a
 * business failure (BUSINESS 3). The plan-cleanup service signals refusals through cleanupError
 * (apiCode 2001/2010 → exits 2/3), not through ok fields, so absence of "ok" is never a failure.
 */
function emit(result: unknown): number {
  writeJson(result);
  return result && typeof result === "object" && !Array.isArray(result) && (result as { ok?: unknown }).ok === false ? EXIT_BUSINESS : EXIT_OK;
}

function needOperationId(sub: string, flags: CliFlags): string {
  if (!flags["operation-id"]) throw usageError(`plan cleanup ${sub} needs --operation-id <id>`, USAGE);
  return String(flags["operation-id"]);
}

function readJsonArray(file: string, what: string): unknown[] {
  if (!fs.existsSync(file)) throw usageError(`${what} file not found: ${file}`);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw usageError(`${what} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(value)) throw usageError(`${what} must be a JSON array`);
  return value;
}

function readJsonObject(file: string, what: string): Record<string, unknown> {
  if (!fs.existsSync(file)) throw usageError(`${what} file not found: ${file}`);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw usageError(`${what} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

function readStringArray(value: unknown[], what: string): string[] {
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw usageError(`${what} must contain non-empty strings only`);
    return item;
  });
}

function readExactPaths(file: string): Array<Record<string, unknown>> {
  const rows = readJsonArray(file, "plan cleanup exactPaths");
  if (!rows.length) throw usageError("plan cleanup exactPaths must list at least one {nodeId, relativePath, type} entry");
  return rows.map((item) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const nodeId = typeof row.nodeId === "string" ? row.nodeId.trim() : "";
    const relativePath = typeof row.relativePath === "string" ? row.relativePath.trim() : "";
    const type = row.type;
    if (!nodeId || !relativePath || (type !== "file" && type !== "directory")) {
      throw usageError("plan cleanup exactPaths entries need non-empty nodeId, relativePath and type file|directory (backend: INVALID_EXACT_PATHS)");
    }
    return { nodeId, relativePath, type };
  });
}
