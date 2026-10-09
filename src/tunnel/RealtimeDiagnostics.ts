export interface RealtimeDiagnostics {
  streamStatus: "disconnected" | "connecting" | "websocket" | "sse" | "polling" | "paused";
  lastSeq: number;
  lastHeartbeatAt?: string;
  reconnectCount: number;
  fileApiOk?: boolean;
  lastError?: string;
}
