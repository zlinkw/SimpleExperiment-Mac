import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export const REMOTE_ROOT_POLICY_PREFILL_VERSION = 1;
export const REMOTE_ROOT_POLICY_PREFILL_KEY = "simpleExperiment.remoteRootPolicyPrefillVersion";

interface RemoteRootPrefillSource {
  setupConfig?: unknown;
  serverProfiles?: unknown;
  remoteSshInstallPaths?: unknown;
}

export interface RemoteRootPolicyPrefillResult {
  allowedRoots: string[];
  deniedRoots: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeRemoteRoot(value: unknown): string | undefined {
  const text = String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!text || !text.startsWith("/") || text === "/" || text === "." || text === "..") return undefined;
  const root = text.replace(/\/+$/, "");
  const segments = root.split("/").filter(Boolean);
  if (segments.includes(".") || segments.includes("..")) return undefined;
  if (segments.some((segment) => ["simple_agent", "zlk_agent"].includes(segment.toLowerCase()))) return undefined;
  return root;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parentRemotePath(value: string): string | undefined {
  const separator = value.lastIndexOf("/");
  return separator > 0 ? normalizeRemoteRoot(value.slice(0, separator)) : undefined;
}

function rootsFromSetupConfig(source: unknown): string[] {
  const setup = record(source);
  const workers = Array.isArray(setup.workerTunnels) ? setup.workerTunnels : [];
  const values = [
    setup.agentProjectDir,
    ...workers,
  ];
  return values.map((value) => record(value).agentProjectDir ?? value)
    .map((value) => normalizeRemoteRoot(value))
    .filter((value): value is string => Boolean(value));
}

function rootsFromServerProfiles(source: unknown, projectName: string): string[] {
  const profiles = record(source);
  const servers = Array.isArray(profiles.servers) ? profiles.servers : [];
  return servers.map((item) => {
    const remotePath = normalizeRemoteRoot(record(item).remotePath);
    if (!remotePath) return undefined;
    const leaf = remotePath.split("/").pop() || "";
    // Shared profiles store the work directory; setup roots store its parent.
    return projectName && leaf.toLowerCase() === projectName.toLowerCase()
      ? parentRemotePath(remotePath)
      : remotePath;
  }).filter((value): value is string => Boolean(value));
}

function rootsFromRemoteSshInstallPaths(source: unknown): string[] {
  const values = Object.values(record(source));
  return values.map((value) => normalizeRemoteRoot(value)).filter((value): value is string => Boolean(value));
}

export function deriveRemoteRootPolicyPrefill(source: RemoteRootPrefillSource = {}, projectName = ""): RemoteRootPolicyPrefillResult {
  const candidates = unique([
    ...rootsFromSetupConfig(source.setupConfig),
    ...rootsFromServerProfiles(source.serverProfiles, String(projectName || "")),
    ...rootsFromRemoteSshInstallPaths(source.remoteSshInstallPaths),
  ]);
  const unsafeRoots = candidates.filter((root) => root === "/root" || root.startsWith("/root/"));
  const allowedRoots = candidates.filter((root) => !unsafeRoots.includes(root));

  // Seed the migration-defect sibling (for example /data/team/simple beside
  // /data/team/zlk) so the failed branding migration cannot become authoritative.
  const migrationDefectRoots = allowedRoots.map((root) => {
    const separator = root.lastIndexOf("/");
    const leaf = separator >= 0 ? root.slice(separator + 1).toLowerCase() : "";
    return leaf === "zlk" ? `${root.slice(0, separator)}/simple` : undefined;
  }).filter((value): value is string => Boolean(value))
    .filter((value) => !allowedRoots.includes(value));

  return {
    allowedRoots: unique(allowedRoots),
    deniedRoots: unique([...unsafeRoots, ...migrationDefectRoots]),
  };
}

async function readServerProfiles(): Promise<unknown> {
  try {
    const file = path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "SimpleSFTP",
      "server-profiles",
      "servers.json",
    );
    return JSON.parse(await fs.readFile(file, "utf8"));
  }
  catch {
    return {};
  }
}

function hasExplicitConfigurationValue(inspection: unknown): boolean {
  const item = record(inspection);
  return item.globalValue !== undefined
    || item.workspaceValue !== undefined
    || item.workspaceFolderValue !== undefined;
}

export async function prefillRemoteRootPolicy(
  context: {
    workspaceState: { get(key: string, fallback?: unknown): unknown; update(key: string, value: unknown): Promise<void> };
  },
  setupConfig: unknown,
  vscode: {
    workspace: {
      workspaceFolders?: Array<{ uri: { fsPath: string } }>;
      getConfiguration(...args: unknown[]): {
        inspect(key: string): unknown;
        update(key: string, value: unknown, target?: unknown): Promise<void>;
        get(key: string, fallback?: unknown): unknown;
      };
    };
    ConfigurationTarget: { WorkspaceFolder: unknown };
  },
  options: { readServerProfiles?: () => Promise<unknown> | unknown } = {},
): Promise<RemoteRootPolicyPrefillResult | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || Number(context.workspaceState.get(REMOTE_ROOT_POLICY_PREFILL_KEY, 0)) >= REMOTE_ROOT_POLICY_PREFILL_VERSION) return undefined;
  await context.workspaceState.update(REMOTE_ROOT_POLICY_PREFILL_KEY, REMOTE_ROOT_POLICY_PREFILL_VERSION);

  const config = vscode.workspace.getConfiguration("simpleExperiment", folder.uri);
  const allowedInspection = config.inspect("remote.allowedRoots");
  const deniedInspection = config.inspect("remote.deniedRoots");
  if (hasExplicitConfigurationValue(allowedInspection) && hasExplicitConfigurationValue(deniedInspection)) return undefined;

  const projectName = path.basename(folder.uri.fsPath).trim();
  const source = {
    setupConfig,
    serverProfiles: await (options.readServerProfiles || readServerProfiles)(),
    remoteSshInstallPaths: vscode.workspace.getConfiguration("remote").get("SSH.serverInstallPath"),
  } as RemoteRootPrefillSource;
  const derived = deriveRemoteRootPolicyPrefill(source, projectName);
  const target = vscode.ConfigurationTarget.WorkspaceFolder;
  if (!hasExplicitConfigurationValue(allowedInspection) && derived.allowedRoots.length) {
    await config.update("remote.allowedRoots", derived.allowedRoots, target);
  }
  if (!hasExplicitConfigurationValue(deniedInspection) && derived.deniedRoots.length) {
    await config.update("remote.deniedRoots", derived.deniedRoots, target);
  }
  return derived;
}
