import * as fs from "node:fs";
import { callApi } from "../api";
import { EXIT_BUSINESS, EXIT_OK, usageError } from "../errors";
import { writeJson } from "../format";
import { CliFlags } from "../parse";

// A agents.lifecycle (NOT B's — B's simpleex sftp agents lifecycle has its own server-file contract and
// is untouched). Parameters mirror src/extension/legacy.ts:7958-7990 ONLY:
// {serverIds: string[] (required, AGENT_TARGET_REQUIRED :7960), action: inspect|ensure|stop|restart|migrate
// (default "inspect", AGENT_ACTION_INVALID :7963), confirm?, migrationDigests?: {serverId: 64-hex digest}}.
// Everything else (dirs, tmux policy, conda env, agent token, ports, expectedVersion/files manifest) is
// host-side setupConfig/runtime state at :7992-8038 — the CLI never sends or invents those fields.
// Confirmation factors are exactly what the backend defines: non-inspect requires ["confirm"] (:7982-7986);
// migrate additionally requires per-target migrationDigests matching the preview digests (:7973-7979), and
// the 2001 preview echoes the expected digests so the operator can save and echo them — the CLI never
// auto-fills and never replays. inspect is zero-write and needs no confirmations (descriptor
// LocalApiServer.legacy.ts:664-670: inspectZeroWrites, mutationConfirmation "exact configured target").
// Input-deterministic refusals (empty serverIds, bad action, malformed digests) are local, zero-RPC, with
// the backend's own reason strings.
const USAGE = `Usage:
  simpleex agents lifecycle inspect --server-ids a,b [--json]                                        (zero-write; no confirmation factors required)
  simpleex agents lifecycle ensure|stop|restart --server-ids a,b --confirm [--json]                  (backend requires ["confirm"]; without it the full target/tmux preview prints at exit 2 and nothing changes)
  simpleex agents lifecycle migrate --server-ids a,b --migration-digests digests.json --confirm [--json]   (requires confirm + per-target migrationDigests equal to the preview digests; the 2001 preview echoes them — never auto-filled, never replayed)
       serverIds are configured server ids (AGENT_TARGET_REQUIRED if missing); action outside inspect|ensure|stop|restart|migrate is AGENT_ACTION_INVALID. Directories, tmux sessions, tokens, ports and the runtime manifest stay host-side setupConfig state — the CLI sends only the real four fields. Restart/migrate semantics (restartPreservesTasks, migrationDigests, explicitConfirmation) are the backend's; a mutation here touches real remote agents when confirmed.`;

const ACTIONS = ["inspect", "ensure", "stop", "restart", "migrate"];

export async function agentsLifecycleCommand(sub: string, rest: string[], flags: CliFlags): Promise<number> {
  if (rest.length) throw usageError("agents lifecycle takes no positional arguments after the action", USAGE);
  if (!ACTIONS.includes(sub)) throw usageError(`agents lifecycle action must be one of ${ACTIONS.join("|")} (backend: AGENT_ACTION_INVALID; local refusal, zero RPC)`, USAGE);
  const serverIds = flags["server-ids"] ? String(flags["server-ids"]).split(",").map((item) => item.trim()).filter(Boolean) : [];
  if (!serverIds.length) throw usageError("agents lifecycle needs --server-ids a,b (backend: AGENT_TARGET_REQUIRED; local refusal, zero RPC)", USAGE);
  const params: Record<string, unknown> = { action: sub, serverIds };
  if (flags["migration-digests"]) params.migrationDigests = readMigrationDigests(flags["migration-digests"]);
  // Forward the confirm factor only when actually given — the backend preview path answers otherwise.
  if (flags.confirm === true) params.confirm = true;
  return emit(await callApi("agents.lifecycle", params));
}

/** {serverId: 64-hex} — the same shape the backend validates when matching preview digests (:7976/:8040). */
function readMigrationDigests(file: string): Record<string, string> {
  if (!fs.existsSync(file)) throw usageError(`migrationDigests file not found: ${file}`);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw usageError(`migrationDigests must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError("migrationDigests must be a JSON object {serverId: 64-hex digest}");
  const rows = value as Record<string, unknown>;
  const entries = Object.entries(rows);
  if (!entries.length) throw usageError("migrationDigests must map at least one serverId to its preview digest");
  for (const [serverId, digest] of entries) {
    if (!serverId.trim() || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw usageError(`migrationDigests["${serverId}"] must be a 64-hex sha256 digest echoed from the preview (backend compares it per target)`);
    }
  }
  return rows as Record<string, string>;
}

/** Same in-band rule as drafts/plan cleanup/projectOps: full JSON always prints; ok===false → BUSINESS 3. */
function emit(result: unknown): number {
  writeJson(result);
  return result && typeof result === "object" && !Array.isArray(result) && (result as { ok?: unknown }).ok === false ? EXIT_BUSINESS : EXIT_OK;
}
