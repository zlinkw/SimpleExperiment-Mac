import * as path from "path";
import { normalizeXshellSetupConfig } from "../tunnel/XshellTunnelSetup";

export const RENAMED_EXTENSION_STATE_MIGRATION_VERSION = 2;
export const RENAMED_EXTENSION_STATE_MIGRATION_KEY = "simpleExperiment.renamedExtensionStateMigrationVersion";
export const LEGACY_EXTENSION_ID = "zlk-local.zlk-cluster-orchestrator";
const CURRENT_SETUP_KEY = "simpleExperiment.xshellRealtimeTunnelConfig";
const LEGACY_SETUP_KEY = "zlkCluster.xshellRealtimeTunnelConfig";
const CURRENT_TUNNEL_KEY = "simpleExperiment.tunnelGatewayConfig";

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stripDirectSshFields(value: unknown): Record<string, any> {
  const source = record(value);
  const copy = { ...source };
  delete copy.sshConfigAlias;
  delete copy.privateKeyPath;
  delete copy.sshHost;
  delete copy.sftpHost;
  return copy;
}

export function xshellRecoveryConfig(value: unknown): Record<string, any> {
  const source = record(value);
  return {
    ...stripDirectSshFields(source),
    savedSessionRunner: "xshell",
    localForwardHost: "127.0.0.1",
    remoteAgentHost: "127.0.0.1",
    workerTunnels: Array.isArray(source.workerTunnels)
      ? source.workerTunnels.map((worker) => stripDirectSshFields(worker))
      : [],
  };
}

export function xshellConfigCompleteness(value: unknown): number {
  const source = record(value);
  const workers = Array.isArray(source.workerTunnels)
    ? source.workerTunnels.filter((worker) => record(worker).enabled !== false)
    : [];
  let score = 0;
  if (String(source.xshellExePath || "").trim()) score += 2;
  if (String(source.hubHost || "").trim() && String(source.hubUser || "").trim()) score += 2;
  if (String(source.savedSessionPath || source.xshellSessionName || "").trim()) score += 3;
  if (String(source.agentProjectDir || "").trim()) score += 3;
  score += Math.min(workers.length, 8) * 4;
  score += workers.filter((worker) => String(worker.savedSessionPath || worker.xshellSessionName || "").trim()).length * 2;
  return score;
}

export function hasCompletedXshellSetup(value: unknown): boolean {
  const source = record(value);
  return xshellConfigCompleteness(source) >= 13
    && Array.isArray(source.workerTunnels)
    && source.workerTunnels.some((worker) => record(worker).enabled !== false);
}

export function readExtensionStateFromDatabase(databasePath: string, extensionId = LEGACY_EXTENSION_ID): Record<string, any> {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT value FROM ItemTable WHERE key = ?").get(extensionId);
      if (!row?.value) return {};
      const parsed = JSON.parse(String(row.value));
      return record(parsed);
    } finally {
      database.close();
    }
  } catch {
    return {};
  }
}

export function renamedExtensionStateSourcePath(globalStoragePath: string): string {
  return path.join(path.dirname(globalStoragePath), "state.vscdb");
}

export async function migrateRenamedExtensionState(context: any, options: { readState?: (databasePath: string) => Record<string, any> } = {}) {
  const globalState = context?.globalState;
  if (!globalState?.get || !globalState?.update) return { migrated: false, reason: "missing_global_state" };
  if (Number(globalState.get(RENAMED_EXTENSION_STATE_MIGRATION_KEY, 0)) >= RENAMED_EXTENSION_STATE_MIGRATION_VERSION)
    return { migrated: false, reason: "already_checked" };

  const current = record(globalState.get(CURRENT_SETUP_KEY, {}));
  if (hasCompletedXshellSetup(current)) {
    await globalState.update(RENAMED_EXTENSION_STATE_MIGRATION_KEY, RENAMED_EXTENSION_STATE_MIGRATION_VERSION);
    return { migrated: false, reason: "current_setup_complete" };
  }

  const globalStoragePath = String(context?.globalStorageUri?.fsPath || "");
  const legacyState = globalStoragePath
    ? (options.readState || readExtensionStateFromDatabase)(renamedExtensionStateSourcePath(globalStoragePath))
    : {};
  const legacyCandidates = [
    record(legacyState[LEGACY_SETUP_KEY]),
    record(globalState.get(LEGACY_SETUP_KEY, {})),
  ].filter((item) => Object.keys(item).length);
  const legacy = legacyCandidates.sort((left, right) =>
    xshellConfigCompleteness(right) - xshellConfigCompleteness(left)
  )[0] || {};
  if (!Object.keys(legacy).length || xshellConfigCompleteness(legacy) <= xshellConfigCompleteness(current)) {
    await globalState.update(RENAMED_EXTENSION_STATE_MIGRATION_KEY, RENAMED_EXTENSION_STATE_MIGRATION_VERSION);
    return { migrated: false, reason: "no_better_legacy_setup" };
  }

  const setup = normalizeXshellSetupConfig(xshellRecoveryConfig(legacy));
  const tunnel = {
    enabled: true,
    connectionMode: "xshell_tunnel_realtime",
    provider: "xshell",
    localHost: "127.0.0.1",
    localPort: setup.localForwardPort,
    remoteHost: "127.0.0.1",
    remotePort: setup.remoteAgentPort,
    xshellExePath: setup.xshellExePath,
    allowStreaming: true,
    refreshProfile: "realtime",
  };
  await globalState.update(CURRENT_SETUP_KEY, setup);
  await globalState.update(CURRENT_TUNNEL_KEY, tunnel);
  await globalState.update(RENAMED_EXTENSION_STATE_MIGRATION_KEY, RENAMED_EXTENSION_STATE_MIGRATION_VERSION);
  return { migrated: true, source: LEGACY_EXTENSION_ID, workerCount: setup.workerTunnels.length };
}
