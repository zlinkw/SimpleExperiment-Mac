import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

type Report = { ok: boolean; error?: string; tail?: string; reused?: boolean };
const cache = new Map<string, { identity: string; sha256: string; report: Report }>();
const pending = new Map<string, Promise<Report>>();

/** Static Windows entry probe. No imports, interpreter launch or environment management. */
export async function staticEntrypointProbe(root: string, template: string): Promise<Report> {
  const command = String(template || "").trim();
  if (!command) return { ok: false, error: "指令为空" };
  const match = command.match(/(?:^|\s)python(?:\d+(?:\.\d+)?)?\s+(?:(?:-u|-B|-E|-I|-s|-S)\s+)*(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const script = match?.[1] || match?.[2] || match?.[3] || "";
  if (!script || script.startsWith("-")) return { ok: true };
  const canonical = await fs.realpath(root), file = path.resolve(canonical, script);
  const relative = path.relative(canonical, file);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    return { ok: false, error: "入口文件不在当前项目内" };
  const key = JSON.stringify([canonical, file, command]);
  if (pending.has(key)) return { ...await pending.get(key)! };
  const work = (async (): Promise<Report> => {
    let before;
    try { before = await fs.stat(file, { bigint: true }); }
    catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      return { ok: false, error: `入口文件不存在: ${script}`, tail: `${script} not found` };
    }
    if (!before.isFile()) return { ok: false, error: `入口不是文件: ${script}` };
    const realFile = await fs.realpath(file), realRelative = path.relative(canonical, realFile);
    if (realRelative === ".." || realRelative.startsWith(".." + path.sep) || path.isAbsolute(realRelative))
      return { ok: false, error: "入口文件的实际路径不在当前项目内" };
    const identity = [realFile, before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(":");
    const saved = cache.get(key);
    if (saved?.identity === identity) return { ...saved.report, reused: true };
    const content = await fs.readFile(file, "utf8"), after = await fs.stat(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("入口文件在检查期间变化，请重试");
    let report: Report = { ok: true };
    if (/argparse/.test(content)) {
      if (/--config/.test(content) && !command.includes("{config}"))
        report = { ok: false, error: `参数不匹配: ${script} 需要 --config 但模板缺少 {config}`, tail: content.slice(-800) };
      else if (/output_dir|output-dir/.test(content) && !command.includes("{output_dir}"))
        report = { ok: false, error: `参数不匹配: ${script} 需要 --output_dir 但模板缺少 {output_dir}`, tail: content.slice(-800) };
    }
    // The entry bytes and file identity belong to this snapshot; execution still verifies its code proof.
    const sha256 = createHash("sha256").update(content).digest("hex");
    cache.delete(key); cache.set(key, { identity, sha256, report });
    while (cache.size > 128) cache.delete(cache.keys().next().value!);
    return { ...report, reused: false };
  })();
  pending.set(key, work);
  try { return { ...await work }; } finally { if (pending.get(key) === work) pending.delete(key); }
}
