import { ClusterConnectionMode, isRealtimeConnectionMode } from "./TunnelGateway";

export interface LegacyRemoteConfigMigrationResult {
  removedFields: string[];
  migratedToTunnel: boolean;
  warning: string;
}

export function assertTunnelOnlyMode(mode: ClusterConnectionMode): void {
  if (!isRealtimeConnectionMode(mode) && mode !== "offline_import") {
    throw new Error("直接远程连接模式已移除。请配置实时隧道或使用离线导入。");
  }
}

export function removeLegacyRemoteFields<T extends Record<string, unknown>>(input: T): { value: Record<string, unknown>; removedFields: string[] } {
  const value: Record<string, unknown> = {};
  const removedFields: string[] = [];
  for (const [key, item] of Object.entries(input)) {
    if (/^(ssh|scp|rsync)/i.test(key) || /(control|shell|fallback|workerRefresh)/i.test(key)) {
      removedFields.push(key);
      continue;
    }
    value[key] = item;
  }
  return { value, removedFields };
}

export function migrateLegacyRemoteConfig(input: Record<string, unknown>): LegacyRemoteConfigMigrationResult {
  const removed = removeLegacyRemoteFields(input);
  return {
    removedFields: removed.removedFields,
    migratedToTunnel: true,
    warning: "旧版直接远程连接模式已移除。请仅配置 Xshell 本地隧道。",
  };
}
