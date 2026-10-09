import { businessError, usageError } from "../errors";
import { writeJson, writeText } from "../format";
import { CliFlags, requirePositional } from "../parse";
import { logRecordsForExperiment } from "./experiment";

export async function logCommand(action: string, rest: string[], flags: CliFlags): Promise<number> {
  if (action === "show") return logShow(requirePositional(rest, 0, "experiment id"), flags);
  if (action === "tail") return logTail(requirePositional(rest, 0, "experiment id"), flags);
  throw usageError(`unknown log action: ${action || "(missing)"}`);
}

export async function logShow(id: string, flags: CliFlags): Promise<number> {
  return emitLogs(id, Number.MAX_SAFE_INTEGER, flags);
}

export async function logTail(id: string, flags: CliFlags): Promise<number> {
  return emitLogs(id, typeof flags.lines === "number" ? flags.lines : 50, flags);
}

async function emitLogs(id: string, lines: number, flags: CliFlags): Promise<number> {
  const records = await logRecordsForExperiment(id);
  if (!records) throw businessError(`experiment not found: ${id}`);
  const view = records.slice(Math.max(0, records.length - lines));
  if (flags.json) {
    writeJson(view, flags.compactJson);
    return 0;
  }
  writeText(view.map((row) => [row.timestamp, row.level, row.message].filter(Boolean).join(" ")).join("\n") || "(no log)");
  return 0;
}
