import { createHash } from "node:crypto";

export function jobEvidenceName(job: { lifecycleProtocol?: number }) {
  return job.lifecycleProtocol === 2 ? "artifact_manifest.json" : "formal_job_owner.json";
}
/** Validate a small final output. No status cache, owner snapshot, or scientific verdict. */
export function verifyNativeResult(text: string, sha256: string, job: {
  commandId: string; index: number; case: string; seed: number; outputDir: string; collectionResultCsv?: string;
}, mode?: string, allowFailedExecution = false) {
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024 || createHash("sha256").update(text, "utf8").digest("hex") !== sha256.toLowerCase())
    throw new Error("FINAL_MANIFEST_SHA256_CHANGED");
  const report = JSON.parse(text).simpleExperiment;
  if (!report || report.runId !== job.commandId || !(report.status === "completed" || allowFailedExecution && report.status === "failed") || report.outputDir !== job.outputDir
    || report.job?.index !== job.index || report.job?.case !== job.case || report.job?.seed !== job.seed
    || !["train", "test", "train_test"].includes(report.mode) || mode && report.mode !== mode
    || report.mode !== "train" && report.resultCsv !== job.collectionResultCsv)
    throw new Error("FINAL_MANIFEST_JOB_MISMATCH");
  if (!Array.isArray(report.weights) || report.mode !== "test" && !report.weights.length
    || report.weights.some((file: unknown) => typeof file !== "string" || !file.startsWith(job.outputDir + "/")
      || file.split("/").some(part => !part || part === "." || part === "..") || /[:\\\x00-\x1f]/.test(file)))
    throw new Error("FINAL_MANIFEST_WEIGHT_PATH_INVALID");
  return report;
}
