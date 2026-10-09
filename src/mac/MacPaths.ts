import * as path from "node:path";
import * as os from "node:os";

export function applicationDataRoot(platform = process.platform, home = os.homedir(), env = process.env): string {
  return platform === "darwin" ? path.join(home, "Library", "Application Support")
    : env.APPDATA || path.join(home, "AppData", "Roaming");
}
export function macComponentDirectory(component: string, platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv): string {
  if (!["SimpleExperimentMac", "SimpleSFTPMac", "SimpleLocalMac"].includes(component)) throw new Error("Unknown Mac component");
  return path.join(applicationDataRoot(platform, home, env), component);
}
