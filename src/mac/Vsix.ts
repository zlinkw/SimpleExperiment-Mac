/** Compatibility schema for the Mac distribution manifest, using the shared verifier. */
export { crc32 } from "../updates/VerifiedPackage";
import { verifyVsix as verifyShared, inspectVsix as inspectShared, readVsix as readShared } from "../updates/VerifiedPackage";
export function readVsix(bytes: Uint8Array) { return readShared(bytes, true); }
export interface ReleaseComponent {
  extensionId: string; version: string; sourceCommit: string; targetPlatform: "darwin-arm64";
  vscodeEngine: string; downloadUrl: string; size: number; sha256: string;
}
export function inspectVsix(bytes: Uint8Array) { return { ...inspectShared(bytes), files: readVsix(bytes) }; }
export function verifyVsix(bytes: Uint8Array, c: ReleaseComponent, vscodeVersion?: string) {
  const actual = verifyShared(bytes, { id: c.extensionId, repo: "zlinkw/SimpleExperiment-Mac", label: c.extensionId,
    currentVersion: "0.0.0", latestVersion: c.version, targetPlatform: c.targetPlatform, updateAvailable: false, releaseUrl: "",
    vsix: { name: c.downloadUrl.split("/").at(-1)!, url: c.downloadUrl, size: c.size, digest: "sha256:" + c.sha256, targetPlatform: c.targetPlatform } }, vscodeVersion, "darwin-arm64");
  if (c.targetPlatform !== "darwin-arm64" || actual.vscodeEngine !== c.vscodeEngine) throw new Error("VSIX 平台或清单兼容要求不符");
  return { ...actual, files: readVsix(bytes) };
}
