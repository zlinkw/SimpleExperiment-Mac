import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export type PanelBuildFileStats = { size: number; mtimeMs: number } | null;
export type PanelBuildManifestFile = { path: string; sha256: string };
export type PanelBuildIdentity = {
  version: string;
  buildId: string;
  manifestHash: string;
  fingerprint: string;
  files: Record<string, string>;
  stats: { package: PanelBuildFileStats; manifest: PanelBuildFileStats };
  exists: boolean;
};
export type PanelBuildRegistryState = "match" | "version_mismatch" | "content_mismatch" | "unknown" | "extension_missing";

export const PANEL_BUILD_MANIFEST_PATH = "dist/panel-build-manifest.json";
export const REQUIRED_PANEL_BUILD_FILES = Object.freeze([
  "dist/extension.js",
  "dist/extension/legacy.js",
  "dist/ui/PanelHtml.js",
  "dist/ui/PanelHtml.legacy.js",
  "dist/ui/PanelRecoveryHtml.js",
  "dist/features/PanelBuildIdentity.js",
  "dist/features/PanelLifecycle.js",
  "dist/features/PanelStateDelivery.js",
  "dist/features/PanelStateProgress.js",
]);

type PanelBuildFs = Pick<typeof fs, "statSync" | "readFileSync">;
type PanelBuildManifest = { schemaVersion?: unknown; version?: unknown; buildId?: unknown; files?: unknown };

function statFile(file: string, fsApi: PanelBuildFs): PanelBuildFileStats {
  try {
    const stat = fsApi.statSync(file);
    return { size: Number(stat.size), mtimeMs: Number(stat.mtimeMs) };
  } catch {
    return null;
  }
}

function digest(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function normalizeManifestFiles(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: Record<string, string> = {};
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, unknown>;
    const file = String(row.path || "").replaceAll("\\", "/");
    const hash = String(row.sha256 || "").toLowerCase();
    if (!file || file.startsWith("/") || file.split("/").includes("..") || !/^[a-f0-9]{64}$/.test(hash)) return undefined;
    files[file] = hash;
  }
  return REQUIRED_PANEL_BUILD_FILES.every((file) => Boolean(files[file])) ? files : undefined;
}

/** Reads the generated runtime closure manifest from disk on each identity probe. */
export function readPanelBuildIdentity(extensionPath: string, previous?: PanelBuildIdentity, versionHint = "", fsApi: PanelBuildFs = fs): PanelBuildIdentity {
  const packagePath = path.join(extensionPath, "package.json");
  const manifestPath = path.join(extensionPath, PANEL_BUILD_MANIFEST_PATH);
  const packageStats = statFile(packagePath, fsApi);
  const manifestStats = statFile(manifestPath, fsApi);
  let packageVersion = String(versionHint || "");
  if (!packageVersion) {
    try { packageVersion = String(JSON.parse(fsApi.readFileSync(packagePath, "utf8")).version || ""); } catch {}
  }
  let manifestVersion = "";
  let buildId = "";
  let manifestHash = "";
  let files: Record<string, string> = {};
  let manifestValid = false;
  try {
    const raw = fsApi.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as PanelBuildManifest;
    const normalizedFiles = normalizeManifestFiles(manifest.files);
    if (Number(manifest.schemaVersion) === 1 && normalizedFiles && /^[a-f0-9]{64}$/i.test(String(manifest.buildId || ""))) {
      manifestVersion = String(manifest.version || "");
      buildId = String(manifest.buildId || "").toLowerCase();
      manifestHash = digest(raw);
      files = normalizedFiles;
      manifestValid = Boolean(manifestVersion && (packageVersion === manifestVersion));
    }
  } catch {
    // Incomplete installs remain visible as unknown or content_mismatch instead of throwing during activation.
  }
  const version = packageVersion || manifestVersion;
  return {
    version,
    buildId,
    manifestHash,
    fingerprint: manifestHash,
    files,
    stats: { package: packageStats, manifest: manifestStats },
    exists: Boolean(packageStats && manifestStats && manifestValid),
  };
}

export function freezePanelBuildIdentity(identity: PanelBuildIdentity): PanelBuildIdentity {
  Object.freeze(identity.files);
  Object.freeze(identity.stats);
  return Object.freeze(identity);
}

export function classifyPanelBuildIdentity(input: {
  running: PanelBuildIdentity;
  disk: PanelBuildIdentity;
  installedVersion?: string;
  registryAvailable: boolean;
  missingConfirmed?: boolean;
}): {
  registryState: PanelBuildRegistryState;
  reloadRequired: boolean;
  runningVersion: string;
  installedVersion: string;
  runningBuildId: string;
  diskBuildId: string;
  runningManifestHash: string;
  diskManifestHash: string;
  runningFingerprint: string;
  diskFingerprint: string;
} {
  const runningVersion = String(input.running.version || "");
  const installedVersion = String(input.registryAvailable ? input.installedVersion || "" : "");
  let registryState: PanelBuildRegistryState = "unknown";
  if (input.registryAvailable) {
    if (runningVersion !== installedVersion) registryState = "version_mismatch";
    else if (!input.disk.exists || !input.running.buildId || input.running.buildId !== input.disk.buildId) registryState = "content_mismatch";
    else registryState = "match";
  } else if (input.missingConfirmed && !input.disk.exists) {
    registryState = "extension_missing";
  }
  return {
    registryState,
    reloadRequired: registryState === "version_mismatch" || registryState === "content_mismatch" || registryState === "extension_missing",
    runningVersion,
    installedVersion,
    runningBuildId: input.running.buildId,
    diskBuildId: input.disk.buildId,
    runningManifestHash: input.running.manifestHash,
    diskManifestHash: input.disk.manifestHash,
    runningFingerprint: input.running.fingerprint,
    diskFingerprint: input.disk.fingerprint,
  };
}

export async function stablePanelExtensionProbe<T>(options: {
  getExtension: () => T | undefined;
  delay: (milliseconds: number) => Promise<void>;
  readDiskIdentity: () => PanelBuildIdentity;
  debounceMs?: number;
}): Promise<{ extension?: T; missingConfirmed: boolean; diskIdentity: PanelBuildIdentity }> {
  const first = options.getExtension();
  if (first) return { extension: first, missingConfirmed: false, diskIdentity: options.readDiskIdentity() };
  await options.delay(Math.max(0, Number(options.debounceMs ?? 350)));
  const second = options.getExtension();
  const diskIdentity = options.readDiskIdentity();
  return { extension: second, missingConfirmed: !second && !diskIdentity.exists, diskIdentity };
}
