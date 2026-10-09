import { parentPort } from "worker_threads";
import * as ProjectResultTables from "./ProjectResultTables";

type CatalogRequest = { id: number; root: string; resultDir: string; mappings: Record<string, any> };

parentPort?.on("message", (request: CatalogRequest) => {
  try {
    const catalog = ProjectResultTables.resultCatalog(request.root, request.resultDir, request.mappings || {});
    parentPort?.postMessage({ id: request.id, catalog });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
