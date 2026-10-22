import { parentPort } from "worker_threads";
import { latestResultCatalog } from "./LatestResultExport";

type CatalogRequest = { id: number; root: string; resultDir: string; mappings: Record<string, any> };

parentPort?.on("message", async (request: CatalogRequest) => {
  try {
    const catalog = await latestResultCatalog(request.root, request.resultDir);
    parentPort?.postMessage({ id: request.id, catalog });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
