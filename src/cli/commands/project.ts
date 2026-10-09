import * as path from "path";
import { discoveryOrNull, optionalApi } from "../api";
import { DEFAULT_PLAN_DIR, EXPERIMENT_INDEX_REL, fileExists, packageMeta, projectRoot, resolveProjectPath } from "../data";
import { nestedBlock, writeJson, writeText } from "../format";
import { CliFlags } from "../parse";

export async function projectStatus(flags: CliFlags): Promise<number> {
  const pkg = packageMeta();
  const root = projectRoot();
  const discovery = discoveryOrNull();
  const apiReady = Boolean(discovery);
  let cluster: Record<string, unknown> | null = null;
  if (apiReady) cluster = (await optionalApi("status")) as Record<string, unknown> | null;
  const experimentIndex = fileExists(resolveProjectPath(EXPERIMENT_INDEX_REL));
  const planDir = fileExists(resolveProjectPath(DEFAULT_PLAN_DIR));
  const ready = experimentIndex || planDir || apiReady;
  const payload = {
    name: path.basename(root) || pkg.name,
    root,
    version: String((cluster && cluster.version) || pkg.version || ""),
    services: {
      experiment: experimentIndex || planDir ? "ready" : "offline",
      cluster: cluster ? "ready" : (apiReady ? "unknown" : "offline"),
      api: apiReady ? String((discovery as Record<string, unknown>).baseUrl || "ready") : "offline",
    },
    status: ready ? "ready" : "offline",
    api: cluster || null,
  };
  if (flags.json) {
    writeJson(payload, flags.compactJson);
    return 0;
  }
  writeText(nestedBlock({
    Project: { name: payload.name, root: payload.root, version: payload.version },
    Services: payload.services,
    Status: payload.status,
  }));
  return 0;
}
