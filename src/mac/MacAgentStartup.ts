/** Mac startup seam: endpoint extraction for the system-OpenSSH launcher and the
 * runtime proof required by the shared managed agent-lifecycle protocol. */
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { CURRENT_RUNTIME_VERSION, buildExpectedRuntimeManifest, sha256Text } from "../runtime/RuntimeManifest";
import { TunnelEndpoint } from "./OpenSshTunnels";

function normalizeCondaEnv(value: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim();
}

/** Mirrors the shared effectiveWorkerCondaEnv rule for the Mac adapter seam. */
export function effectiveMacCondaEnv(worker: any, fallback = ""): string {
  return worker && worker.condaEnv !== undefined ? normalizeCondaEnv(worker.condaEnv) : normalizeCondaEnv(fallback);
}

/** Extracts the narrow forward endpoint from a shared tunnelLaunchItems() entry. */
export function tunnelEndpointFromLaunchItem(item: any): TunnelEndpoint {
  const config = item && typeof item === "object" ? item.config || {} : {};
  return {
    id: String(item?.id || ""),
    displayName: item?.displayName ? String(item.displayName) : undefined,
    host: String(config.hubHost || "").trim(),
    user: String(config.hubUser || "").trim(),
    sshPort: Number(config.hubSshPort || 22),
    localForwardHost: String(config.localForwardHost || "127.0.0.1").trim(),
    localForwardPort: Number(config.localForwardPort),
    remoteAgentHost: String(config.remoteAgentHost || "127.0.0.1").trim(),
    remoteAgentPort: Number(config.remoteAgentPort || config.remoteTelemetryPort),
  };
}

/** Builds the same runtime proof the shared deploy flow sends to simpleSftpMac.agentLifecycle. */
export async function macAgentRuntimeManifest(pluginVersion: string, runtimeDir = path.join(__dirname, "..", "runtime"), disk: typeof fsp = fsp): Promise<any> {
  const [agentText, schedulerText] = await Promise.all([
    disk.readFile(path.join(runtimeDir, "cluster_agent.py"), "utf8"),
    disk.readFile(path.join(runtimeDir, "cluster_scheduler.py"), "utf8"),
  ]);
  const installedAt = new Date().toISOString();
  const manifest = buildExpectedRuntimeManifest(pluginVersion, CURRENT_RUNTIME_VERSION, [
    { component: "hub_agent", version: CURRENT_RUNTIME_VERSION, remotePath: "simple_cluster/runtime/cluster_agent.py", content: agentText },
    { component: "cluster_scheduler", version: CURRENT_RUNTIME_VERSION, remotePath: "simple_cluster/runtime/cluster_scheduler.py", content: schedulerText },
  ], installedAt);
  return { ...manifest, files: { "cluster_agent.py": sha256Text(agentText), "cluster_scheduler.py": sha256Text(schedulerText) }, deployedAt: installedAt };
}
