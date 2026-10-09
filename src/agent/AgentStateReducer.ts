// 定案：取消 stale 终态（stale 永不产生，仅作提示阈值，见 RunOperations.RUN_OPERATION_NO_LOG_GROWTH_STALE_MS）。
// terminalStates 与 operationTerminalStatus 均去掉 stale；历史已落盘 stale 仅作兼容读（调用方自行判断），不再新产生。
const terminalStates = new Set(["completed", "failed", "stopped", "deleted", "delete_failed", "timeout", "stalled", "error", "operation_completed", "operation_failed", "completed_with_errors", "cancelled", "canceled", "unsupported"]);

export interface VersionedState {
  source?: string;
  seq?: number;
  generatedAt?: string;
  runKey?: string;
  sessionId?: string;
  stateVersion?: number;
  status?: string;
  state?: string;
  [key: string]: any;
}

export function shouldAcceptVersionedState(previous: VersionedState | undefined, incoming: VersionedState): boolean {
  if (!previous) return true;
  if (incoming.runKey && previous.runKey && incoming.runKey === previous.runKey && incoming.sessionId && previous.sessionId && incoming.sessionId !== previous.sessionId) return true;
  const prevSeq = Number(previous.seq || 0);
  const nextSeq = Number(incoming.seq || 0);
  if (prevSeq && nextSeq && nextSeq < prevSeq) return false;
  const prevVersion = Number(previous.stateVersion || 0);
  const nextVersion = Number(incoming.stateVersion || 0);
  if (prevVersion && nextVersion && nextVersion < prevVersion) return false;
  const prevTime = Date.parse(String(previous.generatedAt || ""));
  const nextTime = Date.parse(String(incoming.generatedAt || ""));
  if (Number.isFinite(prevTime) && Number.isFinite(nextTime) && nextTime < prevTime && !nextSeq) return false;
  const prevStatus = String(previous.status || previous.state || "").toLowerCase();
  const nextStatus = String(incoming.status || incoming.state || "").toLowerCase();
  if (terminalStates.has(prevStatus) && !terminalStates.has(nextStatus) && previous.runKey === incoming.runKey && String(previous.sessionId || "") === String(incoming.sessionId || "")) return false;
  return true;
}

export function mergeVersionedState<T extends VersionedState>(previous: T | undefined, incoming: T): T {
  if (!shouldAcceptVersionedState(previous, incoming)) return previous as T;
  return { ...(previous || {}), ...incoming };
}

