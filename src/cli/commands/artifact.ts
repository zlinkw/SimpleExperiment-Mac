import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { hasApiDiscovery, optionalApi, tunnelEndpointFromConfig } from "../api";
import { copyFile, fileExists, listFilesRecursive, projectRoot, readJsonFile, resolveProjectPath } from "../data";
import { businessError, envError, usageError } from "../errors";
import { table, writeJson, writeText } from "../format";
import { CliFlags, requirePositional } from "../parse";
import { loadExperiments } from "./experiment";
import { FileTransferClient } from "../../tunnel/FileTransferClient";
import { RequestBudget } from "../../tunnel/RequestBudget";
import { isSafeRemotePath } from "../../tunnel/FileTransferTypes";

export async function artifactCommand(action: string, rest: string[], flags: CliFlags): Promise<number> {
  if (action === "list") return artifactList(requirePositional(rest, 0, "experiment id"), flags);
  if (action === "download") return artifactDownload(requirePositional(rest, 0, "artifact id"), flags);
  if (action === "inspect") return artifactInspect(requirePositional(rest, 0, "artifact id"), flags);
  throw usageError(`unknown artifact action: ${action || "(missing)"}`);
}

export async function artifactList(experimentId: string, flags: CliFlags): Promise<number> {
  const rows = (await listArtifacts(experimentId)).map(({ local: _local, ...row }) => row);
  if (flags.json) {
    writeJson(rows, flags.compactJson);
    return 0;
  }
  writeText(table(["id", "path", "size"], rows));
  return 0;
}

export async function artifactDownload(id: string, flags: CliFlags): Promise<number> {
  const artifacts = await findArtifact(id);
  if (!artifacts) throw businessError(`artifact not found: ${id}`);
  const dest = path.resolve(flags.out || path.join(projectRoot(), "experiments", "downloads", path.basename(artifacts.path)));
  if (artifacts.local && fileExists(artifacts.local)) {
    copyFile(artifacts.local, dest);
    const payload = { id, path: dest, source: "local" };
    if (flags.json) writeJson(payload, flags.compactJson);
    else writeText(`downloaded ${id} -> ${dest}`);
    return 0;
  }
  if (!hasApiDiscovery()) throw envError("artifact download requires Local API / tunnel. Open VS Code or copy a local artifact.");
  const config = await optionalApi("config.list");
  const endpoint = tunnelEndpointFromConfig(asRecord(asRecord(config).tunnel || asRecord(config).hub || config));
  if (!endpoint) throw envError("tunnel endpoint missing from config.list; cannot download remotely.");
  if (!isSafeRemotePath(artifacts.path)) throw businessError(`unsafe remote path: ${artifacts.path}`);
  const client = new FileTransferClient({ localHost: endpoint.localHost, localPort: endpoint.localPort }, new RequestBudget({
    maxRequestsPerMinute: 60,
    maxConcurrentRequests: 1,
    pauseWhenHidden: false,
    allowManualOverride: true,
    minIntervalByPurpose: { file_transfer: 0 },
  }));
  const task = await client.download(artifacts.path, dest);
  const payload = { id, path: dest, transferId: task.transferId, status: task.status, source: "tunnel" };
  if (flags.json) writeJson(payload, flags.compactJson);
  else writeText(`downloaded ${id} -> ${dest}`);
  return 0;
}

export async function artifactInspect(id: string, flags: CliFlags): Promise<number> {
  const artifact = await findArtifact(id);
  if (!artifact) throw businessError(`artifact not found: ${id}`);
  const local = artifact.local && fileExists(artifact.local) ? artifact.local : "";
  const stat = local ? fs.statSync(local) : null;
  const payload = {
    id,
    file: artifact.path,
    size: stat ? stat.size : (artifact.size || ""),
    mtime: stat ? stat.mtime.toISOString() : "",
    hash: local ? crypto.createHash("sha256").update(fs.readFileSync(local)).digest("hex") : "",
  };
  if (flags.json) writeJson(payload, flags.compactJson);
  else writeText(`${payload.file} size=${payload.size} mtime=${payload.mtime} hash=${payload.hash}`);
  return 0;
}

async function listArtifacts(experimentId: string): Promise<Array<{ id: string; path: string; size: string; local?: string }>> {
  const experiment = (await loadExperiments()).find((row) => row.id === experimentId || row.name === experimentId);
  const outputDir = experiment?.raw ? String(experiment.raw.hub_job_dir || experiment.raw.outputDir || experiment.raw.runDir || runDirFromLog(experiment.raw.stdout) || "") : "";
  const rows: Array<{ id: string; path: string; size: string; local?: string }> = [];
  if (outputDir) {
    const abs = path.isAbsolute(outputDir) ? outputDir : resolveProjectPath(outputDir);
    if (fileExists(abs)) {
      const manifest = readJsonFile<{ files?: Array<{ path?: string; size?: number }> }>(path.join(abs, "artifact_manifest.json"), {});
      const files = Array.isArray(manifest.files) && manifest.files.length
        ? manifest.files.map((file) => ({ path: path.join(abs, String(file.path || "")), size: file.size }))
        : listFilesRecursive(abs, () => true, 2).map((file) => ({ path: file, size: fs.statSync(file).size }));
      for (const file of files) {
        rows.push({
          id: `${experimentId}:${path.basename(file.path)}`,
          path: path.relative(projectRoot(), file.path).replace(/\\/g, "/") || file.path,
          size: String(file.size ?? ""),
          local: file.path,
        });
      }
    }
  }
  const remote = await optionalApi("results.list", { planFile: experimentId });
  const results = Array.isArray((remote as { results?: unknown[] })?.results) ? (remote as { results: Array<Record<string, unknown>> }).results : [];
  for (const result of results) {
    const files = Array.isArray(result.sourceFiles) ? result.sourceFiles as Array<Record<string, unknown>> : [];
    for (const file of files) {
      const filePath = String(file.path || "");
      if (!filePath) continue;
      rows.push({ id: `${String(result.resultId || experimentId)}:${path.basename(filePath)}`, path: filePath, size: String(file.size || "") });
    }
  }
  return rows;
}

async function findArtifact(id: string): Promise<{ path: string; size?: string; local?: string } | null> {
  const [experimentId, ...rest] = id.split(":");
  const name = rest.join(":") || experimentId;
  const listed = await listArtifacts(experimentId);
  const match = listed.find((row) => row.id === id || row.path.endsWith(name) || path.basename(row.path) === id);
  if (match) {
    const abs = match.local || (path.isAbsolute(match.path) ? match.path : resolveProjectPath(match.path));
    const local = fileExists(abs) ? abs : undefined;
    return { path: match.path, size: local ? String(fs.statSync(local).size) : match.size, local };
  }
  const abs = path.isAbsolute(id) ? id : resolveProjectPath(id);
  if (fileExists(abs)) return { path: id, size: String(fs.statSync(abs).size), local: abs };
  return null;
}

function runDirFromLog(value: unknown): string {
  const text = String(value || "").replace(/\\/g, "/");
  const match = text.match(/^(.*)\/(?:stdout|stderr)\.log$/);
  return match ? match[1] : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
