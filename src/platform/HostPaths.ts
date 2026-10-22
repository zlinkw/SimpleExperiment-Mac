import * as path from "node:path";
import * as os from "node:os";
import { applicationDataRoot } from "../mac/MacPaths";

/** OS locations only. No task, scheduling, ownership or cleanup policy here. */
export { applicationDataRoot };
export function componentDirectory(component: "experiment" | "sftp" | "shared"): string {
  const names = { experiment: "SimpleExperimentMac", sftp: "SimpleSFTPMac", shared: "SimpleLocalMac" };
  return path.join(applicationDataRoot(), names[component]);
}
export function codeUserDirectory(): string { return path.join(applicationDataRoot(), "Code", "User"); }
export function localHome(): string { return os.homedir(); }
export function sameNativePath(left: string, right: string): boolean { return path.resolve(left) === path.resolve(right); }
/** The separately identified Mac extension must never adopt Windows/ZLK sessions. */
export const adoptLegacyWindowsExtensionState = false;
