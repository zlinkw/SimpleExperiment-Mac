import * as fs from "node:fs";
import { callApi } from "../api";
import { businessError, EXIT_BUSINESS, EXIT_OK, usageError } from "../errors";
import { writeJson } from "../format";
import { CliFlags } from "../parse";

// A drafts domain — parameters mirror src/extension/legacy.ts:1534-1551 exactly:
// list/cleanupCandidates take {force}; validate/promotionPreview/review/reject take draftPlanPath
// (review/reject also accept reviewedBy, whose default "local-user" belongs to the backend —
// the CLI never sends it on the backend's behalf); drafts.cleanup requires paths and gates the
// move with confirm + pathConfirmed + confirmedPaths (exact absolute-path set, :15696-15698).
// B's files.cleanup rules do NOT apply here and are not reused. Missing confirmation factors are
// forwarded as-is — never auto-filled — so the backend answers with its own preview (2001 → exit 2).
const USAGE = `Usage:
  simpleex draft list [--force] [--json]
  simpleex draft candidates [--force] [--json]
  simpleex draft validate <draftPlanPath> [--json]
  simpleex draft promotion-preview <draftPlanPath> [--json]
  simpleex draft review <draftPlanPath> [--reviewed-by <name>] [--json]
  simpleex draft reject <draftPlanPath> [--reviewed-by <name>] [--json]
  simpleex draft cleanup --paths paths.json [--confirmed-paths-file confirmed.json] [--confirm] [--path-confirmed] [--json]
       cleanup gates the move with confirm+pathConfirmed+confirmedPaths (absolute paths from the preview); drafts.promote is retired (DRAFT_PROMOTION_RETIRED) and is refused, never revived.`;

export async function draftCommand(action: string, rest: string[], flags: CliFlags): Promise<number> {
  if (action === "list" || action === "candidates") {
    if (rest.length) throw usageError(`draft ${action} takes no positional arguments`, USAGE);
    const method = action === "list" ? "drafts.list" : "drafts.cleanupCandidates";
    return emit(await callApi(method, flags.force === true ? { force: true } : {}));
  }
  if (action === "validate" || action === "promotion-preview" || action === "review" || action === "reject") {
    if (rest.length !== 1) throw usageError(`draft ${action} takes exactly one <draftPlanPath>`, USAGE);
    const params: Record<string, unknown> = { draftPlanPath: rest[0] };
    if ((action === "review" || action === "reject") && flags["reviewed-by"]) params.reviewedBy = String(flags["reviewed-by"]);
    const method = action === "validate" ? "drafts.validate"
      : action === "promotion-preview" ? "drafts.promotionPreview"
        : action === "review" ? "drafts.review" : "drafts.reject";
    return emit(await callApi(method, params));
  }
  if (action === "cleanup") {
    if (rest.length) throw usageError("draft cleanup takes no positional arguments", USAGE);
    if (!flags.paths) throw usageError("draft cleanup needs --paths <paths.json> (exact candidate paths from drafts.cleanupCandidates)", USAGE);
    const paths = readStringArray(readJsonArray(flags.paths, "draft cleanup paths"), "draft cleanup paths");
    if (!paths.length) throw usageError("draft cleanup needs at least one exact path (backend: 清理必须提供精确文件路径列表)", USAGE);
    // Duplicate refusal is deterministic from the input itself (legacy.ts:15711), so it belongs to usage — zero API calls.
    if (new Set(paths).size !== paths.length) throw usageError("draft cleanup paths contain duplicates (backend refuses; refusing before any API call)", USAGE);
    const params: Record<string, unknown> = { paths };
    if (flags["confirmed-paths-file"]) params.confirmedPaths = readStringArray(readJsonArray(flags["confirmed-paths-file"], "draft cleanup confirmed paths"), "draft cleanup confirmed paths");
    if (flags.confirm === true) params.confirm = true;
    if (flags["path-confirmed"] === true) params.pathConfirmed = true;
    return emit(await callApi("drafts.cleanup", params));
  }
  if (action === "promote") {
    throw businessError("drafts.promote is retired: DRAFT_PROMOTION_RETIRED — new tasks use configs and experiments/plans directly; historical drafts stay read-only (src/extension/legacy.ts apiDraftPromote)", "zero RPC: this CLI never calls the retired method.");
  }
  throw usageError(`unknown draft action: ${action || "(missing)"}`, USAGE);
}

/**
 * Full JSON always prints; the exit code follows the real result contract. A validation report is
 * a successful RPC even when ok:false (legacy.ts:15614-15621 returns {ok:validation.ok,status,
 * configRefs,issues}), so the shell contract must say BUSINESS(3) — never a silent success. Objects
 * without an "ok" field (list state, promotion previews) are NOT failures; ok===false is the only
 * in-band business failure this domain defines. The backend's own semantics are untouched.
 */
function emit(result: unknown): number {
  writeJson(result);
  return result && typeof result === "object" && !Array.isArray(result) && (result as { ok?: unknown }).ok === false ? EXIT_BUSINESS : EXIT_OK;
}

function readJsonArray(file: string, what: string): unknown[] {
  if (!fs.existsSync(file)) throw usageError(`${what} file not found: ${file}`);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw usageError(`${what} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(value)) throw usageError(`${what} must be a JSON array`);
  return value;
}

function readStringArray(value: unknown[], what: string): string[] {
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw usageError(`${what} must contain non-empty strings only`);
    return item.trim();
  });
}
