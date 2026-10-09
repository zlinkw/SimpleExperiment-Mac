export type ProgressEvidence = { phase?: string; scope?: string; processedBytes?: number; processedFiles?: number; status?: string };

/** Heartbeats and identical payloads never extend the wait. */
export class ProgressInactivity {
  private timer?: NodeJS.Timeout;
  private readonly phases = new Set<string>();
  private phase = "";
  private readonly counts = new Map<string, { bytes: number; files: number }>();
  private pausedAt?: number;
  private ended = false;
  lastProgressAt: number;
  constructor(public readonly idleMs: number, private readonly onIdle: () => void,
    private readonly now: () => number = Date.now) {
    this.lastProgressAt = now();
    this.arm();
  }
  update(evidence: ProgressEvidence): boolean {
    if (this.ended) return false;
    const phase = String(evidence.phase || this.phase);
    const key = String(evidence.scope || "") + ":" + phase;
    const previous = this.counts.get(key) || { bytes: 0, files: 0 };
    const bytes = Math.max(previous.bytes, Number(evidence.processedBytes) || 0);
    const files = Math.max(previous.files, Number(evidence.processedFiles) || 0);
    const phaseChanged = Boolean(phase && !this.phases.has(key));
    const terminal = ['completed', 'succeeded', 'cancelled', 'failed'].includes(String(evidence.status));
    const changed = bytes > previous.bytes || files > previous.files || phaseChanged || terminal;
    this.counts.set(key, { bytes, files }); this.phase = phase;
    if (phase) this.phases.add(key);
    if (changed) { this.lastProgressAt = this.now(); this.arm(); }
    if (terminal) this.dispose();
    return changed;
  }
  pause(): void {
    if (this.pausedAt === undefined) this.pausedAt = this.now();
    clearTimeout(this.timer);
  }
  resume(): void {
    if (this.pausedAt === undefined) return;
    this.lastProgressAt += this.now() - this.pausedAt;
    this.pausedAt = undefined;
    this.arm();
  }
  check(): boolean {
    if (this.ended || this.pausedAt !== undefined || this.now() - this.lastProgressAt < this.idleMs) return false;
    this.dispose(); this.onIdle(); return true;
  }
  dispose(): void { this.ended = true; clearTimeout(this.timer); }
  private arm(): void {
    clearTimeout(this.timer);
    if (this.ended || this.pausedAt !== undefined) return;
    this.timer = setTimeout(() => { if (!this.check()) this.arm(); }, Math.max(1, this.idleMs - (this.now() - this.lastProgressAt)));
    this.timer.unref?.();
  }
}
