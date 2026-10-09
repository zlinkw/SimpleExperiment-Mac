export interface ReconnectPolicy {
  reconnectInitialDelaySeconds: number;
  reconnectMaxDelaySeconds: number;
}

export class RealtimeReconnect {
  private attempt = 0;

  constructor(
    private readonly policy: ReconnectPolicy = { reconnectInitialDelaySeconds: 3, reconnectMaxDelaySeconds: 60 },
    private readonly random: () => number = Math.random,
  ) {}

  nextDelayMs(): number {
    const base = Math.max(1, this.policy.reconnectInitialDelaySeconds) * 1000;
    const max = Math.max(base, this.policy.reconnectMaxDelaySeconds * 1000);
    const rawDelay = Math.min(max, base * 2 ** this.attempt);
    this.attempt += 1;
    const jitterWindow = Math.min(rawDelay * 0.25, Math.max(1000, base));
    const maxDelay = Math.min(max, rawDelay + jitterWindow);
    if (maxDelay <= rawDelay) return rawDelay;
    return Math.round(rawDelay + (maxDelay - rawDelay) * clamp01(this.random()));
  }

  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
