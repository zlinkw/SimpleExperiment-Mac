export interface NotificationRule {
  id: string;
  enabled: boolean;
  eventType: string;
  severity: "info" | "warning" | "critical";
  channels: Array<"vscode" | "statusbar" | "webhook">;
  throttleSeconds: number;
}

export interface NotificationEvent {
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  key?: string;
  at?: number;
}

export class NotificationThrottle {
  private readonly last = new Map<string, number>();

  shouldNotify(rule: NotificationRule, event: NotificationEvent): boolean {
    if (!rule.enabled || rule.eventType !== event.type) return false;
    const key = `${rule.id}:${event.key || event.type}`;
    const now = event.at || Date.now();
    const previous = this.last.get(key);
    if (previous === undefined) {
      this.last.set(key, now);
      return true;
    }
    if (now - previous < rule.throttleSeconds * 1000) return false;
    this.last.set(key, now);
    return true;
  }
}
