import { execFile } from "node:child_process";

/** Run outside Extension Host: scanning a project must not block render ACKs or heartbeats. */
export function runProjectStaticCheck(script: string, root: string, signal?: AbortSignal): Promise<{ overall: string; plans: number }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, "--project", root, "--json", "--write-md"], {
      cwd: root, encoding: "utf8", windowsHide: true, shell: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal,
    }, (error, stdout, stderr) => {
      // Exit 1 is a completed check with findings, not a process failure.
      if (error && (error.killed || error.code !== 1)) {
        reject(new Error(`项目检查未完成：${error.message.slice(0, 600)}`));
        return;
      }
      try {
        const report = JSON.parse(stdout);
        if (report.reportWritten !== true || !["passed", "failed"].includes(report.overall)) {
          throw new Error("检查未生成有效的新报告；旧报告已保留");
        }
        resolve({ overall: report.overall, plans: Number(report.summary?.plans) || 0 });
      } catch (failure) {
        reject(new Error(`项目检查报告无效：${String(failure).slice(0, 300)}。${String(stderr).slice(-300)}`));
      }
    });
  });
}
