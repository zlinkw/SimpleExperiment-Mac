import { callApi } from "../api";
import { EXIT_BUSINESS, EXIT_OK, usageError } from "../errors";
import { writeJson } from "../format";
import { CliFlags } from "../parse";

// A actions.list — the LIVE server-side action catalog (registration legacy.ts:1414-1425): every row is
// {command, safe (not in uiActionCommands), confirm (API_CONFIRM_COMMANDS membership), action (named-command
// action name from actionCommandMap)} and count is the live total. The CLI forwards it verbatim and never
// substitutes a local enumeration: the "174" figure in the coverage doc is only a saved-baseline count of
// one version of API_EXECUTABLE_COMMANDS (:635-674), never an acceptance constant.
// There is deliberately NO generic raw-method passthrough: raw entries are revoked (REMOVED_ENTRIES.api), and
// this catalog is read-only. Execution goes through the named commands, so every backend gate stays in
// place — confirm factors, instance pinning, retired methods (none is bypassed here), and a started
// background operation is never presented as an executed success. Domain help is static text and performs
// zero API calls; anything capability-insufficient fails explicitly (missing actions.list → -32601 exit 3)
// instead of falling back to a baked-in table.
const USAGE = `Usage:
  simpleex actions list [--json]
       live catalog from the connected extension host: rows {command, safe, confirm, action} + count (the real total for the CURRENT host — saved baselines like 174 are documentation, not acceptance constants).
       Read-only index: there is no raw invoke passthrough (revoked entry). Run work through the named commands (simpleex --help / simpleex <domain> --help) so backend confirmations, instance identity and retired-method refusals always apply. If the host does not declare actions.list the command fails with -32601 (exit 3); no local table is substituted.`;

export async function actionsListCommand(rest: string[], _flags: CliFlags): Promise<number> {
  if (rest.length) throw usageError("actions list takes no positional arguments", USAGE);
  return emit(await callApi("actions.list", {}));
}

/** Same in-band rule as the other A domains: full JSON always prints; ok===false → BUSINESS 3. */
function emit(result: unknown): number {
  writeJson(result);
  return result && typeof result === "object" && !Array.isArray(result) && (result as { ok?: unknown }).ok === false ? EXIT_BUSINESS : EXIT_OK;
}
